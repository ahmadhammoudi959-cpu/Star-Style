import "server-only";
/**
 * Artikel beim Speichern im Shop anlegen (Wunsch Inhaber 03.11.2026): „Sichtbar in“ angehakt und der Artikel ist dort noch nicht verbunden.
 * - Gibt es im Shop schon ein Produkt mit gleichem Barcode (bei einer Variante auch gleicher Art.-Nr.) → nur verbinden, nichts doppelt anlegen.
 * - Sonst: Fotos hochladen (staged upload), Produkt mit Größe/Farbe, Preisen (Einzelhandel, bei Brutto-Shops inkl. MwSt.), Barcodes,
 *   Art.-Nr. und verfügbarem Bestand am Lagerort anlegen (productSet), im Online Store veröffentlichen, Varianten direkt zuordnen
 *   (matched_by „created“).
 * - Shops ohne Zugangsdaten werden still übersprungen (Firmen ohne Shopify).
 * - Spätere Änderungen am Artikel (Preis, Name, neue Varianten) werden NICHT übertragen – der Shop-Text kann dort gepflegt werden.
 * Rechte der Shopify-App: write_products (Produkt, Fotos), write_publications (Veröffentlichen), write_inventory (Bestand).
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, getShop, ShopifyError, type Shop, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { audit } from "../stock";
import { buildProductSet, matchCreatedVariants, type PushImage, type PushProduct, type PushReason, type PushResult } from "./product-push-map";

export { decodePush, encodePush, type PushResult } from "./product-push-map";

class PushError extends Error {
  constructor(public reason: PushReason, message = reason) { super(message); }
}

// Ein Artikel je Shop nie gleichzeitig zweimal anlegen (z. B. doppelt auf Speichern gedrückt)
const busy = new Set<string>();

/** Nach dem Speichern eines Artikels aufrufen. Liefert je angehaktem, verbundenem Shop ein Ergebnis (nichts, wenn schon alles verbunden ist). */
export async function pushProductToShops(productId: string, userId?: string): Promise<PushResult[]> {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p) return [];
  const out: PushResult[] = [];
  for (const channel of CHANNELS) {
    if (!(channel === "BRAND_SHOP" ? p.inBrandShop : p.inGeneralShop)) continue;
    const shop = await getShop(channel);
    if (!shop?.domain || !(shop.clientSecretEnc || shop.staticTokenEnc)) continue; // Shop nicht eingerichtet
    const key = `${channel}:${productId}`;
    if (busy.has(key)) continue;
    busy.add(key);
    try {
      const r = await pushToShop(shop, channel, productId, userId);
      if (r) out.push(r);
    } catch (e) {
      const reason: PushReason = e instanceof PushError ? e.reason : isAccessDenied(e) ? "noWriteAccess" : "other";
      console.error("shopify push", channel, productId, e);
      await logEvent(channel, "error", "products", `createFailed:${p.nameDe} – ${(e as Error).message}`.slice(0, 1000), p.sku);
      out.push({ channel, outcome: "failed", reason });
    } finally {
      busy.delete(key);
    }
  }
  return out;
}

const isAccessDenied = (e: unknown) => e instanceof ShopifyError && /access denied|write_products/i.test(e.message);

/** Fehlt ein Recht, kann der zwischengespeicherte Token noch aus der Zeit vor der Freigabe stammen → einmal neu holen. */
async function withFreshToken<T>(shop: Shop, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ShopifyError) || !/access denied/i.test(e.message) || shop.staticTokenEnc) throw e;
    shop.tokenEnc = ""; shop.tokenExpiresAt = null;
    await db.update(schema.shops).set({ tokenEnc: "", tokenExpiresAt: null }).where(eq(schema.shops.channel, shop.channel));
    return run();
  }
}

