import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildProductSet, decodePush, descriptionHtml, encodePush, matchCreatedVariants, planVariantAdds, pushBlockers, resolveStoreType, shopPriceCents,
  storeTypesFrom, variantOptions, variantSku, type PushProduct, type PushVariant, type ShopProductShape,
} from "../src/lib/shopify/product-push-map";

const v = (x: Partial<PushVariant> = {}): PushVariant => ({ id: "v1", size: "", color: "", barcode: "4006381333931", retailPriceCents: null, imageFileId: null, available: 0, ...x });
const product = (x: Partial<PushProduct> = {}): PushProduct => ({
  id: "p1", sku: "DP-KAMM", nameDe: "DeltaPro Kamm", descriptionDe: "", category: "Werkzeug & Zubehör", vendor: "DeltaPro",
  vatRateBp: 1900, retailPriceCents: 1000, purchasePriceCents: 350, imageFileId: null, variants: [v()], ...x,
});
const opts = { taxesIncluded: true, locationId: "gid://shopify/Location/1", images: new Map() };

describe("Artikel → Shopify-Produkt", () => {
  it("Shop-Preis: Netto + MwSt. bei Brutto-Shops, sonst netto", () => {
    expect(shopPriceCents(1000, 1900, true)).toBe(1190);
    expect(shopPriceCents(1000, 700, true)).toBe(1070);
    expect(shopPriceCents(1000, 1900, false)).toBe(1000);
    expect(shopPriceCents(4202, 1900, true)).toBe(5000);
  });

  it("Beschreibung: HTML maskiert, Absätze und Zeilenumbrüche", () => {
    expect(descriptionHtml("Für <Profis> & Salons\nZeile 2\n\nAbsatz 2")).toBe("<p>Für &lt;Profis&gt; &amp; Salons<br>Zeile 2</p><p>Absatz 2</p>");
    expect(descriptionHtml("  ")).toBe("");
  });

  it("Artikel ohne Größe/Farbe: eine Standard-Variante mit Preis, Barcode, Art.-Nr., EK und Bestand", () => {
    const s = buildProductSet(product({ variants: [v({ available: 7 })] }), opts);
    expect(s).toMatchObject({ title: "DeltaPro Kamm", vendor: "DeltaPro", productType: "Werkzeug & Zubehör", status: "ACTIVE",
      productOptions: [{ name: "Title", position: 1, values: [{ name: "Default Title" }] }] });
    expect(s).not.toHaveProperty("descriptionHtml");
    expect(s).not.toHaveProperty("files");
    expect(s.variants).toEqual([{
      optionValues: [{ optionName: "Title", name: "Default Title" }], price: "11.90", barcode: "4006381333931",
      inventoryItem: { sku: "4006381333931", tracked: true, cost: "3.50" }, // SKU im Shop = Barcode
      inventoryQuantities: [{ locationId: "gid://shopify/Location/1", name: "available", quantity: 7 }],
    }]);
  });

  it("Größen und Farben werden Optionen; leere Werte → „Standard“; eigener Variantenpreis; Fotos", () => {
    const images = new Map([["f1", { resourceUrl: "https://shopify-staged/f1", filename: "dp-1.webp" }], ["f2", { resourceUrl: "https://shopify-staged/f2", filename: "dp-2.webp" }]]);
    const p = product({
      imageFileId: "f1",
      variants: [
        v({ id: "a", size: "S", color: "Schwarz", barcode: "111", available: -3 }),
        v({ id: "b", size: "M", color: "", barcode: null, retailPriceCents: 1200, imageFileId: "f2" }),
      ],
    });
    const s = buildProductSet(p, { ...opts, images });
    expect(s.productOptions).toEqual([
      { name: "Größe", position: 1, values: [{ name: "S" }, { name: "M" }] },
      { name: "Farbe", position: 2, values: [{ name: "Schwarz" }, { name: "Standard" }] },
    ]);
    expect(s.files).toEqual([
      { originalSource: "https://shopify-staged/f1", contentType: "IMAGE", alt: "DeltaPro Kamm", filename: "dp-1.webp" },
      { originalSource: "https://shopify-staged/f2", contentType: "IMAGE", alt: "DeltaPro Kamm", filename: "dp-2.webp" },
    ]);
    expect(s.variants[0]).toMatchObject({ optionValues: [{ optionName: "Größe", name: "S" }, { optionName: "Farbe", name: "Schwarz" }], price: "11.90", barcode: "111",
      inventoryItem: { sku: "111" }, inventoryQuantities: [{ quantity: 0 }] });
    expect(s.variants[0]).not.toHaveProperty("file");
    expect(s.variants[1]).toMatchObject({ price: "14.28", inventoryItem: { sku: "DP-KAMM-M" }, file: { originalSource: "https://shopify-staged/f2" } });
    expect(s.variants[1]).not.toHaveProperty("barcode");
  });

  it("nur Farben: eine Option „Farbe“; Kollision mit „Standard“ wird nummeriert", () => {
    expect(variantOptions([{ size: "", color: "Rot" }, { size: "", color: "Blau" }])).toEqual({ names: ["Farbe"], values: [["Rot"], ["Blau"]] });
    expect(variantOptions([{ size: "", color: "" }, { size: "", color: "Standard" }, { size: "", color: "Rot" }]).values).toEqual([["Standard"], ["Standard (2)"], ["Rot"]]);
    expect(variantSku("SKU", { size: "250 ml", color: "" }, false)).toBe("SKU-250-ml");
    expect(variantSku("SKU", { size: "250 ml", color: "" }, true)).toBe("SKU");
    expect(variantSku("SKU", { size: "S", color: "Rot", barcode: " 4006381333931 " }, false)).toBe("4006381333931");
  });

  it("angelegte Shop-Varianten werden über die Optionswerte unseren Varianten zugeordnet", () => {
    const ours = [{ id: "a", size: "S", color: "" }, { id: "b", size: "M", color: "" }];
    const m = matchCreatedVariants(ours, [
      { id: "gid/2", selectedOptions: [{ name: "Größe", value: "M" }] },
      { id: "gid/1", selectedOptions: [{ name: "Größe", value: "S" }] },
    ]);
    expect(Object.fromEntries(m)).toEqual({ a: "gid/1", b: "gid/2" });
    expect(Object.fromEntries(matchCreatedVariants([{ id: "x", size: "", color: "" }], [{ id: "gid/9", selectedOptions: [{ name: "Title", value: "Default Title" }] }]))).toEqual({ x: "gid/9" });
  });

  it("Ergebnis für die Adresszeile: hin und zurück, Unbekanntes wird verworfen", () => {
    const r = [{ channel: "GENERAL_SHOP" as const, outcome: "created" as const, imagesFailed: true }, { channel: "BRAND_SHOP" as const, outcome: "failed" as const, reason: "noWriteAccess" as const }];
    expect(decodePush(encodePush(r))).toEqual([{ ...r[0] }, { ...r[1], imagesFailed: false }]);
    expect(decodePush(encodePush([{ channel: "GENERAL_SHOP", outcome: "updated", n: 2 }]))).toEqual([{ channel: "GENERAL_SHOP", outcome: "updated", n: 2, imagesFailed: false }]);
    expect(decodePush("GENERAL_SHOP.partial.options.3.0")).toEqual([{ channel: "GENERAL_SHOP", outcome: "partial", reason: "options", n: 3, imagesFailed: false }]);
    expect(decodePush("BRAND_SHOP.notNow...0")).toEqual([{ channel: "BRAND_SHOP", outcome: "notNow", imagesFailed: false }]);
    expect(decodePush("EVIL.created...0~GENERAL_SHOP.hacked...0")).toEqual([]);
    expect(decodePush("GENERAL_SHOP.failed.<script>.99999.0")).toEqual([{ channel: "GENERAL_SHOP", outcome: "failed", imagesFailed: false }]);
    expect(decodePush(undefined)).toEqual([]);
  });

  it("Gewicht der Packung geht als Gewicht des Lagerartikels mit (Versand nach Gewicht)", () => {
    const s = buildProductSet(product({ variants: [v({ weightGrams: 150 }), v({ id: "v2", size: "M", barcode: "222", weightGrams: null })] }), opts);
    expect(s.variants[0].inventoryItem).toMatchObject({ measurement: { weight: { unit: "GRAMS", value: 150 } } });
    expect(s.variants[1].inventoryItem).not.toHaveProperty("measurement");
  });

  it("Produkttyp des Shops statt Kategorie, wenn angegeben", () => {
    expect(buildProductSet(product({ category: "Kämme" }), { ...opts, productType: "Werkzeug & Zubehör" }).productType).toBe("Werkzeug & Zubehör");
    expect(buildProductSet(product({ category: "" }), opts)).not.toHaveProperty("productType");
  });
});

