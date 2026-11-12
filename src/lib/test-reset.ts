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
import { fingerprint, GO_LIVE_SQL, isEmpty, PREVIEW_SQL, RESET_LOCK, RESET_STATEMENTS, STATUS_SQL, toPreview, type ResetPreview } from "./test-reset-sql";

export type { ResetPreview };
export type ResetBlock = "live" | "syncOn" | null;

export class ResetError extends Error {
  constructor(public code: "resetLive" | "resetSyncOn" | "resetChanged") { super(code); }
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