async function loadProduct(productId: string, buffer: number): Promise<PushProduct | null> {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId), with: { supplier: true } });
  if (!p) return null;
  const vs = await db.select().from(schema.variants)
    .where(and(eq(schema.variants.productId, productId), eq(schema.variants.active, true))).orderBy(asc(schema.variants.createdAt));
  if (!vs.length) return null;
  // verfügbar wie beim Bestandsabgleich: Lager − Reservierungen − Puffer
  const avail = new Map((await db.execute<{ id: string; available: number }>(sql`
    select v.id, greatest(0, v.stock_qty - coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0) - ${buffer})::int as available
    from variants v where v.product_id = ${productId} and v.active`)).rows.map((r) => [r.id, Number(r.available)]));
  return {
    id: p.id, sku: p.sku, nameDe: p.nameDe, descriptionDe: p.descriptionDe, category: p.category, vendor: p.supplier?.name ?? "",
    vatRateBp: p.vatRateBp, retailPriceCents: p.retailPriceCents, purchasePriceCents: p.purchasePriceCents,
    imageFileId: p.imageFileId,
    variants: vs.map((v) => ({
      id: v.id, size: v.size, color: v.color, barcode: v.barcode, retailPriceCents: v.retailPriceCents,
      imageFileId: v.imageFileId, available: avail.get(v.id) ?? 0,
    })),
  };
}

async function pushToShop(shop: Shop, channel: ShopChannel, productId: string, userId?: string): Promise<PushResult | null> {
  const p = await loadProduct(productId, shop.stockBuffer);
  if (!p) return null;
  const ids = p.variants.map((v) => v.id);
  const linked = new Set((await db.select({ v: schema.shopVariants.variantId }).from(schema.shopVariants)
    .where(and(eq(schema.shopVariants.channel, channel), inArray(schema.shopVariants.variantId, ids)))).map((r) => r.v!));
  if (linked.size === ids.length) return null; // schon im Shop
  if (linked.size > 0) return { channel, outcome: "partial", missing: ids.length - linked.size };
  if (!shop.locationId) throw new PushError("noLocation");

  // 1) Gibt es das Produkt im Shop schon? Dann nur verbinden.
  const found = await linkExisting(shop, channel, p);
  if (found.linked > 0) {
    await logEvent(channel, "info", "products", `linkedExisting:${p.nameDe}`, p.sku);
    return found.linked === ids.length ? { channel, outcome: "linked" } : { channel, outcome: "partial", missing: ids.length - found.linked };
  }
  if (found.elsewhere) throw new PushError("duplicate");

  if (p.retailPriceCents <= 0 && p.variants.some((v) => !v.retailPriceCents)) throw new PushError("noPrice");
  const info = await gql<{ shop: { currencyCode: string; taxesIncluded: boolean } }>(shop, `{ shop { currencyCode taxesIncluded } }`);
  if (info.shop.currencyCode !== "EUR") throw new PushError("currency");

  // 2) Fotos hochladen – geht das schief, wird das Produkt trotzdem angelegt
  let images = new Map<string, PushImage>(), imagesFailed = false;
  try { images = await withFreshToken(shop, () => uploadImages(shop, p)); }
  catch (e) { imagesFailed = true; console.error("shopify push images", productId, e); }

  // 3) Produkt anlegen
  const input = buildProductSet(p, { taxesIncluded: info.shop.taxesIncluded, locationId: shop.locationId, images });
  const d = await withFreshToken(shop, () => gql<ProductSetData>(shop, PRODUCT_SET_M, { input }));
  if (d.productSet.userErrors.length || !d.productSet.product) {
    throw new ShopifyError("userErrors", d.productSet.userErrors.map((e) => e.message).join("; ").slice(0, 500) || "productSet");
  }
  const created = d.productSet.product;

  // 4) Varianten zuordnen (Bestand wurde beim Anlegen gesetzt → als gemeldet merken)
  const map = matchCreatedVariants(p.variants, created.variants.nodes);
  const ours = new Map([...map.entries()].map(([v, s]) => [s, v]));
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const n of created.variants.nodes) {
      const variantId = ours.get(n.id) ?? null;
      const qty = p.variants.find((v) => v.id === variantId)?.available ?? null;
      const row = {
        inventoryItemId: n.inventoryItem?.id ?? "", title: n.displayName.slice(0, 300), sku: (n.sku ?? "").trim(), barcode: (n.barcode ?? "").trim(),
        tracked: n.inventoryItem?.tracked ?? true, variantId, matchedBy: variantId ? "created" : "", lastPushedQty: qty, lastPushedAt: now, pushError: "", seenAt: now,
      };
      await tx.insert(schema.shopVariants).values({ channel, shopVariantId: n.id, ...row })
        .onConflictDoUpdate({ target: [schema.shopVariants.channel, schema.shopVariants.shopVariantId], set: row });
    }
    await audit(tx, { entity: "product", entityId: p.id, action: "shop_create", after: { channel, shopProductId: created.id, handle: created.handle, variants: Object.fromEntries(map) }, userId });
  });

  // 5) Im Online Store veröffentlichen
  let visible = false;
  try { visible = await withFreshToken(shop, () => publish(shop, created.id)); }
  catch (e) { console.error("shopify push publish", productId, e); }
  await logEvent(channel, visible ? "info" : "warn", "products", `${visible ? "created" : "createdHidden"}:${p.nameDe}`, p.sku);
  if (imagesFailed) await logEvent(channel, "warn", "products", `imagesFailedFor:${p.nameDe}`, p.sku);
  return { channel, outcome: visible ? "created" : "createdHidden", imagesFailed };
}

