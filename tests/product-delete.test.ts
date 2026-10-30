import { describe, expect, it } from "vitest";

// ───────────── Artikel löschen (nur Test-/Fehleinträge) – braucht Datenbank ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Artikel löschen", async () => {
  const { db, schema } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const { receiveGoods, bookWriteOff } = await import("../src/lib/stock");
  const { deleteProduct, productDeletable, ProductDeleteError } = await import("../src/lib/product-delete");
  const tag = String(Date.now()).slice(-8);

  async function product(sku: string, qty: number) {
    const [p] = await db.insert(schema.products).values({ sku, nameDe: `Test ${sku}`, vatRateBp: 1900, purchasePriceCents: 100 }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id, barcode: `43${tag}${sku.slice(-3)}`, color: "rot" }).returning();
    const rec = await receiveGoods({ date: "2026-10-30", lines: [{ variantId: v.id, qty, unitCostCents: 100 }] });
    return { p, v, rec };
  }

  it("löscht Testartikel samt Bestand, Bewegungen und leerem Wareneingang; Protokoll bleibt", async () => {
    const { p, v, rec } = await product(`DEL-${tag}-001`, 99);
    expect(await productDeletable(p.id)).toBe(true);
    const r = await deleteProduct(p.id, "u-test");
    expect(r.removedReceipts).toEqual([rec.number]);
    expect(await db.query.products.findFirst({ where: eq(schema.products.id, p.id) })).toBe(undefined);
    expect((await db.select().from(schema.variants).where(eq(schema.variants.id, v.id))).length).toBe(0);
    expect((await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.variantId, v.id))).length).toBe(0);
    expect((await db.select().from(schema.goodsReceipts).where(eq(schema.goodsReceipts.id, rec.id))).length).toBe(0);
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, p.id));
    expect(log.some((l) => l.action === "delete")).toBe(true);
  });

  it("Artikel mit Verlust (oder Rechnung/Angebot) kann nicht gelöscht werden", async () => {
    const { p, v } = await product(`DEL-${tag}-002`, 5);
    await bookWriteOff({ date: "2026-10-30", reason: "DAMAGE", lines: [{ variantId: v.id, qty: 1 }] });
    expect(await productDeletable(p.id)).toBe(false);
    await expect(deleteProduct(p.id)).rejects.toBeInstanceOf(ProductDeleteError);
    expect(await db.query.products.findFirst({ where: eq(schema.products.id, p.id) })).not.toBe(undefined);
  });
});
