import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { groupByProduct, mapShopProduct, netCents, type ShopImportVariant } from "../src/lib/shopify/product-map";

type P = ShopImportVariant["product"];
const product = (p: Partial<P> = {}): P => ({
  id: "gid://shopify/Product/1", title: "DeltaPro Kamm Lucas", handle: "kamm-lucas", productType: "Werkzeug & Zubehör", vendor: "DeltaPro",
  status: "ACTIVE", isGiftCard: false, options: [{ name: "Title", position: 1 }],
  featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/s/files/kamm.webp" } } }, ...p,
});
const variant = (v: Partial<ShopImportVariant> = {}): ShopImportVariant => ({
  id: "gid://shopify/ProductVariant/1", sku: "8721399642054", barcode: "8721399642054", price: "4.90", position: 1,
  selectedOptions: [{ name: "Title", value: "Default Title" }], inventoryItem: { unitCost: null }, product: product(), ...v,
});

describe("Shopify-Produkt → Artikel", () => {
  it("Shop-Bruttopreis wird netto, ungültige Preise werden 0", () => {
    expect(netCents("12.90", 1900, true)).toBe(1084);
    expect(netCents("12.90", 1900, false)).toBe(1290);
    expect(netCents("10.70", 700, true)).toBe(1000);
    expect(netCents("0.00", 1900, true)).toBe(0);
    expect(netCents("abc", 1900, true)).toBe(0);
    expect(netCents(null, 1900, true)).toBe(0);
  });

  it("Artikel ohne Optionen: eine leere Variante, Art.-Nr. = SKU aus dem Shop", () => {
    const d = mapShopProduct([variant()], { taxesIncluded: true });
    expect(d).toMatchObject({
      sku: "8721399642054", nameDe: "DeltaPro Kamm Lucas", category: "Werkzeug & Zubehör", vendor: "DeltaPro", vatRateBp: 1900,
      purchasePriceCents: 0, retailPriceCents: 412, imageUrl: "https://cdn.shopify.com/s/files/kamm.webp",
    });
    expect(d.variants).toEqual([{ shopVariantId: "gid://shopify/ProductVariant/1", size: "", color: "", barcode: "8721399642054", priceCents: null }]);
  });

  it("Farbe → Farbe, übrige Optionen → Größe; abweichender Preis wird Variantenpreis; Art.-Nr. = Handle", () => {
    const p = product({ id: "gid://shopify/Product/2", title: "DeltaPro Werkzeugmatte", handle: "werkzeugmatte",
      options: [{ name: "Farbe", position: 2 }, { name: "Ausführung", position: 1 }] });
    const d = mapShopProduct([
      variant({ id: "v2", position: 2, sku: "B", barcode: " 8720701739017 ", price: "19.90", product: p, selectedOptions: [{ name: "Ausführung", value: "Standard" }, { name: "Farbe", value: "Schwarz" }] }),
      variant({ id: "v1", position: 1, sku: "A", barcode: "8720701738997", price: "24.90", product: p, selectedOptions: [{ name: "Ausführung", value: "Magnetisch" }, { name: "Farbe", value: "Schwarz" }], inventoryItem: { unitCost: { amount: "9.50" } } }),
    ].sort((a, b) => a.position - b.position), { taxesIncluded: true });
    expect(d).toMatchObject({ sku: "werkzeugmatte", retailPriceCents: 2092, purchasePriceCents: 950 });
    expect(d.variants).toEqual([
      { shopVariantId: "v1", size: "Magnetisch", color: "Schwarz", barcode: "8720701738997", priceCents: null },
      { shopVariantId: "v2", size: "Standard", color: "Schwarz", barcode: "8720701739017", priceCents: 1672 },
    ]);
  });

  it("mehrere Optionen ohne Farbe werden zur Größe zusammengefasst, Dubletten eindeutig gemacht", () => {
    const p = product({ options: [{ name: "Modell", position: 1 }, { name: "Größe", position: 2 }] });
    const d = mapShopProduct([
      variant({ id: "a", product: p, selectedOptions: [{ name: "Modell", value: "Sebastian" }, { name: "Größe", value: "M" }] }),
      variant({ id: "b", product: p, position: 2, selectedOptions: [{ name: "Modell", value: "sebastian" }, { name: "Größe", value: "m" }] }),
    ], { taxesIncluded: true });
    expect(d.variants.map((v) => [v.size, v.color])).toEqual([["Sebastian / M", ""], ["sebastian / m (2)", ""]]);
  });

  it("Haarfarben: Option „Farbton“ zählt als Farbe", () => {
    const p = product({ options: [{ name: "Farbton", position: 1 }] });
    expect(mapShopProduct([variant({ product: p, selectedOptions: [{ name: "Farbton", value: "6.0 Dunkelblond" }] })], { taxesIncluded: true }).variants[0])
      .toMatchObject({ size: "", color: "6.0 Dunkelblond" });
  });

  it("Barcode: leer oder zu lang → keiner; ohne SKU wird Barcode bzw. Handle zur Art.-Nr.", () => {
    expect(mapShopProduct([variant({ barcode: "  " })], { taxesIncluded: true }).variants[0].barcode).toBeNull();
    expect(mapShopProduct([variant({ barcode: "1".repeat(33) })], { taxesIncluded: true }).variants[0].barcode).toBeNull();
    expect(mapShopProduct([variant({ sku: "" })], { taxesIncluded: true }).sku).toBe("8721399642054");
    expect(mapShopProduct([variant({ sku: null, barcode: null })], { taxesIncluded: true }).sku).toBe("kamm-lucas");
  });

  it("archivierte Produkte und Geschenkkarten werden ausgelassen, Varianten nach Position sortiert", () => {
    const a = product({ id: "A" }), b = product({ id: "B", status: "ARCHIVED" }), c = product({ id: "C", isGiftCard: true }), d = product({ id: "D", status: "DRAFT" });
    const groups = groupByProduct([
      variant({ id: "a2", position: 2, product: a }), variant({ id: "b1", product: b }), variant({ id: "a1", position: 1, product: a }),
      variant({ id: "c1", product: c }), variant({ id: "d1", product: d }),
    ]);
    expect(groups.map((g) => g.map((v) => v.id))).toEqual([["a1", "a2"], ["d1"]]);
  });
});