// ───────────────────────── vorhandenes Shop-Produkt finden ─────────────────────────

const SEARCH_Q = `query($q: String!) { productVariants(first: 50, query: $q) {
  nodes { id sku barcode displayName inventoryItem { id tracked } } } }`;
type FoundVariant = { id: string; sku: string | null; barcode: string | null; displayName: string; inventoryItem: { id: string; tracked: boolean } | null };

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Shop nach gleichem Barcode (bzw. Art.-Nr. bei Artikeln mit einer Variante) durchsuchen und verbinden. */
async function linkExisting(shop: Shop, channel: ShopChannel, p: PushProduct): Promise<{ linked: number; elsewhere: boolean }> {
  const single = p.variants.length === 1;
  const terms = [...p.variants.flatMap((v) => (v.barcode ? [`barcode:${quote(v.barcode)}`] : [])), ...(single ? [`sku:${quote(p.sku)}`] : [])];
  if (!terms.length) return { linked: 0, elsewhere: false };
  const d = await gql<{ productVariants: { nodes: FoundVariant[] } }>(shop, SEARCH_Q, { q: terms.join(" OR ") });
  // Die Shopify-Suche ist unscharf → nur exakte Treffer zählen
  const pairs: [FoundVariant, string, "barcode" | "sku"][] = [];
  for (const n of d.productVariants.nodes) {
    const bc = (n.barcode ?? "").trim();
    const byBarcode = bc ? p.variants.find((v) => v.barcode === bc) : undefined;
    if (byBarcode) { pairs.push([n, byBarcode.id, "barcode"]); continue; }
    if (single && (n.sku ?? "").trim().toLowerCase() === p.sku.toLowerCase()) pairs.push([n, p.variants[0].id, "sku"]);
  }
  if (!pairs.length) return { linked: 0, elsewhere: false };
  const existing = new Map((await db.select({ s: schema.shopVariants.shopVariantId, v: schema.shopVariants.variantId }).from(schema.shopVariants)
    .where(and(eq(schema.shopVariants.channel, channel), isNotNull(schema.shopVariants.variantId),
      inArray(schema.shopVariants.shopVariantId, pairs.map(([n]) => n.id))))).map((r) => [r.s, r.v!]));
  const used = new Set<string>();
  let linked = 0, elsewhere = false;
  for (const [n, variantId, by] of pairs) {
    const owner = existing.get(n.id);
    if (owner && owner !== variantId) { elsewhere = true; continue; }
    if (used.has(variantId)) continue; // eine unserer Varianten nur einmal verbinden
    used.add(variantId);
    const row = { inventoryItemId: n.inventoryItem?.id ?? "", title: n.displayName.slice(0, 300), sku: (n.sku ?? "").trim(), barcode: (n.barcode ?? "").trim(), tracked: n.inventoryItem?.tracked ?? false, seenAt: new Date() };
    await db.insert(schema.shopVariants).values({ channel, shopVariantId: n.id, ...row, variantId, matchedBy: by })
      .onConflictDoUpdate({ target: [schema.shopVariants.channel, schema.shopVariants.shopVariantId], set: { ...row, variantId, matchedBy: by, lastPushedQty: null } });
    await db.execute(sql`insert into stock_dirty (variant_id) values (${variantId}) on conflict (variant_id) do update set at = now()`);
    linked++;
  }
  return { linked, elsewhere };
}

// ───────────────────────── Fotos ─────────────────────────

