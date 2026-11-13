/**
 * Versanddienste lesen und ändern (Datenbank) – Logik rein in src/lib/carriers.ts.
 * Jede Änderung in einer Transaktion mit Zeilensperre und mit Eintrag im audit_log (vorher/nachher).
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "@/lib/stock";
import { applyCarrierOp, carrierStored, parseCarrierSettings, type CarrierOp, type CarrierProblem, type CarrierSettings } from "./carriers";

export async function loadCarrierSettings(): Promise<CarrierSettings> {
  const row = await db.query.companySettings.findFirst({ columns: { carriers: true } });
  return parseCarrierSettings(row?.carriers);
}

export async function changeCarriers(op: CarrierOp, userId?: string): Promise<{ settings: CarrierSettings } | { problem: CarrierProblem }> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; carriers: unknown }>(sql`select id, carriers from company_settings order by id limit 1 for update`);
    const row = rows.rows[0];
    const before = parseCarrierSettings(row?.carriers);
    const r = applyCarrierOp(before, op, () => `c${randomBytes(6).toString("hex")}`);
    if ("problem" in r) return r;
    const stored = carrierStored(r.settings) as Record<string, unknown>;
    if (row) await tx.update(schema.companySettings).set({ carriers: stored }).where(eq(schema.companySettings.id, row.id));
    else await tx.insert(schema.companySettings).values({ id: "company", carriers: stored });
    await audit(tx, { entity: "settings", entityId: "carriers", action: op.op, before: carrierStored(before), after: stored, userId });
    return r;
  });
}

/** Namen, die bei Sendungen schon frei eingetragen wurden (Vorschläge beim Hinzufügen), ohne die eigenen Versanddienste */
export async function usedCarrierNames(s: CarrierSettings, limit = 12): Promise<string[]> {
  const rows = (await db.execute<{ n: string }>(sql`select carrier_name as n from shipments where carrier = 'OTHER' and carrier_name <> '' and carrier_name <> '?'
    group by carrier_name order by max(created_at) desc limit ${limit + s.custom.length}`)).rows;
  const own = new Set(s.custom.map((c) => c.name.toLowerCase()));
  return rows.map((r) => r.n).filter((n) => !own.has(n.toLowerCase())).slice(0, limit);
}
