import "server-only";
/**
 * „Testdaten löschen“ – einmalig vor dem echten Start (Wunsch Inhaber 30.10.2026).
 * Was genau gelöscht wird und was bleibt: siehe test-reset-sql.ts.
 * Nie mehr möglich, sobald der Echtbetrieb begonnen hat (Monat abgeschlossen, Monatsmappe erstellt, Bestellung aus
 * einem Shop übernommen); solange ein Shop-Abgleich läuft, gesperrt (Shop würde sonst Bestellungen schicken, während wir löschen).
 * Der Vorher-Stand (Belegnummern, Namen, Zahlen) bleibt im audit_log.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { audit } from "./stock";
import { fingerprint, isEmpty, PREVIEW_SQL, RESET_LOCK, RESET_STATEMENTS, STATUS_SQL, toPreview, type ResetPreview } from "./test-reset-sql";

export type { ResetPreview };
export type ResetBlock = "live" | "syncOn" | null;

export class ResetError extends Error {
  constructor(public code: "resetLive" | "resetSyncOn" | "resetChanged" | "resetEmpty") { super(code); }
}

async function status(tx: Tx): Promise<ResetBlock> {
  const s = (await tx.execute<{ live: boolean; sync_on: boolean }>(sql.raw(STATUS_SQL))).rows[0];
  return s?.live ? "live" : s?.sync_on ? "syncOn" : null;
}

async function preview(tx: Tx): Promise<ResetPreview> {
  return toPreview((await tx.execute<Record<string, unknown>>(sql.raw(PREVIEW_SQL))).rows[0] ?? {});
}

/** Für die Einstellungen: was würde gelöscht, und ist es (noch) erlaubt? (nur lesend) */
export async function resetStatus(): Promise<{ block: ResetBlock; preview: ResetPreview; empty: boolean; fingerprint: string }> {
  return db.transaction(async (tx) => {
    const block = await status(tx);
    if (block === "live") return { block, preview: toPreview({}), empty: true, fingerprint: "" }; // Echtbetrieb: nichts anzeigen
    const p = await preview(tx);
    return { block, preview: p, empty: isEmpty(p), fingerprint: fingerprint(p) };
  });
}

/** Löscht alle Testdaten. `expect` = Fingerabdruck der Vorschau, die der Nutzer bestätigt hat. */
export async function resetTestData(expect: string, userId?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(RESET_LOCK));
    const block = await status(tx);
    if (block === "live") throw new ResetError("resetLive");
    if (block === "syncOn") throw new ResetError("resetSyncOn");
    const before = await preview(tx);
    if (isEmpty(before)) throw new ResetError("resetEmpty");
    if (fingerprint(before) !== expect) throw new ResetError("resetChanged");
    for (const s of RESET_STATEMENTS) await tx.execute(sql.raw(s));
    await audit(tx, { entity: "system", entityId: "test-data", action: "reset", before, userId });
    return before;
  });
}
