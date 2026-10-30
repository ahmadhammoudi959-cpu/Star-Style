import "server-only";
/**
 * Fehlende Artikel aus einem Shopify-Shop anlegen (beim Start oder später für neue Shop-Produkte).
 * - vorhanden = Shop-Variante schon zugeordnet (automatisch oder von Hand), gleicher Barcode oder gleiche Art.-Nr.
 *   → Artikel bleibt unverändert (fehlt ihm ein Foto, wird das Shop-Foto ergänzt; nicht bei Treffer nur über die Art.-Nr.)
 * - Bestand 0 (Ware kommt nur über den Wareneingang), Preise netto, Großhandelspreis = Einzelhandelspreis
 * - jede neue Variante wird direkt mit ihrer Shop-Variante verbunden (matched_by „import“), auch ohne Barcode
 * - Fotos lädt der Server danach im Hintergrund
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, getShop, ShopifyError, type ShopChannel } from "./client";
import { groupByProduct, mapShopProduct, type ProductDraft, type ShopImportVariant } from "./product-map";
import { logEvent, syncProducts } from "./sync";
import { audit } from "../stock";
import { storeImageBytes } from "../files";

const VARIANTS_Q = `query($after: String) { productVariants(first: 50, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id sku barcode price position selectedOptions { name value } inventoryItem { unitCost { amount } }
    product { id title handle productType vendor status isGiftCard options { name position }
      featuredMedia { preview { image { url(transform: { maxWidth: 800, maxHeight: 800, preferredContentType: WEBP }) } } } } } } }`;

export type ImportResult = { created: number; variants: number; existing: number; noBarcode: number; failed: number; images: number; matched: number; open: number };
type ImageJob = { productId: string; url: string; name: string };

// Ein Import gleichzeitig (eine Server-Instanz); bleibt gesperrt, bis auch die Fotos geladen sind
let running = false;

export async function importProducts(channel: ShopChannel, o: { userId?: string; waitForImages?: boolean } = {}): Promise<ImportResult> {
  if (running) throw new Error("busy");
  running = true;
  let release = true;
  try {
    const shop = await getShop(channel);
    if (!shop || !shop.domain) throw new ShopifyError("notConfigured", "Shop nicht eingerichtet");
    const info = await gql<{ shop: { currencyCode: string; taxesIncluded: boolean } }>(shop, `{ shop { currencyCode taxesIncluded } }`);
    if (info.shop.currencyCode !== "EUR") throw new Error("currency");

    const nodes: ShopImportVariant[] = [];
    let after: string | null = null;
    do {
      const d: { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ShopImportVariant[] } } = await gql(shop, VARIANTS_Q, { after });
      nodes.push(...d.productVariants.nodes);
      after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
    } while (after);
    const drafts = groupByProduct(nodes).map((g) => mapShopProduct(g, { taxesIncluded: info.shop.taxesIncluded }));

    // Zuerst die Zuordnung auffrischen: was schon verbunden ist (Barcode, Art.-Nr. oder von Hand), gilt als vorhanden
    await syncProducts(channel);
    const linkOwner = new Map<string, string>((await db.select({ s: schema.shopVariants.shopVariantId, p: schema.variants.productId })
      .from(schema.shopVariants).innerJoin(schema.variants, eq(schema.variants.id, schema.shopVariants.variantId))
      .where(eq(schema.shopVariants.channel, channel))).map((r) => [r.s, r.p]));

    // Bestehende Artikel, Barcodes und Lieferanten (Lieferant = Hersteller/Vendor mit gleichem Namen, sonst leer)
    const products = await db.select({ id: schema.products.id, sku: schema.products.sku, imageFileId: schema.products.imageFileId }).from(schema.products);
    const skuOwner = new Map<string, string>(products.map((p) => [p.sku.toLowerCase(), p.id]));
    const usedSkus = new Set<string>(skuOwner.keys());
    const hasImage = new Map<string, boolean>(products.map((p) => [p.id, Boolean(p.imageFileId)]));
    const barcodeOwner = new Map<string, string>((await db.select({ barcode: schema.variants.barcode, productId: schema.variants.productId }).from(schema.variants)
      .where(isNotNull(schema.variants.barcode))).map((v) => [v.barcode!, v.productId]));
    const supplierByName = new Map<string, string>((await db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers))
      .map((s) => [s.name.trim().toLowerCase(), s.id]));

    let created = 0, variants = 0, noBarcode = 0, failed = 0;
    const existing = new Set<string>();
    const images: ImageJob[] = [];
    const links: [string, string][] = []; // [Shop-Variante, unsere Variante]

    for (const d of drafts) {
      const sure = d.variants.map((v) => linkOwner.get(v.shopVariantId) ?? (v.barcode ? barcodeOwner.get(v.barcode) : undefined)).find((x): x is string => Boolean(x));
      const owner = sure ?? skuOwner.get(d.sku.toLowerCase());
      if (owner) {
        existing.add(owner);
        // fehlendes Foto nur ergänzen, wenn sicher derselbe Artikel (Zuordnung oder Barcode)
        if (sure && d.imageUrl && !hasImage.get(owner)) { images.push({ productId: owner, url: d.imageUrl, name: d.handle }); hasImage.set(owner, true); }
        continue;
      }
      try {
        const r = await createProduct(d, channel, { usedSkus, barcodeOwner, supplierId: supplierByName.get(d.vendor.toLowerCase()) ?? null, userId: o.userId });
        created++; variants += r.links.length; noBarcode += r.noBarcode;
        links.push(...r.links);
        if (d.imageUrl) images.push({ productId: r.id, url: d.imageUrl, name: d.handle });
      } catch (e) {
        failed++;
        console.error("shopify import", d.handle, e);
        const err = e as { code?: string; cause?: { code?: string } };
        await logEvent(channel, "warn", "import", (err.code ?? err.cause?.code) === "23505" ? "importFailed:dup" : "importFailed:other", d.handle);
      }
    }
    await flagExisting([...existing], channel, o.userId);
    await logEvent(channel, failed ? "warn" : "info", "import", `productsImported:${created}|${variants}|${existing.size}|${noBarcode}`);

    // Neue Artikel direkt mit ihren Shop-Varianten verbinden (auch ohne Barcode; ersetzt eine evtl. falsche Zuordnung per Art.-Nr.)
    if (links.length) {
      await syncProducts(channel);
      await db.transaction(async (tx) => {
        for (const [s, v] of links) {
          await tx.update(schema.shopVariants).set({ variantId: v, matchedBy: "import", lastPushedQty: null })
            .where(and(eq(schema.shopVariants.channel, channel), eq(schema.shopVariants.shopVariantId, s)));
        }
      });
    }
    const counts = (await db.execute<{ matched: number; open: number }>(sql`
      select count(*) filter (where variant_id is not null)::int as matched, count(*) filter (where variant_id is null and tracked)::int as open
      from shop_variants where channel = ${channel}`)).rows[0];

    if (images.length) {
      release = false;
      const job = loadImages(channel, images, o.userId).finally(() => { running = false; });
      if (o.waitForImages) await job; else void job.catch((e) => console.error("shopify import images", e));
    }
    return { created, variants, existing: existing.size, noBarcode, failed, images: images.length, matched: counts?.matched ?? 0, open: counts?.open ?? 0 };
  } finally {
    if (release) running = false;
  }
}

async function createProduct(d: ProductDraft, channel: ShopChannel, c: { usedSkus: Set<string>; barcodeOwner: Map<string, string>; supplierId: string | null; userId?: string }) {
  // Art.-Nr. eindeutig halten (z. B. gleiche SKU bei zwei Shop-Produkten)
  let sku = d.sku;
  for (let k = 2; c.usedSkus.has(sku.toLowerCase()); k++) sku = `${d.sku.slice(0, 58)}-${k}`;
  const values = {
    sku, nameDe: d.nameDe, category: d.category, supplierId: c.supplierId, vatRateBp: d.vatRateBp,
    purchasePriceCents: d.purchasePriceCents, wholesalePriceCents: d.retailPriceCents, retailPriceCents: d.retailPriceCents,
    inBrandShop: channel === "BRAND_SHOP", inGeneralShop: channel === "GENERAL_SHOP",
  };
  const taken = new Set<string>();
  const rows = d.variants.map((v) => {
    const barcode = v.barcode && !c.barcodeOwner.has(v.barcode) && !taken.has(v.barcode) ? v.barcode : null;
    if (barcode) taken.add(barcode);
    return { shopVariantId: v.shopVariantId, size: v.size, color: v.color, barcode, wholesalePriceCents: v.priceCents, retailPriceCents: v.priceCents };
  });
  const r = await db.transaction(async (tx) => {
    const [p] = await tx.insert(schema.products).values(values).returning({ id: schema.products.id });
    const vs = await tx.insert(schema.variants).values(rows.map(({ shopVariantId: _s, ...x }) => ({ productId: p.id, ...x })))
      .returning({ id: schema.variants.id, size: schema.variants.size, color: schema.variants.color });
    await audit(tx, { entity: "product", entityId: p.id, action: "import", after: { ...values, source: channel, handle: d.handle, variants: rows }, userId: c.userId });
    const byKey = new Map<string, string>(vs.map((v) => [`${v.size}|${v.color}`, v.id]));
    return { id: p.id, links: rows.map((x) => [x.shopVariantId, byKey.get(`${x.size}|${x.color}`)!] as [string, string]) };
  });
  // erst nach erfolgreichem Speichern als belegt merken
  c.usedSkus.add(sku.toLowerCase());
  for (const b of taken) c.barcodeOwner.set(b, r.id);
  return { id: r.id, links: r.links, noBarcode: rows.filter((x) => !x.barcode).length };
}

/** Vorhandene Artikel als „im Shop sichtbar“ markieren (nur Hinweis, die echte Verbindung ist die Zuordnung) */
async function flagExisting(ids: string[], channel: ShopChannel, userId?: string) {
  if (!ids.length) return;
  const col = channel === "BRAND_SHOP" ? schema.products.inBrandShop : schema.products.inGeneralShop;
  const todo = (await db.select({ id: schema.products.id }).from(schema.products).where(and(inArray(schema.products.id, ids), eq(col, false)))).map((r) => r.id);
  if (!todo.length) return;
  const set = channel === "BRAND_SHOP" ? { inBrandShop: true } : { inGeneralShop: true };
  await db.transaction(async (tx) => {
    await tx.update(schema.products).set(set).where(inArray(schema.products.id, todo));
    for (const id of todo) await audit(tx, { entity: "product", entityId: id, action: "update", after: { ...set, source: channel }, userId });
  });
}