const STAGED_M = `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
  stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "foto";

async function uploadImages(shop: Shop, p: PushProduct): Promise<Map<string, PushImage>> {
  const ids = [...new Set([p.imageFileId, ...p.variants.map((v) => v.imageFileId)].filter((x): x is string => Boolean(x)))];
  const out = new Map<string, PushImage>();
  if (!ids.length) return out;
  const files = (await db.select().from(schema.storedFiles).where(inArray(schema.storedFiles.id, ids))).filter((f) => EXT[f.mime]);
  if (!files.length) return out;
  const names = files.map((f, i) => `${slug(p.sku)}-${i + 1}.${EXT[f.mime]}`);
  const d = await gql<{ stagedUploadsCreate: { stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[]; userErrors: { message: string }[] } }>(
    shop, STAGED_M, { input: files.map((f, i) => ({ resource: "IMAGE", filename: names[i], mimeType: f.mime, httpMethod: "POST", fileSize: String(f.size) })) });
  if (d.stagedUploadsCreate.userErrors.length) throw new ShopifyError("userErrors", d.stagedUploadsCreate.userErrors.map((e) => e.message).join("; "));
  for (const [i, t] of d.stagedUploadsCreate.stagedTargets.entries()) {
    const f = files[i];
    const form = new FormData();
    for (const prm of t.parameters) form.append(prm.name, prm.value);
    form.append("file", new Blob([new Uint8Array(f.data)], { type: f.mime }), names[i]);
    const res = await fetch(t.url, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
    out.set(f.id, { resourceUrl: t.resourceUrl, filename: names[i] });
  }
  return out;
}

// ───────────────────────── Anlegen und Veröffentlichen ─────────────────────────

const PRODUCT_SET_M = `mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) {
  product { id handle variants(first: 250) { nodes { id sku barcode displayName selectedOptions { name value } inventoryItem { id tracked } } } }
  userErrors { field message code } } }`;
type ProductSetData = { productSet: {
  product: { id: string; handle: string; variants: { nodes: (FoundVariant & { selectedOptions: { name: string; value: string }[] })[] } } | null;
  userErrors: { field: string[] | null; message: string; code: string | null }[];
} };

// Veröffentlichung „Online Store“ je Shop (ändert sich praktisch nie)
const publicationIds = new Map<string, string>();

async function publish(shop: Shop, productId: string): Promise<boolean> {
  const key = `${shop.channel}:${shop.domain}`;
  let pub = publicationIds.get(key);
  if (!pub) {
    const d = await gql<{ publications: { nodes: { id: string; catalog: { title: string } | null }[] } }>(shop,
      `{ publications(first: 50, catalogType: APP) { nodes { id catalog { title } } } }`);
    pub = d.publications.nodes.find((n) => /online store/i.test(n.catalog?.title ?? ""))?.id;
    if (!pub) return false;
    publicationIds.set(key, pub);
  }
  const r = await gql<{ publishablePublish: { userErrors: { message: string }[] } }>(shop,
    `mutation($id: ID!, $input: [PublicationInput!]!) { publishablePublish(id: $id, input: $input) { userErrors { field message } } }`,
    { id: productId, input: [{ publicationId: pub }] });
  if (r.publishablePublish.userErrors.length) throw new ShopifyError("userErrors", r.publishablePublish.userErrors.map((e) => e.message).join("; "));
  return true;
}

// ───────────────────────── Anzeige im Artikel-Formular ─────────────────────────

/** Welche Shops sind eingerichtet, und in welchen ist der Artikel schon verbunden? */
export async function productShopStatus(productId?: string) {
  const connected: Record<ShopChannel, boolean> = { BRAND_SHOP: false, GENERAL_SHOP: false };
  const linked: Record<ShopChannel, boolean> = { BRAND_SHOP: false, GENERAL_SHOP: false };
  for (const s of await db.select().from(schema.shops)) {
    if (s.domain && (s.clientSecretEnc || s.staticTokenEnc)) connected[s.channel as ShopChannel] = true;
  }
  if (productId) {
    const rows = await db.execute<{ channel: ShopChannel }>(sql`
      select distinct sv.channel from shop_variants sv join variants v on v.id = sv.variant_id where v.product_id = ${productId}`);
    for (const r of rows.rows) linked[r.channel] = true;
  }
  return { connected, linked };
}