// ───────────── Integration mit simuliertem Shopify ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Produkt-Import aus Shopify (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const { encrypt } = await import("../src/lib/crypto");
  const { importProducts } = await import("../src/lib/shopify/import");
  const sync = await import("../src/lib/shopify/sync");
  const tag = String(Date.now()).slice(-8);
  const ean = (n: number) => `41${tag}${String(n).padStart(3, "0")}`;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const gel = product({ id: `gid://shopify/Product/${tag}1`, title: `Rasiergel ${tag}`, handle: `rasiergel-${tag}`,
    featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/s/files/gel-${tag}.webp` } } } });
  const chair = product({ id: `gid://shopify/Product/${tag}2`, title: `Barberstuhl ${tag}`, handle: `stuhl-${tag}`, options: [{ name: "Farbe", position: 1 }],
    featuredMedia: { preview: { image: { url: `https://cdn.shopify.com/s/files/stuhl-${tag}.webp` } } } });
  const nodes: ShopImportVariant[] = [
    variant({ id: `gid://shopify/ProductVariant/${tag}1`, sku: ean(1), barcode: ean(1), price: "11.90", product: gel }),
    variant({ id: `gid://shopify/ProductVariant/${tag}2`, sku: ean(2), barcode: ean(2), price: "1190.00", product: chair, selectedOptions: [{ name: "Farbe", value: "Gold" }] }),
    variant({ id: `gid://shopify/ProductVariant/${tag}3`, sku: ean(3), barcode: ean(3), price: "1309.00", position: 2, product: chair, selectedOptions: [{ name: "Farbe", value: "Schwarz" }] }),
    // schon von Hand zugeordnet (anderer Barcode als bei uns) → darf nicht doppelt angelegt werden
    variant({ id: `gid://shopify/ProductVariant/${tag}4`, sku: ean(4), barcode: ean(4), price: "19.90",
      product: product({ id: `gid://shopify/Product/${tag}4`, title: `Handspiegel ${tag}`, handle: `spiegel-${tag}`, featuredMedia: null }) }),
  ];

  function shopifyMock() {
    return vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (url.startsWith("https://cdn.shopify.com/")) return new Response(png);
      if (url.endsWith("/admin/oauth/access_token")) return new Response(JSON.stringify({ access_token: "tok", scope: "x", expires_in: 86399 }));
      const q = JSON.parse(String(init?.body)).query as string;
      const page = (n: unknown[]) => Response.json({ data: { productVariants: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: n } } });
      if (q.includes("taxesIncluded")) return Response.json({ data: { shop: { currencyCode: "EUR", taxesIncluded: true } } });
      if (q.includes("selectedOptions")) return page(nodes);
      if (q.includes("productVariants")) return page(nodes.map((n) => ({ id: n.id, sku: n.sku, barcode: n.barcode, displayName: n.product.title,
        inventoryItem: { id: n.id.replace("ProductVariant", "InventoryItem"), tracked: true } })));
      return Response.json({ errors: [{ message: "unexpected" }] });
    });
  }

  beforeAll(async () => {
    await db.delete(schema.shopVariants).where(eq(schema.shopVariants.channel, "GENERAL_SHOP"));
    const shop = { domain: "star-general.myshopify.com", clientId: "cid", clientSecretEnc: encrypt("geheim"), staticTokenEnc: "", tokenEnc: "", tokenExpiresAt: null, active: false };
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", ...shop }).onConflictDoUpdate({ target: schema.shops.channel, set: shop });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("legt fehlende Artikel an (netto, Farbe, Barcode, Foto, Bestand 0), ordnet zu und doppelt nichts", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    // Handspiegel gibt es schon bei uns (eigene Art.-Nr., anderer Barcode) und ist von Hand zugeordnet
    const [mirror] = await db.insert(schema.products).values({ sku: `HSP-${tag}`, nameDe: `Handspiegel ${tag}`, vatRateBp: 1900 }).returning();
    const [mirrorVariant] = await db.insert(schema.variants).values({ productId: mirror.id, barcode: `42${tag}999` }).returning();
    await sync.syncProducts("GENERAL_SHOP");
    const row = await db.query.shopVariants.findFirst({ where: eq(schema.shopVariants.shopVariantId, nodes[3].id) });
    await sync.linkVariant("GENERAL_SHOP", row!.id, mirrorVariant.id);

    const r = await importProducts("GENERAL_SHOP", { waitForImages: true });
    expect(r).toMatchObject({ created: 2, variants: 3, existing: 1, noBarcode: 0, failed: 0, images: 2, matched: 4, open: 0 });
    expect((await db.select().from(schema.products).where(eq(schema.products.sku, ean(4)))).length).toBe(0);
    const links = await db.select().from(schema.shopVariants).where(eq(schema.shopVariants.channel, "GENERAL_SHOP"));
    expect(links.map((l) => l.matchedBy).sort()).toEqual(["import", "import", "import", "manual"]);

    const g = await db.query.products.findFirst({ where: eq(schema.products.sku, ean(1)), with: { variants: true } });
    expect(g).toMatchObject({ nameDe: `Rasiergel ${tag}`, retailPriceCents: 1000, wholesalePriceCents: 1000, inGeneralShop: true, inBrandShop: false });
    expect(g!.imageFileId).not.toBeNull();
    expect(g!.variants.map((v) => [v.size, v.color, v.barcode, v.stockQty])).toEqual([["", "", ean(1), 0]]);

    const c = await db.query.products.findFirst({ where: eq(schema.products.sku, `stuhl-${tag}`), with: { variants: true } });
    expect(c).toMatchObject({ retailPriceCents: 100000, category: "Werkzeug & Zubehör" });
    expect(c!.variants.map((v) => [v.color, v.barcode, v.retailPriceCents]).sort()).toEqual([["Gold", ean(2), null], ["Schwarz", ean(3), 110000]]);
    expect((await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, c!.id))).some((a) => a.action === "import")).toBe(true);

    const again = await importProducts("GENERAL_SHOP", { waitForImages: true });
    expect(again).toMatchObject({ created: 0, existing: 3, images: 0, matched: 4, open: 0 });
  }, 30_000);
});
