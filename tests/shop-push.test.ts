import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildProductSet, decodePush, descriptionHtml, encodePush, matchCreatedVariants, shopPriceCents, variantOptions, variantSku,
  type PushProduct, type PushVariant,
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
    expect(decodePush("GENERAL_SHOP.partial.2.0")).toEqual([{ channel: "GENERAL_SHOP", outcome: "partial", missing: 2, imagesFailed: false }]);
    expect(decodePush("EVIL.created..0~GENERAL_SHOP.hacked..0~GENERAL_SHOP.failed.<script>.0")).toEqual([]);
    expect(decodePush(undefined)).toEqual([]);
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
  let denyProducts = false, denyPublish = false;

  function shopifyMock() {
    return vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (url.endsWith("/admin/oauth/access_token")) { calls.push({ url }); return Response.json({ access_token: "tok", scope: "x", expires_in: 86399 }); }
      if (url.startsWith("https://staged.example/")) { calls.push({ url }); return new Response(null, { status: 204 }); }
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      calls.push({ url, query, variables });
      if (query.includes("productVariants(first: 50, query")) return Response.json({ data: { productVariants: { nodes: existing } } });
      if (query.includes("taxesIncluded")) return Response.json({ data: { shop: { currencyCode: "EUR", taxesIncluded: true } } });
      if (query.includes("stagedUploadsCreate")) {
        const input = variables.input as { filename: string }[];
        return Response.json({ data: { stagedUploadsCreate: { userErrors: [], stagedTargets: input.map((f) => ({
          url: `https://staged.example/upload/${f.filename}`, resourceUrl: `https://staged.example/res/${f.filename}`, parameters: [{ name: "key", value: f.filename }] })) } } });
      }
      if (query.includes("productSet")) {
        if (denyProducts) return Response.json({ errors: [{ message: "Access denied for productSet field. Required access: `write_products` access scope.", extensions: { code: "ACCESS_DENIED" } }] });
        const input = variables.input as { variants: { optionValues: { optionName: string; name: string }[]; barcode?: string; inventoryItem: { sku: string } }[] };
        return Response.json({ data: { productSet: { userErrors: [], product: { id: `gid://shopify/Product/${tag}`, handle: `p-${tag}`, variants: { nodes:
          input.variants.map((x, i) => ({ id: `gid://shopify/ProductVariant/${tag}${i}`, sku: x.inventoryItem.sku, barcode: x.barcode ?? null, displayName: `P ${i}`,
            selectedOptions: x.optionValues.map((o) => ({ name: o.optionName, value: o.name })), inventoryItem: { id: `gid://shopify/InventoryItem/${tag}${i}`, tracked: true } })).reverse() } } } } });
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

  async function newProduct(sku: string, o: { general?: boolean; brand?: boolean; barcodes?: (string | null)[]; sizes?: string[]; retail?: number; withImage?: boolean } = {}) {
    let imageFileId: string | null = null;
    if (o.withImage) {
      [{ id: imageFileId }] = await db.insert(schema.storedFiles).values({ name: "kamm.png", mime: "image/png", size: png.length, sha256: "x", data: Buffer.from(png) }).returning({ id: schema.storedFiles.id });
    }
    const [p] = await db.insert(schema.products).values({ sku, nameDe: `Kamm ${sku}`, vatRateBp: 1900, retailPriceCents: o.retail ?? 1000, purchasePriceCents: 400,
      inGeneralShop: o.general ?? true, inBrandShop: o.brand ?? false, imageFileId }).returning();
    const sizes = o.sizes ?? [""];
    const vs = [];
    for (const [i, size] of sizes.entries()) {
      const [row] = await db.insert(schema.variants).values({ productId: p.id, size, barcode: o.barcodes ? o.barcodes[i] : `43${tag}${String(i).padStart(2, "0")}${sku.slice(-1)}`, stockQty: 5 }).returning();
      vs.push(row);
    }
    return { p, vs };
  }

  beforeAll(async () => {
    const shop = { domain: "star-general.myshopify.com", clientId: "cid", clientSecretEnc: encrypt("geheim"), staticTokenEnc: "", tokenEnc: "", tokenExpiresAt: null,
      active: false, locationId: "gid://shopify/Location/77", stockBuffer: 1 };
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", ...shop }).onConflictDoUpdate({ target: schema.shops.channel, set: shop });
    // Marken-Shop ohne Zugangsdaten → wird still übersprungen
    const brand = { domain: "", clientId: "", clientSecretEnc: "", staticTokenEnc: "", tokenEnc: "", locationId: "" };
    await db.insert(schema.shops).values({ channel: "BRAND_SHOP", ...brand }).onConflictDoUpdate({ target: schema.shops.channel, set: brand });
  });
  afterEach(() => { vi.unstubAllGlobals(); calls = []; existing = []; denyProducts = false; denyPublish = false; });

  it("legt den Artikel mit Größen, Bruttopreis, Barcode, Bestand (minus Puffer) und Foto an, veröffentlicht ihn und verbindet die Varianten", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { p, vs } = await newProduct(`PUSH-${tag}-A`, { sizes: ["S", "M"], withImage: true, brand: true });
    const r = await pushProductToShops(p.id, "u-test");
    expect(r).toEqual([{ channel: "GENERAL_SHOP", outcome: "created", imagesFailed: false }]);

    const set = calls.find((c) => c.query?.includes("productSet"))!.variables!.input as Record<string, any>;
    expect(set.title).toBe(`Kamm PUSH-${tag}-A`);
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

  it("nicht angehakt oder Shop nicht eingerichtet → nichts passiert", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const a = await newProduct(`PUSH-${tag}-F`, { general: false, brand: true });
    expect(await pushProductToShops(a.p.id)).toEqual([]);
    expect(calls.length).toBe(0);
  });
});
