import { describe, expect, it } from "vitest";
import { fingerprint, isEmpty, toPreview } from "../src/lib/test-reset-sql";

// ───────────── System zurücksetzen: Vorschau (rein) ─────────────
describe("System zurücksetzen – Vorschau", () => {
  const row = {
    invoices: 3, cancellations: 2, drafts: 0, offers: 2, payments: 1, receipts: 2, write_offs: 0, expenses: 0, customers: 3, units: 199, stocked: 2,
    sequences: 5, products_kept: 461, customer_names: ["Ahmad", "Fedaa", "محمد"], suppliers: '["Fedaa"]', numbers: ["RE-2026-0001"],
    digest: "abc",
  };

  it("liest Zahlen und Namen (JSON als Feld oder Text)", () => {
    const p = toPreview(row);
    expect(p.invoices).toBe(3);
    expect(p.writeOffs).toBe(0);
    expect(p.sequences).toBe(5);
    expect(p.productsKept).toBe(461);
    expect(p.suppliers).toEqual(["Fedaa"]);
    expect(p.customerNames).toEqual(["Ahmad", "Fedaa", "محمد"]);
    expect(isEmpty(p)).toBe(false);
  });

  it("Fingerabdruck ändert sich bei anderer Anzahl und bei anderen Datensätzen gleicher Anzahl", () => {
    const a = toPreview(row);
    expect(fingerprint(a)).toBe(fingerprint(toPreview(row)));
    expect(fingerprint(a)).not.toBe(fingerprint(toPreview({ ...row, payments: 2 })));
    expect(fingerprint(a)).not.toBe(fingerprint(toPreview({ ...row, digest: "abd" }))); // z. B. anderer Lieferant würde gelöscht
  });

  it("leer = nichts zu löschen (Artikel bleiben immer, zählen nicht); übrig gebliebene Nummernkreise zählen mit", () => {
    expect(isEmpty(toPreview({}))).toBe(true);
    expect(isEmpty(toPreview({ products_kept: 500 }))).toBe(true);
    expect(isEmpty(toPreview({ stocked: 1 }))).toBe(false);
    expect(isEmpty(toPreview({ sequences: 1 }))).toBe(false);
  });
});

