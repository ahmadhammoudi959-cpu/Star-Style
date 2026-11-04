import "server-only";
/**
 * „System zurücksetzen“ = Start des Echtbetriebs (Wunsch Inhaber 30.10.2026, geändert 04.11.2026): löscht alle Bewegungen
 * und Vorgänge, ALLE Artikel bleiben. Was genau gelöscht wird und was bleibt: siehe test-reset-sql.ts.
 * Einmalig: danach steht company_settings.live_since („Echtbetrieb seit …“) und der Knopf verschwindet für immer – ebenso nach
 * einem abgeschlossenen Monat oder einer Monatsmappe. Solange ein Shop-Abgleich läuft, gesperrt (der Shop würde sonst
 * Bestellungen schicken und Bestände holen, während wir löschen). Der Vorher-Stand (Belegnummern, Namen, Zahlen) bleibt im audit_log.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { audit } from "./stock";
import { fingerprint, isEmpty, PREVIEW_SQL, RESET_LOCK, RESET_STATEMENTS, STATUS_SQL, toPreview, type ResetPreview } from "./test-reset-sql";

export type { ResetPreview };
export type ResetBlock = "live" | "syncOn" | null;

export class ResetError extends Error {
  constructor(public code: "resetLive" | "resetSyncOn" | "resetChanged") { super(code); }
}

type StatusRow = { live: boolean; sync_on: boolean; live_since: string | Date | null };

async function status(tx: Tx | typeof db): Promise<{ block: ResetBlock; liveSince: Date | null }> {
  const s = (await tx.execute<StatusRow>(sql.raw(STATUS_SQL))).rows[0];
  const liveSince = s?.live_since ? new Date(s.live_since) : null;
  return { block: s?.live ? "live" : s?.sync_on ? "syncOn" : null, liveSince };
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
export async function resetStatus(): Promise<{ block: ResetBlock; liveSince: Date | null; preview: ResetPreview; empty: boolean; fingerprint: string }> {
  return db.transaction(async (tx) => {
    const { block, liveSince } = await status(tx);
    if (block === "live") return { block, liveSince, preview: toPreview({}), empty: true, fingerprint: "" }; // Echtbetrieb: nichts anzeigen
    const p = await preview(tx);
    return { block, liveSince, preview: p, empty: isEmpty(p), fingerprint: fingerprint(p) };
  });
}

/** Setzt das System zurück und startet den Echtbetrieb. `expect` = Fingerabdruck der Vorschau, die der Nutzer bestätigt hat. */
export async function resetTestData(expect: string, userId?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(RESET_LOCK));
    const { block } = await status(tx);
    if (block === "live") throw new ResetError("resetLive");
    if (block === "syncOn") throw new ResetError("resetSyncOn");
    const before = await preview(tx);
    if (fingerprint(before) !== expect) throw new ResetError("resetChanged");
    for (const s of RESET_STATEMENTS) await tx.execute(sql.raw(s));
    await audit(tx, { entity: "system", entityId: "go-live", action: "reset", before, after: { liveSince: new Date().toISOString() }, userId });
    return before;
  });
}
