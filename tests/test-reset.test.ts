import { describe, expect, it } from "vitest";
import { fingerprint, isEmpty, toPreview } from "../src/lib/test-reset-sql";

// ───────────── Testdaten löschen: Vorschau (rein) ─────────────
describe("Testdaten löschen – Vorschau", () => {
  const row = {
    invoices: 3, cancellations: 2, drafts: 0, offers: 2, payments: 1, receipts: 2, write_offs: 0, expenses: 0, customers: 3, units: 199, stocked: 2,
    sequences: 5, customer_names: ["Ahmad", "Fedaa", "محمد"], products: '["كرسي الماني","كريم الماني"]', suppliers: ["Fedaa"], numbers: ["RE-2026-0001"],
    digest: "abc",
  };

  it("liest Zahlen und Namen (JSON als Feld oder Text)", () => {
    const p = toPreview(row);
    expect(p.invoices).toBe(3);
    expect(p.writeOffs).toBe(0);
    expect(p.sequences).toBe(5);
    expect(p.products).toEqual(["كرسي الماني", "كريم الماني"]);
    expect(p.customerNames).toEqual(["Ahmad", "Fedaa", "محمد"]);
    expect(isEmpty(p)).toBe(false);
  });

  it("Fingerabdruck ändert sich bei anderer Anzahl und bei anderen Datensätzen gleicher Anzahl", () => {
    const a = toPreview(row);
    expect(fingerprint(a)).toBe(fingerprint(toPreview(row)));
    expect(fingerprint(a)).not.toBe(fingerprint(toPreview({ ...row, payments: 2 })));
    expect(fingerprint(a)).not.toBe(fingerprint(toPreview({ ...row, digest: "abd" }))); // z. B. anderer Lieferant würde gelöscht
  });

  it("leer = nichts zu löschen; übrig gebliebene Nummernkreise zählen mit", () => {
    expect(isEmpty(toPreview({}))).toBe(true);
    expect(isEmpty(toPreview({ stocked: 1 }))).toBe(false);
    expect(isEmpty(toPreview({ sequences: 1 }))).toBe(false);
  });
});

// ───────────── Testdaten löschen (Datenbank) ─────────────
// LÖSCHT ALLE BELEGE UND KUNDEN der Datenbank. Nur mit eigener, frisch migrierter Datenbank und nur diese Datei:
//   RESET_TEST_DB=1 DATABASE_URL=postgres://…/starstyle_reset npx vitest run tests/test-reset.test.ts
// (shopify.test.ts legt Shop-Rechnungen an – danach gilt die Datenbank als „Echtbetrieb“ und Löschen ist gesperrt.)
const run = process.env.DATABASE_URL && process.env.RESET_TEST_DB === "1" ? describe : describe.skip;
run("Testdaten löschen (Datenbank)", async () => {
  const { db, schema } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const { receiveGoods, bookWriteOff } = await import("../src/lib/stock");
  const { nextNumber } = await import("../src/lib/numbering");
  const { resetStatus, resetTestData, ResetError } = await import("../src/lib/test-reset");
  const tag = String(Date.now()).slice(-8);

  async function product(sku: string, o: { linked?: boolean; supplierId?: string } = {}) {
    const [p] = await db.insert(schema.products).values({ sku, nameDe: `Reset ${sku}`, supplierId: o.supplierId ?? null }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id, barcode: `47${tag}${sku.slice(-2)}` }).returning();
    if (o.linked) await db.insert(schema.shopVariants).values({ channel: "GENERAL_SHOP", shopVariantId: `gid://reset/${tag}/${sku}`, variantId: v.id, matchedBy: "import" });
    return { p, v };
  }

  it("löscht Belege, Kunden und Testartikel; Shop-Artikel und Artikel ohne Verkauf bleiben mit Bestand 0, Nummern beginnen neu", async () => {
    await db.update(schema.shops).set({ active: false });
    const [testSup] = await db.insert(schema.suppliers).values({ name: `Test-Lieferant ${tag}` }).returning();
    const [realSup] = await db.insert(schema.suppliers).values({ name: `Echter Lieferant ${tag}` }).returning();
    const test = await product(`RS-${tag}-01`);
    const shop = await product(`RS-${tag}-02`, { linked: true });
    const real = await product(`RS-${tag}-03`, { supplierId: realSup.id }); // nur Anfangsbestand (Wareneingang) → echter Artikel
    await receiveGoods({ supplierId: testSup.id, date: "2026-10-30", lines: [
      { variantId: test.v.id, qty: 5, unitCostCents: 100 }, { variantId: shop.v.id, qty: 3, unitCostCents: 200 }, { variantId: real.v.id, qty: 7, unitCostCents: 300 },
    ] });
    await bookWriteOff({ date: "2026-10-30", reason: "DAMAGE", lines: [{ variantId: test.v.id, qty: 1 }] });
    await db.insert(schema.customers).values({ name: `Kunde ${tag}` });

    const before = await resetStatus();
    expect(before.block).toBe(null);
    expect(before.preview.products).toEqual([`Reset RS-${tag}-01`]);
    expect(before.preview.suppliers).toEqual([`Test-Lieferant ${tag}`]);

    await expect(resetTestData("veraltet", "u-test")).rejects.toBeInstanceOf(ResetError);
    await resetTestData(before.fingerprint, "u-test");

    expect(await db.query.products.findFirst({ where: eq(schema.products.id, test.p.id) })).toBe(undefined);
    for (const k of [shop, real]) expect((await db.query.variants.findFirst({ where: eq(schema.variants.id, k.v.id) }))?.stockQty).toBe(0);
    expect((await db.select().from(schema.shopVariants).where(eq(schema.shopVariants.variantId, shop.v.id))).length).toBe(1);
    expect((await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, testSup.id))).length).toBe(0);
    expect((await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, realSup.id))).length).toBe(1);
    expect((await db.select().from(schema.customers)).length).toBe(0);
    expect((await db.select().from(schema.goodsReceipts)).length).toBe(0);
    expect((await db.select().from(schema.stockMovements)).length).toBe(0);
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "reset"))).length).toBeGreaterThan(0);
    expect(await db.transaction((tx) => nextNumber(tx, "INVOICE", 2026))).toBe("RE-2026-0001");
    const [c] = await db.insert(schema.customers).values({ name: `Erster echter Kunde ${tag}` }).returning();
    expect(c.number).toBe(1);
  });

  it("gesperrt, solange ein Shop-Abgleich läuft", async () => {
    await db.insert(schema.customers).values({ name: `Kunde ${tag} B` });
    await db.insert(schema.shops).values({ channel: "BRAND_SHOP", active: true }).onConflictDoUpdate({ target: schema.shops.channel, set: { active: true } });
    try {
      const s = await resetStatus();
      expect(s.block).toBe("syncOn");
      await expect(resetTestData(s.fingerprint)).rejects.toMatchObject({ code: "resetSyncOn" });
    } finally {
      await db.update(schema.shops).set({ active: false });
    }
  });
});