// ───────────── System zurücksetzen (Datenbank) ─────────────
// LÖSCHT ALLE BELEGE UND KUNDEN der Datenbank und setzt sie auf „Echtbetrieb“. Nur mit eigener, frisch migrierter Datenbank und nur diese Datei:
//   RESET_TEST_DB=1 DATABASE_URL=postgres://…/starstyle_reset npx vitest run tests/test-reset.test.ts
const run = process.env.DATABASE_URL && process.env.RESET_TEST_DB === "1" ? describe : describe.skip;
run("System zurücksetzen (Datenbank)", async () => {
  const { db, schema } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const { receiveGoods, bookWriteOff } = await import("../src/lib/stock");
  const { nextNumber } = await import("../src/lib/numbering");
  const { liveStatus, resetStatus, resetTestData, ResetError } = await import("../src/lib/test-reset");
  const tag = String(Date.now()).slice(-8);

  async function product(sku: string, o: { linked?: boolean; supplierId?: string } = {}) {
    const [p] = await db.insert(schema.products).values({ sku, nameDe: `Reset ${sku}`, supplierId: o.supplierId ?? null }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id, barcode: `47${tag}${sku.slice(-2)}` }).returning();
    if (o.linked) await db.insert(schema.shopVariants).values({ channel: "GENERAL_SHOP", shopVariantId: `gid://reset/${tag}/${sku}`, variantId: v.id, matchedBy: "import" });
    return { p, v };
  }

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

  it("löscht alle Bewegungen und Vorgänge, ALLE Artikel bleiben (Bestand 0); danach Echtbetrieb – nie wieder", async () => {
    await db.update(schema.shops).set({ active: false });
    await db.insert(schema.companySettings).values({ id: "company" }).onConflictDoNothing();
    const [docSup] = await db.insert(schema.suppliers).values({ name: `Nur-Beleg-Lieferant ${tag}` }).returning();
    const [prodSup] = await db.insert(schema.suppliers).values({ name: `Artikel-Lieferant ${tag}` }).returning();
    const sold = await product(`RS-${tag}-01`); // in keinem Shop, mit Verlust – früher „Testartikel“, bleibt jetzt auch
    const shop = await product(`RS-${tag}-02`, { linked: true });
    const plain = await product(`RS-${tag}-03`, { supplierId: prodSup.id });
    await receiveGoods({ supplierId: docSup.id, date: "2026-10-30", lines: [
      { variantId: sold.v.id, qty: 5, unitCostCents: 100 }, { variantId: shop.v.id, qty: 3, unitCostCents: 200 }, { variantId: plain.v.id, qty: 7, unitCostCents: 300 },
    ] });
    await bookWriteOff({ date: "2026-10-30", reason: "DAMAGE", lines: [{ variantId: sold.v.id, qty: 1 }] });
    const [cust] = await db.insert(schema.customers).values({ name: `Kunde ${tag}` }).returning();
    // eine (Test-)Bestellung aus dem Shop sperrt nicht mehr (Wunsch Inhaber 04.11.2026)
    await db.insert(schema.invoices).values({ customerId: cust.id, externalOrderId: `gid://shopify/Order/${tag}` });
    // Artikel-Fotos (Shop-Galerie) bleiben
    const [kf] = await db.insert(schema.storedFiles).values({ name: "k", mime: "image/png", size: 1, sha256: "x", data: Buffer.from([2]) }).returning();
    await db.insert(schema.shopMedia).values({ productId: sold.p.id, channel: "GENERAL_SHOP", fileId: kf.id, position: 0 });

    expect(await liveStatus()).toEqual({ live: false, since: null });
    const before = await resetStatus();
    expect(before.block).toBe(null);
    expect(before.preview.suppliers).toEqual([`Nur-Beleg-Lieferant ${tag}`]);
    expect(before.preview.productsKept).toBeGreaterThanOrEqual(3);

    await expect(resetTestData("veraltet", "u-test")).rejects.toBeInstanceOf(ResetError);
    await resetTestData(before.fingerprint, "u-test");

    for (const k of [sold, shop, plain]) {
      expect(await db.query.products.findFirst({ where: eq(schema.products.id, k.p.id) })).toBeDefined();
      expect((await db.query.variants.findFirst({ where: eq(schema.variants.id, k.v.id) }))?.stockQty).toBe(0);
    }
    expect(await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, kf.id) })).toBeDefined();
    expect((await db.select().from(schema.shopMedia).where(eq(schema.shopMedia.fileId, kf.id))).length).toBe(1);
    expect((await db.select().from(schema.shopVariants).where(eq(schema.shopVariants.variantId, shop.v.id))).length).toBe(1);
    expect((await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, docSup.id))).length).toBe(0);
    expect((await db.select().from(schema.suppliers).where(eq(schema.suppliers.id, prodSup.id))).length).toBe(1);
    expect((await db.select().from(schema.customers)).length).toBe(0);
    expect((await db.select().from(schema.invoices)).length).toBe(0);
    expect((await db.select().from(schema.goodsReceipts)).length).toBe(0);
    expect((await db.select().from(schema.stockMovements)).length).toBe(0);
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "reset"))).length).toBeGreaterThan(0);
    expect(await db.transaction((tx) => nextNumber(tx, "INVOICE", 2026))).toBe("RE-2026-0001");
    const [c] = await db.insert(schema.customers).values({ name: `Erster echter Kunde ${tag}` }).returning();
    expect(c.number).toBe(1);

    // Echtbetrieb: Zeichen mit Datum, Knopf weg, ein zweites Zurücksetzen geht nicht
    const live = await liveStatus();
    expect(live.live).toBe(true);
    expect(Math.abs(live.since!.getTime() - Date.now())).toBeLessThan(60_000);
    const after = await resetStatus();
    expect(after.block).toBe("live");
    await expect(resetTestData(after.fingerprint)).rejects.toMatchObject({ code: "resetLive" });
  });
});