describe("Kategorien des Shops", () => {
  const cols = [
    { title: "Barberstühle", disjunctive: false, rules: [{ column: "TYPE", relation: "EQUALS", condition: "Barberstuhl" }] },
    { title: "Werkzeug & Zubehör", disjunctive: false, rules: [{ column: "TYPE", relation: "EQUALS", condition: "Werkzeug & Zubehör" }] },
    { title: "Sale", disjunctive: false, rules: [{ column: "TAG", relation: "EQUALS", condition: "sale" }] },
    // mehrere Bedingungen, die alle gelten müssen → Typ allein reicht nicht
    { title: "Schwarze Stühle", disjunctive: false, rules: [{ column: "TYPE", relation: "EQUALS", condition: "Friseurstuhl" }, { column: "TAG", relation: "EQUALS", condition: "schwarz" }] },
  ];
  const types = storeTypesFrom(["Barberstuhl", "Friseurstuhl", " Pflege & Verbrauch "], cols);

  it("Produkttypen + automatische Kollektionen → Kategorien mit Anzeigenamen, ohne Doppelte", () => {
    expect(types).toEqual([
      { type: "Barberstuhl", collection: "Barberstühle" },
      { type: "Friseurstuhl", collection: null },
      { type: "Pflege & Verbrauch", collection: null },
      { type: "Werkzeug & Zubehör", collection: "Werkzeug & Zubehör" },
    ]);
  });

  it("unsere Kategorie → Produkttyp: gleicher Name (Typ oder Kollektion), sonst Zuordnung, sonst unbekannt", () => {
    expect(resolveStoreType("barberstuhl", types, {})).toBe("Barberstuhl");
    expect(resolveStoreType("  Barberstühle ", types, {})).toBe("Barberstuhl"); // Name der Kollektion
    expect(resolveStoreType("Kämme", types, {})).toBeNull();
    expect(resolveStoreType("Kämme", types, { "Kämme": "Werkzeug & Zubehör" })).toBe("Werkzeug & Zubehör");
    expect(resolveStoreType("Kämme", types, { "Kämme": "Gibt es nicht mehr" })).toBeNull();
    expect(resolveStoreType("", types, {})).toBeNull();
    expect(resolveStoreType("Kämme", [], {})).toBe("Kämme"); // Shop ohne Kategorien
  });

  it("was vor dem Hochladen fehlt", () => {
    const base = { category: "Kämme", retailPriceCents: 1000, variants: [{ barcode: "111" }, { barcode: "222" }] };
    expect(pushBlockers(base, { creating: true, storeType: "Werkzeug & Zubehör" })).toEqual([]);
    expect(pushBlockers({ ...base, variants: [{ barcode: "111" }, { barcode: " " }] }, { creating: false, storeType: null })).toEqual(["noBarcode"]);
    expect(pushBlockers({ ...base, category: "" }, { creating: true, storeType: null })).toEqual(["noCategory"]);
    expect(pushBlockers(base, { creating: true, storeType: null })).toEqual(["unknownCategory"]);
    expect(pushBlockers({ ...base, category: "" }, { creating: false, storeType: null })).toEqual([]); // Ergänzen braucht keine Kategorie
    expect(pushBlockers({ ...base, retailPriceCents: 0 }, { creating: false, storeType: null })).toEqual(["noPrice"]);
    expect(pushBlockers({ ...base, retailPriceCents: 0, variants: [{ barcode: "1", retailPriceCents: 500 }] }, { creating: false, storeType: null })).toEqual([]);
  });
});

