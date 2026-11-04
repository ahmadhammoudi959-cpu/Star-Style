import "server-only";
/**
 * USt-IdNr. eines Kunden prüfen (BZSt qualifiziert, wenn die eigene USt-IdNr. eingetragen ist, plus EU-VIES)
 * und das Ergebnis vollständig speichern (Nachweis für die Betriebsprüfung). Benutzt von der Kundenseite und vom Shop-Import.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";
import { checkBzst, checkVies, type VatCheckResult } from "./vat-check";

export type VatVerdict = { status: "VALID" | "INVALID" | null; ownVatMissing: boolean };

export async function verifyCustomerVat(customerId: string, userId?: string): Promise<VatVerdict> {
  const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
  if (!c || !c.vatId) return { status: null, ownVatMissing: false };
  const company = await db.query.companySettings.findFirst();
  const results: VatCheckResult[] = [];
  if (company?.vatId) results.push(await checkBzst({ ownVatId: company.vatId, vatId: c.vatId, company: c.name, city: c.city, zip: c.zip, street: c.street }));
  results.push(await checkVies(c.vatId));
  const decided = results.find((r) => r.valid !== null);
  const status = decided ? (decided.valid ? "VALID" : "INVALID") : null;
  await db.transaction(async (tx) => {
    for (const r of results) {
      await tx.insert(schema.vatChecks).values({
        customerId: c.id, vatId: c.vatId, source: r.source, valid: r.valid, name: r.name, address: r.address, error: r.error, raw: r.raw ?? null,
      });
    }
    if (status) {
      await tx.update(schema.customers).set({ vatIdStatus: status, vatCheckedAt: new Date() }).where(eq(schema.customers.id, c.id));
      await audit(tx, { entity: "customer", entityId: c.id, action: "vat_check", before: { status: c.vatIdStatus }, after: { status }, userId });
    }
  });
  return { status, ownVatMissing: !company?.vatId };
}