/** Nur Bilder vom Shopify-CDN (bzw. vom Test-Nachbau) laden */
const allowedImage = (url: string) => url.startsWith("https://cdn.shopify.com/") || Boolean(process.env.SHOPIFY_MOCK_URL && url.startsWith(process.env.SHOPIFY_MOCK_URL));

async function loadImages(channel: ShopChannel, jobs: ImageJob[], userId?: string) {
  let ok = 0, bad = 0;
  const queue = jobs.filter((j) => allowedImage(j.url));
  bad += jobs.length - queue.length;
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      try {
        // inzwischen von Hand ein Foto gesetzt? Dann nichts tun
        const [cur] = await db.select({ img: schema.products.imageFileId }).from(schema.products).where(eq(schema.products.id, j.productId));
        if (!cur || cur.img) continue;
        const res = await fetch(j.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fileId = await storeImageBytes(Buffer.from(await res.arrayBuffer()), `${j.name}.webp`);
        const done = await db.transaction(async (tx) => {
          const r = await tx.update(schema.products).set({ imageFileId: fileId })
            .where(and(eq(schema.products.id, j.productId), isNull(schema.products.imageFileId))).returning({ id: schema.products.id });
          if (r.length) await audit(tx, { entity: "product", entityId: j.productId, action: "update", after: { imageFileId: fileId, source: channel }, userId });
          return r.length > 0;
        });
        if (done) ok++;
        else await db.delete(schema.storedFiles).where(eq(schema.storedFiles.id, fileId)); // Foto wurde gerade von Hand gesetzt → unbenutzte Datei weg
      } catch { bad++; }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await logEvent(channel, bad ? "warn" : "info", "import", `imagesLoaded:${ok}|${bad}`);
}