describe("Größen/Farben an ein vorhandenes Shop-Produkt anfügen", () => {
  const sv = (id: string, opts: Record<string, string>) => ({ id, selectedOptions: Object.entries(opts).map(([name, value]) => ({ name, value })) });
  const shape = (options: Record<string, string[]>, variants: ShopProductShape["variants"], hasOnlyDefaultVariant = false): ShopProductShape =>
    ({ hasOnlyDefaultVariant, options: Object.entries(options).map(([name, values]) => ({ name, values })), variants });

  it("Produkt mit nur der Standard-Variante: erst Optionen anlegen (Werte der verbundenen Variante), dann die neue", () => {
    const plan = planVariantAdds(shape({ Title: ["Default Title"] }, [sv("s1", { Title: "Default Title" })], true),
      new Map([["a", "s1"]]), [{ id: "a", size: "", color: "Rot" }, { id: "b", size: "", color: "Blau" }], ["b"]);
    expect(plan).toEqual({ ok: true, createOptions: [{ name: "Farbe", values: [{ name: "Rot" }] }], variants: [{ id: "b", optionValues: [{ optionName: "Farbe", name: "Blau" }] }] });
  });

  it("Größe + Farbe wie bei uns angelegt; englische Optionsnamen werden erkannt", () => {
    const ours = [{ id: "a", size: "S", color: "Rot" }, { id: "b", size: "M", color: "Rot" }];
    expect(planVariantAdds(shape({ "Größe": ["S"], Farbe: ["Rot"] }, [sv("s1", { "Größe": "S", Farbe: "Rot" })]), new Map([["a", "s1"]]), ours, ["b"]))
      .toEqual({ ok: true, createOptions: [], variants: [{ id: "b", optionValues: [{ optionName: "Größe", name: "M" }, { optionName: "Farbe", name: "Rot" }] }] });
    expect(planVariantAdds(shape({ Color: ["Rot"], Size: ["S"] }, [sv("s1", { Color: "Rot", Size: "S" })]), new Map([["a", "s1"]]), ours, ["b"]))
      .toEqual({ ok: true, createOptions: [], variants: [{ id: "b", optionValues: [{ optionName: "Color", name: "Rot" }, { optionName: "Size", name: "M" }] }] });
  });

  it("nutzt der Artikel eine Option nicht, kommt ihr Wert von der verbundenen Shop-Variante; gleiche Größe überall wird ignoriert", () => {
    const ours = [{ id: "a", size: "250 ml", color: "" }, { id: "b", size: "250 ml", color: "" }, { id: "c", size: "500 ml", color: "" }];
    // Shop: Größe + Farbe „Gold“ – wir haben keine Farben
    expect(planVariantAdds(shape({ "Größe": ["250 ml"], Farbe: ["Gold"] }, [sv("s1", { "Größe": "250 ml", Farbe: "Gold" })]), new Map([["a", "s1"]]),
      [{ id: "a", size: "250 ml", color: "" }, { id: "c", size: "500 ml", color: "" }], ["c"]))
      .toEqual({ ok: true, createOptions: [], variants: [{ id: "c", optionValues: [{ optionName: "Größe", name: "500 ml" }, { optionName: "Farbe", name: "Gold" }] }] });
    // Shop nur mit Farbe, unsere Größe ist überall gleich → passt
    expect(planVariantAdds(shape({ Farbe: ["Rot"] }, [sv("s1", { Farbe: "Rot" })]), new Map([["a", "s1"]]),
      [{ id: "a", size: "250 ml", color: "Rot" }, { id: "b", size: "250 ml", color: "Blau" }], ["b"]))
      .toEqual({ ok: true, createOptions: [], variants: [{ id: "b", optionValues: [{ optionName: "Farbe", name: "Blau" }] }] });
    // Shop nur mit Farbe, wir unterscheiden Größen → nicht darstellbar
    expect(planVariantAdds(shape({ Farbe: ["Rot"] }, [sv("s1", { Farbe: "Rot" })]), new Map([["a", "s1"]]), ours, ["c"])).toEqual({ ok: false, reason: "options" });
  });

  it("mehrere Nicht-Farb-Optionen wie beim Import „A / B“; passt die Größe nicht dazu → von Hand", () => {
    const s2 = shape({ "Länge": ["50 cm"], "Stärke": ["fein"] }, [sv("s1", { "Länge": "50 cm", "Stärke": "fein" })]);
    expect(planVariantAdds(s2, new Map([["a", "s1"]]), [{ id: "a", size: "50 cm / fein", color: "" }, { id: "b", size: "60 cm / grob", color: "" }], ["b"]))
      .toEqual({ ok: true, createOptions: [], variants: [{ id: "b", optionValues: [{ optionName: "Länge", name: "60 cm" }, { optionName: "Stärke", name: "grob" }] }] });
    expect(planVariantAdds(s2, new Map([["a", "s1"]]), [{ id: "a", size: "50 cm / fein", color: "" }, { id: "b", size: "60 cm", color: "" }], ["b"]))
      .toEqual({ ok: false, reason: "options" });
  });

  it("gibt es die Kombination im Shop schon (ohne unseren Barcode) → nicht doppelt anlegen", () => {
    const s3 = shape({ Farbe: ["Rot", "Blau"] }, [sv("s1", { Farbe: "Rot" }), sv("s2", { Farbe: "blau" })]);
    expect(planVariantAdds(s3, new Map([["a", "s1"]]), [{ id: "a", size: "", color: "Rot" }, { id: "b", size: "", color: "Blau" }], ["b"]))
      .toEqual({ ok: false, reason: "conflict" });
  });
});

