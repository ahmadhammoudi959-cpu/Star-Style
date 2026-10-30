import "server-only";
/**
 * Produkte aus einem Shopify-Shop als Artikel übernehmen (einmalig beim Start oder für neue Shop-Produkte).
 * - legt nur fehlende Artikel an; vorhanden = gleicher Barcode oder gleiche Art.-Nr. → bleibt unverändert
 * - Bestand 0 (Ware kommt nur über den Wareneingang), Preise netto, Großhandelspreis = Einzelhandelspreis
 * - danach automatische Zuordnung (syncProducts); Fotos werden im Hintergrund geladen
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
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

    for (const d of drafts) {
      const byBarcode = d.variants.map((v) => (v.barcode ? barcodeOwner.get(v.barcode) : undefined)).find((x): x is string => Boolean(x));
      const owner = byBarcode ?? skuOwner.get(d.sku.toLowerCase());
      if (owner) {
        existing.add(owner);
        if (d.imageUrl && !hasImage.get(owner)) { images.push({ productId: owner, url: d.imageUrl, name: d.handle }); hasImage.set(owner, true); }
        continue;
      }
      try {
        const r = await createProduct(d, channel, { usedSkus, barcodeOwner, supplierId: supplierByName.get(d.vendor.toLowerCase()) ?? null, userId: o.userId });
        created++; variants += r.variants; noBarcode += r.noBarcode;
        if (d.imageUrl) images.push({ productId: r.id, url: d.imageUrl, name: d.handle });
      } catch (e) {
        failed++;
        await logEvent(channel, "warn", "import", `importFailed:${(e as Error).message.slice(0, 200)}`, d.handle);
      }
    }
    await flagExisting([...existing], channel, o.userId);
    await logEvent(channel, failed ? "warn" : "info", "import", `productsImported:${created}|${variants}|${existing.size}|${noBarcode}`);

    // Jetzt gleich zuordnen (Barcode → Art.-Nr.), damit „nicht zugeordnet“ sofort stimmt
    const s = await syncProducts(channel);

    if (images.length) {
      release = false;
      const job = loadImages(channel, images, o.userId).finally(() => { running = false; });
      if (o.waitForImages) await job; else void job.catch((e) => console.error("shopify import images", e));
    }
    return { created, variants, existing: existing.size, noBarcode, failed, images: images.length, matched: s.matched, open: s.open };
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
    return { size: v.size, color: v.color, barcode, wholesalePriceCents: v.priceCents, retailPriceCents: v.priceCents };
  });
  const id = await db.transaction(async (tx) => {
    const [p] = await tx.insert(schema.products).values(values).returning({ id: schema.products.id });
    await tx.insert(schema.variants).values(rows.map((r) => ({ productId: p.id, ...r })));
    await audit(tx, { entity: "product", entityId: p.id, action: "import", after: { ...values, source: channel, handle: d.handle, variants: rows }, userId: c.userId });
    return p.id;
  });
  // erst nach erfolgreichem Speichern als belegt merken
  c.usedSkus.add(sku.toLowerCase());
  for (const b of taken) c.barcodeOwner.set(b, id);
  return { id, variants: rows.length, noBarcode: rows.filter((r) => !r.barcode).length };
}

/** Vorhandene Artikel als „im Shop sichtbar“ markieren (nur Hinweis, die echte Verbindung ist der Barcode) */
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
        const res = await fetch(j.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fileId = await storeImageBytes(Buffer.from(await res.arrayBuffer()), `${j.name}.webp`);
        // ein inzwischen von Hand gesetztes Foto nicht überschreiben
        const done = await db.transaction(async (tx) => {
          const r = await tx.update(schema.products).set({ imageFileId: fileId })
            .where(and(eq(schema.products.id, j.productId), isNull(schema.products.imageFileId))).returning({ id: schema.products.id });
          if (r.length) await audit(tx, { entity: "product", entityId: j.productId, action: "update", after: { imageFileId: fileId, source: channel }, userId });
          return r.length > 0;
        });
        if (done) ok++;
      } catch { bad++; }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  await logEvent(channel, bad ? "warn" : "info", "import", `imagesLoaded:${ok}|${bad}`);
}
