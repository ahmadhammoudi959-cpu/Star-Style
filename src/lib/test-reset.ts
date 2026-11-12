import "server-only";
/**
 * „Testdaten zurücksetzen“ (Wunsch Inhaber 30.10.2026, geändert 04.11. und 12.11.2026): löscht alle Bewegungen und Vorgänge,
 * ALLE Artikel bleiben. Was genau gelöscht wird und was bleibt: siehe test-reset-sql.ts. Beliebig oft im Testbetrieb
 * („kann ein-, zwei-, dreimal getestet werden“). Den Echtbetrieb startet ein eigener Knopf (startLive): danach steht
 * company_settings.live_since („Echtbetrieb seit …“) und Zurücksetzen ist für immer gesperrt – echte Rechnungen müssen
 * 10 Jahre bleiben und lückenlos nummeriert sein (GoBD, § 147 AO, § 14 UStG). Ebenso gesperrt nach einem abgeschlossenen Monat.
 * Solange ein Shop-Abgleich läuft, gesperrt (der Shop würde sonst Bestellungen schicken und Bestände holen, während wir löschen).
 * Der Vorher-Stand (Belegnummern, Namen, Zahlen) bleibt im audit_log.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { audit } from "./stock";
import {
  fingerprint, GO_LIVE_SQL, isEmpty, PREVIEW_SQL, RESET_LOCK, RESET_STATEMENTS, STATUS_SQL, toPreview, UNDO_LIVE_SQL,
  undoLiveState, undoLiveUntil, type ResetPreview, type UndoLive,
} from "./test-reset-sql";

export type { ResetPreview, UndoLive };
export type ResetBlock = "live" | "syncOn" | null;

export class ResetError extends Error {
  constructor(public code: "resetLive" | "resetSyncOn" | "resetChanged" | "undoNotLive" | "undoLocked" | "undoTooLate") { super(code); }
}

type StatusRow = { live: boolean; sync_on: boolean; sync_shops: string | null; live_since: string | Date | null };

async function status(tx: Tx | typeof db): Promise<{ block: ResetBlock; liveSince: Date | null; syncShops: string[] }> {
  const s = (await tx.execute<StatusRow>(sql.raw(STATUS_SQL))).rows[0];
  const liveSince = s?.live_since ? new Date(s.live_since) : null;
  const syncShops = (s?.sync_shops ?? "").split(",").filter(Boolean); // wo der Abgleich noch läuft (für den Hinweis)
  return { block: s?.live ? "live" : s?.sync_on ? "syncOn" : null, liveSince, syncShops };
}

async function preview(tx: Tx): Promise<ResetPreview> {
  return toPreview((await tx.execute<Record<string, unknown>>(sql.raw(PREVIEW_SQL))).rows[0] ?? {});
}

/** Für die Anzeige „Testbetrieb“ / „Echtbetrieb seit …“ (Seitenleiste, Einstellungen) – nur lesend */
export async function liveStatus(): Promise<{ live: boolean; since: Date | null }> {
  const s = await status(db);
  return { live: s.block === "live", since: s.liveSince };
}

/** Für die Einstellungen: was würde gelöscht, und ist es (noch) erlaubt? (nur lesend) */
export async function resetStatus(): Promise<{ block: ResetBlock; liveSince: Date | null; syncShops: string[]; preview: ResetPreview; empty: boolean; fingerprint: string }> {
  return db.transaction(async (tx) => {
    const { block, liveSince, syncShops } = await status(tx);
    if (block === "live") return { block, liveSince, syncShops, preview: toPreview({}), empty: true, fingerprint: "" }; // Echtbetrieb: nichts anzeigen
    const p = await preview(tx);
    return { block, liveSince, syncShops, preview: p, empty: isEmpty(p), fingerprint: fingerprint(p) };
  });
}

/** Setzt die Testdaten zurück (System bleibt im Testbetrieb). `expect` = Fingerabdruck der Vorschau, die der Nutzer bestätigt hat. */
export async function resetTestData(expect: string, userId?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(RESET_LOCK));
    const { block } = await status(tx);
    if (block === "live") throw new ResetError("resetLive");
    if (block === "syncOn") throw new ResetError("resetSyncOn");
    const before = await preview(tx);
    if (fingerprint(before) !== expect) throw new ResetError("resetChanged");
    for (const s of RESET_STATEMENTS) await tx.execute(sql.raw(s));
    await audit(tx, { entity: "system", entityId: "test-reset", action: "reset", before, after: { at: new Date().toISOString() }, userId });
    return before;
  });
}

export type SinceLive = { invoices: number; payments: number; expenses: number; exports: number };
type UndoInfo = { state: UndoLive; until: Date; since: SinceLive } | null;

/** Für die Karte „Echtbetrieb“: darf er (aus Versehen gestartet) noch zurückgenommen werden, und was ist seitdem entstanden? */
export async function undoLiveInfo(): Promise<UndoInfo> {
  const s = await db.query.companySettings.findFirst();
  if (!s?.liveSince) return null;
  const at = s.liveSince;
  const r = (await db.execute<Record<string, unknown>>(sql`select
      (select count(*) from invoices where number is not null and created_at >= ${at})::int as invoices,
      (select count(*) from payments where created_at >= ${at})::int as payments,
      (select count(*) from expenses where created_at >= ${at})::int as expenses,
      (select count(*) from advisor_exports where created_at >= ${at})::int as exports,
      exists (select 1 from period_locks) as locked`)).rows[0] ?? {};
  return {
    state: undoLiveState(s.liveSince, new Date(), Boolean(r.locked)), until: undoLiveUntil(s.liveSince),
    since: { invoices: Number(r.invoices), payments: Number(r.payments), expenses: Number(r.expenses), exports: Number(r.exports) },
  };
}

/**
 * „Aus Versehen gestartet → zurück in den Testbetrieb“ (Inhaber 12.11.2026): löscht nichts, nur live_since weg.
 * Nur innerhalb von UNDO_LIVE_DAYS Tagen und ohne abgeschlossenen Monat; Vorher-Stand im audit_log.
 */
export async function undoLive(userId?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(RESET_LOCK));
    const s = await tx.query.companySettings.findFirst();
    if (!s?.liveSince) throw new ResetError("undoNotLive");
    const locked = (await tx.execute<{ locked: boolean }>(sql`select exists (select 1 from period_locks) as locked`)).rows[0]?.locked;
    const state = undoLiveState(s.liveSince, new Date(), Boolean(locked));
    if (state === "locked") throw new ResetError("undoLocked");
    if (state === "tooLate") throw new ResetError("undoTooLate");
    await tx.execute(sql.raw(UNDO_LIVE_SQL));
    await audit(tx, { entity: "system", entityId: "go-live", action: "undo-go-live", before: { liveSince: s.liveSince.toISOString() },
      after: { liveSince: null, reason: "versehentlich gestartet" }, userId });
  });
}

/** „Echtbetrieb starten“ – einmalig, löscht nichts. Ab da ist Zurücksetzen gesperrt. */
export async function startLive(userId?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(RESET_LOCK));
    const { block } = await status(tx);
    if (block === "live") throw new ResetError("resetLive");
    await tx.execute(sql.raw(GO_LIVE_SQL));
    await audit(tx, { entity: "system", entityId: "go-live", action: "go-live", before: null, after: { liveSince: new Date().toISOString() }, userId });
  });
}