// ───────────── Integration mit simuliertem Shopify ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Artikel im Shop anlegen (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { and, eq } = await import("drizzle-orm");
  const { encrypt } = await import("../src/lib/crypto");
  const { pushProductToShops } = await import("../src/lib/shopify/product-push");
  const tag = String(Date.now()).slice(-8);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  type Call = { url: string; query?: string; variables?: Record<string, unknown> };
  let calls: Call[] = [];
  let existing: { id: string; sku: string; barcode: string; displayName: string; inventoryItem: { id: string; tracked: boolean } }[] = [];
  let denyProducts = false, denyPublish = false, created = 0;
  // Shop-Produkt zu einer verbundenen Variante (für „Größen/Farben ergänzen“)
  let shopProduct: { id: string; hasOnlyDefaultVariant: boolean; options: { name: string; position: number; optionValues: { name: string }[] }[]; variants: { nodes: { id: string; selectedOptions: { name: string; value: string }[] }[] } } | null = null;

  function shopifyMock() {
    return vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (url.endsWith("/admin/oauth/access_token")) { calls.push({ url }); return Response.json({ access_token: "tok", scope: "x", expires_in: 86399 }); }
      if (url.startsWith("https://staged.example/")) { calls.push({ url }); return new Response(null, { status: 204 }); }
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      calls.push({ url, query, variables });
      if (query.includes("productVariants(first: 50, query")) return Response.json({ data: { productVariants: { nodes: existing } } });
      if (query.includes("productTypes(")) return Response.json({ data: { productTypes: { nodes: ["Werkzeug & Zubehör", "Barberstuhl"] } } });
      if (query.includes("collections(")) return Response.json({ data: { collections: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: [
        { title: "Barberstühle", ruleSet: { appliedDisjunctively: false, rules: [{ column: "TYPE", relation: "EQUALS", condition: "Barberstuhl" }] } },
        { title: "Startseite", ruleSet: null }] } } });
      if (query.includes("productVariant(id:")) return Response.json({ data: { productVariant: shopProduct ? { product: shopProduct } : null } });
      if (query.includes("productOptionsCreate")) return Response.json({ data: { productOptionsCreate: { userErrors: [] } } });
      if (query.includes("inventoryItemUpdate")) return Response.json({ data: { inventoryItemUpdate: { inventoryItem: { id: variables.id }, userErrors: [] } } });
      if (query.includes("productVariantsBulkCreate")) {
        const vs = variables.variants as { barcode?: string; inventoryItem: { sku: string } }[];
        return Response.json({ data: { productVariantsBulkCreate: { userErrors: [], productVariants: vs.map((x, i) => ({
          id: `gid://shopify/ProductVariant/${tag}n${i}`, sku: x.inventoryItem.sku, barcode: x.barcode ?? null, displayName: `Neu ${i}`,
          inventoryItem: { id: `gid://shopify/InventoryItem/${tag}n${i}`, tracked: true } })) } } });
      }
      if (query.includes("taxesIncluded")) return Response.json({ data: { shop: { currencyCode: "EUR", taxesIncluded: true } } });
      if (query.includes("stagedUploadsCreate")) {
        const input = variables.input as { filename: string }[];
        return Response.json({ data: { stagedUploadsCreate: { userErrors: [], stagedTargets: input.map((f) => ({
          url: `https://staged.example/upload/${f.filename}`, resourceUrl: `https://staged.example/res/${f.filename}`, parameters: [{ name: "key", value: f.filename }] })) } } });
      }
      if (query.includes("productSet")) {
        if (denyProducts) return Response.json({ errors: [{ message: "Access denied for productSet field. Required access: `write_products` access scope.", extensions: { code: "ACCESS_DENIED" } }] });
        const input = variables.input as { variants: { optionValues: { optionName: string; name: string }[]; barcode?: string; inventoryItem: { sku: string } }[] };
        const k = created++ ? `x${created}` : ""; // jedes angelegte Produkt eigene IDs (das erste wie in den Erwartungen unten)
        return Response.json({ data: { productSet: { userErrors: [], product: { id: `gid://shopify/Product/${tag}${k}`, handle: `p-${tag}${k}`, variants: { nodes:
          input.variants.map((x, i) => ({ id: `gid://shopify/ProductVariant/${tag}${k}${i}`, sku: x.inventoryItem.sku, barcode: x.barcode ?? null, displayName: `P ${i}`,
            selectedOptions: x.optionValues.map((o) => ({ name: o.optionName, value: o.name })), inventoryItem: { id: `gid://shopify/InventoryItem/${tag}${k}${i}`, tracked: true } })).reverse() } } } } });
      }
      if (query.includes("publications(")) return Response.json({ data: { publications: { nodes: [
        { id: "gid://shopify/Publication/2", catalog: { title: "Channel Catalog 2 for Point of Sale" } },
        { id: "gid://shopify/Publication/1", catalog: { title: "Channel Catalog 1 for Online Store" } }] } } });
      if (query.includes("publishablePublish")) {
        if (denyPublish) return Response.json({ errors: [{ message: "Access denied for publishablePublish field. Required access: `write_publications` access scope.", extensions: { code: "ACCESS_DENIED" } }] });
        return Response.json({ data: { publishablePublish: { userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: `unexpected ${query.slice(0, 60)}` }] });
    });
  }

  async function newProduct(sku: string, o: { general?: boolean; brand?: boolean; barcodes?: (string | null)[]; sizes?: string[]; colors?: string[]; retail?: number; withImage?: boolean; category?: string } = {}) {
    let imageFileId: string | null = null;
    if (o.withImage) {
      [{ id: imageFileId }] = await db.insert(schema.storedFiles).values({ name: "kamm.png", mime: "image/png", size: png.length, sha256: "x", data: Buffer.from(png) }).returning({ id: schema.storedFiles.id });
    }
    const [p] = await db.insert(schema.products).values({ sku, nameDe: `Kamm ${sku}`, vatRateBp: 1900, retailPriceCents: o.retail ?? 1000, purchasePriceCents: 400,
      inGeneralShop: o.general ?? true, inBrandShop: o.brand ?? false, imageFileId, category: o.category ?? "Werkzeug & Zubehör" }).returning();
    const sizes = o.sizes ?? (o.colors ? o.colors.map(() => "") : [""]);
    const vs = [];
    for (const [i, size] of sizes.entries()) {
      const [row] = await db.insert(schema.variants).values({ productId: p.id, size, color: o.colors?.[i] ?? "",
        barcode: o.barcodes ? o.barcodes[i] : `43${tag}${String(i).padStart(2, "0")}${sku.slice(-1)}`, stockQty: 5 }).returning();
      vs.push(row);
    }
    return { p, vs };
  }

  beforeAll(async () => {
    const shop = { domain: "star-general.myshopify.com", clientId: "cid", clientSecretEnc: encrypt("geheim"), staticTokenEnc: "", tokenEnc: "", tokenExpiresAt: null,
      active: false, locationId: "gid://shopify/Location/77", stockBuffer: 1, storeTypes: [], storeTypesAt: null, categoryMap: {} };
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", ...shop }).onConflictDoUpdate({ target: schema.shops.channel, set: shop });
    // Marken-Shop ohne Zugangsdaten → wird still übersprungen
    const brand = { domain: "", clientId: "", clientSecretEnc: "", staticTokenEnc: "", tokenEnc: "", locationId: "" };
    await db.insert(schema.shops).values({ channel: "BRAND_SHOP", ...brand }).onConflictDoUpdate({ target: schema.shops.channel, set: brand });
  });
  afterEach(() => { vi.unstubAllGlobals(); calls = []; existing = []; denyProducts = false; denyPublish = false; shopProduct = null; });

  it("legt den Artikel mit Größen, Bruttopreis, Barcode, Bestand (minus Puffer) und Foto an, veröffentlicht ihn und verbindet die Varianten", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { p, vs } = await newProduct(`PUSH-${tag}-A`, { sizes: ["S", "M"], withImage: true, brand: true });
    const r = await pushProductToShops(p.id, "u-test");
    expect(r).toEqual([{ channel: "GENERAL_SHOP", outcome: "created", imagesFailed: false }]);

    const set = calls.find((c) => c.query?.includes("productSet"))!.variables!.input as Record<string, any>;
    expect(set.title).toBe(`Kamm PUSH-${tag}-A`);
    expect(set.productType).toBe("Werkzeug & Zubehör");
    expect(set.productOptions).toEqual([{ name: "Größe", position: 1, values: [{ name: "S" }, { name: "M" }] }]);
    expect(set.files).toEqual([expect.objectContaining({ originalSource: expect.stringContaining("https://staged.example/res/"), contentType: "IMAGE" })]);
    expect(set.variants.map((x: any) => [x.price, x.barcode, x.inventoryQuantities[0].quantity, x.inventoryQuantities[0].locationId]))
      .toEqual([["11.90", vs[0].barcode, 4, "gid://shopify/Location/77"], ["11.90", vs[1].barcode, 4, "gid://shopify/Location/77"]]);
    expect(calls.some((c) => c.url.startsWith("https://staged.example/upload/"))).toBe(true);
    const pub = calls.find((c) => c.query?.includes("publishablePublish"))!;
    expect(pub.variables).toEqual({ id: `gid://shopify/Product/${tag}`, input: [{ publicationId: "gid://shopify/Publication/1" }] });

    const links = await db.select().from(schema.shopVariants).where(and(eq(schema.shopVariants.channel, "GENERAL_SHOP"), eq(schema.shopVariants.matchedBy, "created")));
    const mine = links.filter((l) => vs.some((x) => x.id === l.variantId));
    expect(mine.map((l) => [l.variantId, l.lastPushedQty, l.tracked]).sort()).toEqual([[vs[0].id, 4, true], [vs[1].id, 4, true]].sort());
    // S ↔ Variante 0 (die Antwort kam in umgekehrter Reihenfolge)
    expect(mine.find((l) => l.variantId === vs[0].id)!.shopVariantId).toBe(`gid://shopify/ProductVariant/${tag}0`);
    expect((await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, p.id), eq(schema.auditLog.action, "shop_create")))).length).toBe(1);

    // nochmal speichern → schon im Shop, keine Shopify-Aufrufe
    calls = [];
    expect(await pushProductToShops(p.id)).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("gibt es den Barcode im Shop schon, wird nur verbunden – nichts doppelt angelegt", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { p, vs } = await newProduct(`PUSH-${tag}-B`);
    existing = [{ id: `gid://shopify/ProductVariant/${tag}99`, sku: "anders", barcode: vs[0].barcode!, displayName: "Kamm (Shop)", inventoryItem: { id: `gid://shopify/InventoryItem/${tag}99`, tracked: true } }];
    expect(await pushProductToShops(p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "linked" }]);
    expect(calls.some((c) => c.query?.includes("productSet"))).toBe(false);
    const [row] = await db.select().from(schema.shopVariants).where(eq(schema.shopVariants.shopVariantId, existing[0].id));
    expect(row).toMatchObject({ variantId: vs[0].id, matchedBy: "barcode" });
  });

  it("gibt es den Barcode im Shop schon, braucht das Verbinden keine Shop-Kategorie", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { p, vs } = await newProduct(`PUSH-${tag}-M`, { category: `Unbekannt ${tag}` });
    existing = [{ id: `gid://shopify/ProductVariant/${tag}98`, sku: "x", barcode: vs[0].barcode!, displayName: "Kamm (Shop)", inventoryItem: { id: `gid://shopify/InventoryItem/${tag}98`, tracked: true } }];
    expect(await pushProductToShops(p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "linked" }]);
  });

  it("ohne Einzelhandelspreis wird nichts angelegt; fehlende Rechte werden klar gemeldet (Token einmal neu geholt)", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const a = await newProduct(`PUSH-${tag}-C`, { retail: 0 });
    expect(await pushProductToShops(a.p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "failed", reason: "noPrice" }]);

    denyProducts = true;
    const b = await newProduct(`PUSH-${tag}-D`);
    calls = [];
    expect(await pushProductToShops(b.p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "failed", reason: "noWriteAccess" }]);
    expect(calls.filter((c) => c.query?.includes("productSet")).length).toBe(2);
    expect(calls.filter((c) => c.url.endsWith("/admin/oauth/access_token")).length).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(schema.shopVariants).where(eq(schema.shopVariants.variantId, b.vs[0].id))).length).toBe(0);
  });

  it("ohne Recht zum Veröffentlichen: angelegt, aber als „noch nicht sichtbar“ gemeldet", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    denyPublish = true;
    const { p } = await newProduct(`PUSH-${tag}-E`);
    expect(await pushProductToShops(p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "createdHidden", imagesFailed: false }]);
  });

  it("ohne Barcode oder mit unbekannter Kategorie wird nichts hochgeladen; nach Zuordnung der Kategorie schon", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const a = await newProduct(`PUSH-${tag}-G`, { barcodes: [null] });
    expect(await pushProductToShops(a.p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "failed", reason: "noBarcode" }]);
    const b = await newProduct(`PUSH-${tag}-H`, { category: `Kämme ${tag}` });
    expect(await pushProductToShops(b.p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "failed", reason: "unknownCategory" }]);
    expect(calls.some((c) => c.query?.includes("productSet"))).toBe(false);
    // „Barberstühle“ (Kollektion) gewählt → Produkttyp „Barberstuhl“
    const { setCategoryMapping } = await import("../src/lib/shopify/product-push");
    expect(await setCategoryMapping("GENERAL_SHOP", `Kämme ${tag}`, "Barberstuhl")).toBe(true);
    expect(await setCategoryMapping("GENERAL_SHOP", `Kämme ${tag}`, "Gibt es nicht")).toBe(false);
    expect(await pushProductToShops(b.p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "created", imagesFailed: false }]);
    const set = calls.find((c) => c.query?.includes("productSet"))!.variables!.input as Record<string, any>;
    expect(set.productType).toBe("Barberstuhl");
  });

  it("gibt es den Artikel im Shop schon, kommen nur die fehlenden Größen dazu (kein zweites Produkt)", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { p, vs } = await newProduct(`PUSH-${tag}-I`, { sizes: ["S", "M"] });
    const sid = `gid://shopify/ProductVariant/${tag}77`;
    existing = [{ id: sid, sku: vs[0].barcode!, barcode: vs[0].barcode!, displayName: "Kamm – S", inventoryItem: { id: `gid://shopify/InventoryItem/${tag}77`, tracked: true } }];
    shopProduct = { id: `gid://shopify/Product/${tag}7`, hasOnlyDefaultVariant: false, options: [{ name: "Größe", position: 1, optionValues: [{ name: "S" }] }],
      variants: { nodes: [{ id: sid, selectedOptions: [{ name: "Größe", value: "S" }] }] } };
    expect(await pushProductToShops(p.id, "u-test")).toEqual([{ channel: "GENERAL_SHOP", outcome: "updated", n: 1, imagesFailed: false }]);
    expect(calls.some((c) => c.query?.includes("productSet"))).toBe(false);
    expect(calls.some((c) => c.query?.includes("productOptionsCreate"))).toBe(false);
    const bulkCall = calls.find((c) => c.query?.includes("productVariantsBulkCreate"))!;
    expect(bulkCall.variables).toMatchObject({ productId: `gid://shopify/Product/${tag}7`, media: null, variants: [{
      optionValues: [{ optionName: "Größe", name: "M" }], price: "11.90", barcode: vs[1].barcode,
      inventoryItem: { sku: vs[1].barcode, tracked: true, cost: "4.00" }, inventoryQuantities: [{ locationId: "gid://shopify/Location/77", availableQuantity: 4 }] }] });
    const links = await db.select().from(schema.shopVariants).where(eq(schema.shopVariants.channel, "GENERAL_SHOP"));
    expect(links.find((l) => l.variantId === vs[0].id)).toMatchObject({ shopVariantId: sid, matchedBy: "barcode" });
    expect(links.find((l) => l.variantId === vs[1].id)).toMatchObject({ shopVariantId: `gid://shopify/ProductVariant/${tag}n0`, matchedBy: "created", lastPushedQty: 4 });
    expect((await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.entityId, p.id), eq(schema.auditLog.action, "shop_update")))).length).toBe(1);
  });

  it("Gewicht: neue Variante bekommt es beim Anlegen; geändertes Gewicht wird an verbundene Varianten gemeldet", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { pushWeights } = await import("../src/lib/shopify/weights");
    const { p, vs } = await newProduct(`PUSH-${tag}-N`, { sizes: ["S", "M"] });
    await db.update(schema.variants).set({ weightGrams: 1500 }).where(eq(schema.variants.id, vs[1].id));
    const sid = `gid://shopify/ProductVariant/${tag}66`;
    existing = [{ id: sid, sku: "x", barcode: vs[0].barcode!, displayName: "S", inventoryItem: { id: `gid://shopify/InventoryItem/${tag}66`, tracked: true } }];
    shopProduct = { id: `gid://shopify/Product/${tag}6`, hasOnlyDefaultVariant: false, options: [{ name: "Größe", position: 1, optionValues: [{ name: "S" }] }],
      variants: { nodes: [{ id: sid, selectedOptions: [{ name: "Größe", value: "S" }] }] } };
    expect(await pushProductToShops(p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "updated", n: 1, imagesFailed: false }]);
    const bulk = calls.find((c) => c.query?.includes("productVariantsBulkCreate"))!;
    expect((bulk.variables!.variants as any[])[0].inventoryItem.measurement).toEqual({ weight: { unit: "GRAMS", value: 1500 } });
    // Gewicht von S nachgetragen → nur an diese verbundene Variante
    calls = [];
    await db.update(schema.variants).set({ weightGrams: 250 }).where(eq(schema.variants.id, vs[0].id));
    expect(await pushWeights([vs[0].id], "GENERAL_SHOP")).toEqual([{ channel: "GENERAL_SHOP", updated: 1, failed: 0 }]);
    const upd = calls.filter((c) => c.query?.includes("inventoryItemUpdate"));
    expect(upd.map((c) => c.variables)).toEqual([{ id: `gid://shopify/InventoryItem/${tag}66`, input: { measurement: { weight: { unit: "GRAMS", value: 250 } } } }]);
    expect(await pushWeights([])).toEqual([]);
  });

  it("Shop-Produkt mit nur der Standard-Variante bekommt erst die Option „Farbe“, dann die neue Farbe", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { p, vs } = await newProduct(`PUSH-${tag}-J`, { colors: ["Rot", "Blau"] });
    const sid = `gid://shopify/ProductVariant/${tag}88`;
    existing = [{ id: sid, sku: "x", barcode: vs[0].barcode!, displayName: "Kamm", inventoryItem: { id: `gid://shopify/InventoryItem/${tag}88`, tracked: true } }];
    shopProduct = { id: `gid://shopify/Product/${tag}8`, hasOnlyDefaultVariant: true, options: [{ name: "Title", position: 1, optionValues: [{ name: "Default Title" }] }],
      variants: { nodes: [{ id: sid, selectedOptions: [{ name: "Title", value: "Default Title" }] }] } };
    expect(await pushProductToShops(p.id)).toEqual([{ channel: "GENERAL_SHOP", outcome: "updated", n: 1, imagesFailed: false }]);
    const opt = calls.find((c) => c.query?.includes("productOptionsCreate"))!;
    expect(opt.variables).toEqual({ productId: `gid://shopify/Product/${tag}8`, options: [{ name: "Farbe", values: [{ name: "Rot" }] }] });
    const bulkCall = calls.find((c) => c.query?.includes("productVariantsBulkCreate"))!;
    expect((bulkCall.variables!.variants as any[])[0].optionValues).toEqual([{ optionName: "Farbe", name: "Blau" }]);
    // Reihenfolge: erst Optionen, dann Varianten
    expect(calls.findIndex((c) => c.query?.includes("productOptionsCreate"))).toBeLessThan(calls.findIndex((c) => c.query?.includes("productVariantsBulkCreate")));
  });

  it("Liste „Noch nicht im Shop“, „Nicht für diesen Shop“ und „Alle hochladen“", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { pendingProducts, unlistProduct, startBulkPush, bulkPushStatus } = await import("../src/lib/shopify/product-push");
    const ok1 = await newProduct(`PUSH-${tag}-K1`);
    const ok2 = await newProduct(`PUSH-${tag}-K2`, { sizes: ["S", "M"] });
    const bad = await newProduct(`PUSH-${tag}-K3`, { barcodes: [null] });
    const gone = await newProduct(`PUSH-${tag}-K4`);
    const mine = new Set([ok1.p.id, ok2.p.id, bad.p.id, gone.p.id]);
    let list = (await pendingProducts("GENERAL_SHOP")).filter((x) => mine.has(x.id));
    expect(list.map((x) => [x.sku, x.kind, x.missing, x.storeType, x.blockers]).sort()).toEqual([
      [`PUSH-${tag}-K1`, "new", 1, "Werkzeug & Zubehör", []],
      [`PUSH-${tag}-K2`, "new", 2, "Werkzeug & Zubehör", []],
      [`PUSH-${tag}-K3`, "new", 1, "Werkzeug & Zubehör", ["noBarcode"]],
      [`PUSH-${tag}-K4`, "new", 1, "Werkzeug & Zubehör", []],
    ].sort());
    await unlistProduct("GENERAL_SHOP", gone.p.id, "u-test");
    expect((await db.query.products.findFirst({ where: eq(schema.products.id, gone.p.id) }))!.inGeneralShop).toBe(false);

    const st = await startBulkPush("GENERAL_SHOP", "u-test", [...mine]);
    expect(st).toMatchObject({ running: true, total: 2, skipped: 1 });
    for (let i = 0; i < 100 && bulkPushStatus("GENERAL_SHOP")?.running; i++) await new Promise((r) => setTimeout(r, 50));
    expect(bulkPushStatus("GENERAL_SHOP")).toMatchObject({ running: false, done: 2, created: 2, failed: 0, skipped: 1 });
    list = (await pendingProducts("GENERAL_SHOP")).filter((x) => mine.has(x.id));
    expect(list.map((x) => x.sku)).toEqual([`PUSH-${tag}-K3`]);
  });

  it("nicht angehakt oder Shop nicht eingerichtet → nichts passiert", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const a = await newProduct(`PUSH-${tag}-F`, { general: false, brand: true });
    expect(await pushProductToShops(a.p.id)).toEqual([]);
    expect(calls.length).toBe(0);
  });
});
