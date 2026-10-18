/**
 * Integrationstest gegen eine echte PostgreSQL-Datenbank (DATABASE_URL).
 * Prüft FEFO-Abgang, Durchschnitts-EK, Bestandsschutz und lückenlose Nummern.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import { adjustStock, bookWriteOff, receiveGoods, StockError } from "../src/lib/stock";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Lagerlogik", () => {
  let variantId = "";
  beforeAll(async () => {
    const sku = "TEST-" + crypto.randomUUID().slice(0, 8);
    const [p] = await db.insert(schema.products).values({ sku, nameDe: "Testartikel", tracksExpiry: true }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id }).returning();
    variantId = v.id;
  });

  it("verlangt Haltbarkeitsdatum, wenn der Artikel eins hat", async () => {
    await expect(receiveGoods({ date: "2026-10-01", lines: [{ variantId, qty: 5, unitCostCents: 100 }] }))
      .rejects.toMatchObject({ code: "EXPIRY_REQUIRED" });
  });

  it("rechnet den gleitenden Durchschnitts-EK", async () => {
    await receiveGoods({ date: "2026-10-01", lines: [{ variantId, qty: 40, unitCostCents: 320, expiryDate: "2026-11-20" }] });
    await receiveGoods({ date: "2026-10-02", lines: [{ variantId, qty: 60, unitCostCents: 360, expiryDate: "2027-06-30" }] });
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) });
    expect(v!.stockQty).toBe(100);
    expect(v!.avgCostCents).toBe(344);
  });

  it("bucht Verluste nach FEFO (zuerst ablaufende Charge)", async () => {
    await bookWriteOff({ date: "2026-10-03", reason: "EXPIRED", lines: [{ variantId, qty: 45 }] });
    const bs = await db.select().from(schema.batches).where(eq(schema.batches.variantId, variantId)).orderBy(schema.batches.expiryDate);
    expect(bs.map((b) => b.qtyLeft)).toEqual([0, 55]);
    const lines = await db.select().from(schema.writeOffLines).where(eq(schema.writeOffLines.variantId, variantId));
    expect(lines.reduce((s, l) => s + l.qty * l.unitCostCents, 0)).toBe(40 * 320 + 5 * 360);
  });

  it("verhindert Abgang über den Bestand hinaus", async () => {
    await expect(bookWriteOff({ date: "2026-10-03", reason: "LOSS", lines: [{ variantId, qty: 999 }] })).rejects.toBeInstanceOf(StockError);
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) });
    expect(v!.stockQty).toBe(55); // nichts halb gebucht
  });

  it("Inventur setzt den Bestand und der Cache stimmt mit den Bewegungen überein", async () => {
    await adjustStock(variantId, 50, "Test");
    const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, variantId) });
    const moves = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.variantId, variantId));
    expect(v!.stockQty).toBe(50);
    expect(moves.reduce((s, m) => s + m.qty, 0)).toBe(50);
  });

  it("vergibt bei gleichzeitigen Buchungen lückenlose, eindeutige Nummern", async () => {
    const res = await Promise.all(Array.from({ length: 8 }, () =>
      receiveGoods({ date: "2030-01-01", lines: [{ variantId, qty: 1, unitCostCents: 100, expiryDate: "2031-01-01" }] })));
    const nums = res.map((r) => Number(r.number.split("-")[2])).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(8);
    expect(nums[7] - nums[0]).toBe(7);
  });
});
