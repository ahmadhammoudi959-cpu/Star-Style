import { describe, expect, it } from "vitest";
import { fingerprint, isEmpty, toPreview } from "../src/lib/test-reset-sql";

// ───────────── Testdaten löschen: Vorschau (rein) ─────────────
describe("Testdaten löschen – Vorschau", () => {
  const row = {
    invoices: 3, cancellations: 2, drafts: 0, offers: 2, payments: 1, receipts: 2, write_offs: 0, expenses: 0, customers: 3, units: 199, stocked: 2,
    customer_names: ["Ahmad", "Fedaa", "محمد"], products: '["كرسي الماني","كريم الماني"]', suppliers: ["Fedaa"], numbers: ["RE-2026-0001"],
  };

  it("liest Zahlen und Namen (JSON als Feld oder Text)", () => {
    const p = toPreview(row);
    expect(p.invoices).toBe(3);
    expect(p.writeOffs).toBe(0);
    expect(p.products).toEqual(["كرسي الماني", "كريم الماني"]);
    expect(p.customerNames).toEqual(["Ahmad", "Fedaa", "محمد"]);
    expect(isEmpty(p)).toBe(false);
  });

  it("Fingerabdruck ändert sich, sobald etwas dazukommt", () => {
    const a = toPreview(row);
    const b = toPreview({ ...row, payments: 2 });
    expect(fingerprint(a)).toBe(fingerprint(toPreview(row)));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("leer = nichts zu löschen", () => {
    expect(isEmpty(toPreview({}))).toBe(true);
    expect(isEmpty(toPreview({ stocked: 1 }))).toBe(false);
  });
});

// ───────────── Testdaten löschen – LÖSCHT ALLE BELEGE DER DATENBANK, darum nur mit RESET_TEST_DB=1 ─────────────
const run = process.env.DATABASE_URL && process.env.RESET_TEST_DB === "1" ? describe : describe.skip;
run("Testdaten löschen (Datenbank)", async () => {
  const { db, schema } = await import("../src/db");
  const { eq, inArray } = await import("drizzle-orm");
  const { receiveGoods } = await import("../src/lib/stock");
  const { nextNumber } = await import("../src/lib/numbering");
  const { resetStatus, resetTestData, ResetError } = await import("../src/lib/test-reset");
  const tag = String(Date.now()).slice(-8);

  async function product(sku: string, linked: boolean) {
    const [p] = await db.insert(schema.products).values({ sku, nameDe: `Reset ${sku}` }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id, barcode: `47${tag}${sku.slice(-2)}` }).returning();
    if (linked) await db.insert(schema.shopVariants).values({ channel: "GENERAL_SHOP", shopVariantId: `gid://reset/${tag}/${sku}`, variantId: v.id, matchedBy: "import" });
    return { p, v };
  }

  it("löscht Belege, Kunden und Testartikel; Shop-Artikel bleiben mit Bestand 0, Nummern beginnen neu", async () => {
    await db.update(schema.shops).set({ active: false });
    const test = await product(`RS-${tag}-01`, false);
    const shop = await product(`RS-${tag}-02`, true);
    const [sup] = await db.insert(schema.suppliers).values({ name: `Test-Lieferant ${tag}` }).returning();
    await receiveGoods({ supplierId: sup.id, date: "2026-10-30", lines: [{ variantId: test.v.id, qty: 5, unitCostCents: 100 }, { variantId: shop.v.id, qty: 3, unitCostCents: 200 }] });
    await db.insert(schema.customers).values({ name: `Kunde ${tag}` });

    const before = await resetStatus();
    expect(before.block).toBe(null);
    expect(before.preview.products).toContain(`Reset RS-${tag}-01`);
    expect(before.preview.products).not.toContain(`Reset RS-${tag}-02`);
    expect(before.preview.suppliers).toContain(`Test-Lieferant ${tag}`);

    await expect(resetTestData("falsch", "u-test")).rejects.toBeInstanceOf(ResetError); // Vorschau veraltet
    await resetTestData(before.fingerprint, "u-test");

    expect(await db.query.products.findFirst({ where: eq(schema.products.id, test.p.id) })).toBe(undefined);
    const kept = await db.query.variants.findFirst({ where: eq(schema.variants.id, shop.v.id) });
    expect(kept?.stockQty).toBe(0);
    expect((await db.select().from(schema.shopVariants).where(eq(schema.shopVariants.variantId, shop.v.id))).length).toBe(1);
    expect((await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, sup.id))).length).toBe(0);
    expect((await db.select().from(schema.customers)).length).toBe(0);
    expect((await db.select().from(schema.goodsReceipts)).length).toBe(0);
    expect((await db.select().from(schema.stockMovements).where(inArray(schema.stockMovements.variantId, [shop.v.id]))).length).toBe(0);
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
