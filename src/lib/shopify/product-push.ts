import "server-only";
/**
 * Artikel in die Shops bringen (Wunsch Inhaber 03.11.2026) – nie ungefragt:
 * - Beim Speichern fragt das Formular „Echter Artikel – in den Shop hochladen?“, sobald dort noch etwas fehlt. „Nein“ → der Artikel
 *   steht in „Noch nicht im Shop“ (Shop-Seite, Startseite, Artikelliste) und kann später hochgeladen werden – einzeln oder alle auf einmal.
 * - Verbunden wird immer über den Barcode: jede neue Variante braucht einen.
 * - Gibt es im Shop schon Varianten mit unseren Barcodes (bei einer Variante auch gleiche Art.-Nr.) → nur verbinden, nichts doppelt.
 *   Fehlen dem Shop-Produkt Größen/Farben, werden genau diese ergänzt (productVariantsBulkCreate; hat es nur die Standard-Variante,
 *   bekommt es vorher die Optionen per productOptionsCreate).
 * - Sonst neues Produkt: die Kategorie muss es im Shop geben (Produkttyp → automatische Kollektion; gleicher Name oder vom Nutzer
 *   zugeordnet, `shops.category_map`), Einzelhandelspreis nötig. Fotos per staged upload, productSet, im Online Store veröffentlichen,
 *   Varianten direkt zuordnen (matched_by „created“).
 * - Shops ohne Zugangsdaten werden still übersprungen. Spätere Änderungen an Preis, Name, Beschreibung werden NICHT übertragen.
 * Rechte der Shopify-App: write_products (Produkt, Varianten, Fotos), write_publications (Veröffentlichen), write_inventory (Bestand).
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, getShop, ShopifyError, type Shop, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { audit } from "../stock";
import {
  buildProductSet, matchCreatedVariants, planVariantAdds, pushBlockers, resolveStoreType, shopPriceCents, shopWeight, storeTypesFrom, variantSku,
  type CollectionRules, type PushBlocker, type PushImage, type PushProduct, type PushReason, type PushResult, type ShopProductShape, type StoreType,
} from "./product-push-map";
import { configured, isAccessDenied, publishToOnlineStore, uploadImages, withFreshToken, withProductLock } from "./admin";
import { mapCreatedMedia, productFiles } from "./gallery-map";
import { syncGalleryLater } from "./gallery";

export { decodePush, encodePush, type PushResult, type StoreType } from "./product-push-map";

class PushError extends Error {
  constructor(public reason: PushReason, message: string = reason) { super(message); }
}

const flagCol = (channel: ShopChannel) => (channel === "BRAND_SHOP" ? "inBrandShop" : "inGeneralShop") as "inBrandShop" | "inGeneralShop";
const money = (cents: number) => (cents / 100).toFixed(2);

/** Nach dem Speichern, wenn der Nutzer „hochladen“ bestätigt hat: ein Ergebnis je angehaktem, eingerichtetem Shop, in dem noch etwas fehlt. */
export async function pushProductToShops(productId: string, userId?: string): Promise<PushResult[]> {
  const out: PushResult[] = [];
  for (const channel of await pushTargets(productId)) {
    const r = await pushProductToShop(channel, productId, userId);
    if (r) out.push(r);
  }
  return out;
}

/** In welchen angehakten, eingerichteten Shops fehlt dieser Artikel noch ganz oder teilweise? */
export async function pushTargets(productId: string): Promise<ShopChannel[]> {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p?.active) return [];
  const out: ShopChannel[] = [];
  for (const channel of CHANNELS) {
    if (!p[flagCol(channel)] || !configured(await getShop(channel))) continue;
    const r = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from variants v where v.product_id = ${productId} and v.active
        and not exists (select 1 from shop_variants sv where sv.channel = ${channel} and sv.variant_id = v.id)`);
    if (Number(r.rows[0]?.n ?? 0) > 0) out.push(channel);
  }
  return out;
}

/** Einen Artikel in einen Shop bringen. null = nichts zu tun (schon vollständig dort, nicht angehakt, Shop nicht eingerichtet). */
export async function pushProductToShop(channel: ShopChannel, productId: string, userId?: string): Promise<PushResult | null> {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p || !p[flagCol(channel)]) return null;
  const shop = await getShop(channel);
  if (!configured(shop)) return null;
  // nie zweimal gleichzeitig (Speichern, „Alle hochladen“, Galerie) – der zweite Vorgang wartet und findet dann alles erledigt
  const r = await withProductLock(`${channel}:${productId}`, async (): Promise<PushResult | null> => {
    try {
      return await pushToShop(shop, channel, productId, userId);
    } catch (e) {
      const known = e instanceof PushError;
      const reason: PushReason = known ? e.reason : isAccessDenied(e) ? "noWriteAccess" : "other";
      if (!known) console.error("shopify push", channel, productId, e);
      await logEvent(channel, known ? "warn" : "error", "products",
        known ? `pushBlocked:${reason}|${p.nameDe}` : `createFailed:${p.nameDe} – ${(e as Error).message}`.slice(0, 1000), p.sku);
      return { channel, outcome: "failed", reason };
    }
  });
  // war das Produkt schon im Shop (verbunden/ergänzt): eigene Shop-Fotos jetzt im Hintergrund dazu
  if (r?.outcome === "linked" || r?.outcome === "updated") syncGalleryLater(productId, [channel]);
  return r;
}

async function loadProduct(productId: string, buffer: number, channel: ShopChannel): Promise<PushProduct | null> {
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId), with: { supplier: true } });
  if (!p) return null;
  const vs = await db.select().from(schema.variants)
    .where(and(eq(schema.variants.productId, productId), eq(schema.variants.active, true))).orderBy(asc(schema.variants.createdAt));
  if (!vs.length) return null;
  // verfügbar wie beim Bestandsabgleich: Lager − Reservierungen − Puffer
  const avail = new Map((await db.execute<{ id: string; available: number }>(sql`
    select v.id, greatest(0, v.stock_qty - coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0) - ${buffer})::int as available
    from variants v where v.product_id = ${productId} and v.active`)).rows.map((r) => [r.id, Number(r.available)]));
  // eigene Fotos für diesen Shop (Galerie, ohne die „nur aus dem Shop“ genommenen) – sonst das Lagerfoto
  const gallery = (await db.select({ f: schema.shopMedia.fileId }).from(schema.shopMedia)
    .where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, channel), eq(schema.shopMedia.removed, false), eq(schema.shopMedia.hidden, false)))
    .orderBy(asc(schema.shopMedia.position), asc(schema.shopMedia.createdAt))).map((r) => r.f);
  return {
    id: p.id, sku: p.sku, nameDe: p.nameDe, descriptionDe: p.descriptionDe, category: p.category, vendor: p.supplier?.name ?? "",
    vatRateBp: p.vatRateBp, retailPriceCents: p.retailPriceCents, purchasePriceCents: p.purchasePriceCents,
    imageFileId: p.imageFileId, gallery: [...new Set(gallery)],
    variants: vs.map((v) => ({
      id: v.id, size: v.size, color: v.color, barcode: v.barcode, retailPriceCents: v.retailPriceCents,
      imageFileId: v.imageFileId, available: avail.get(v.id) ?? 0, weightGrams: v.weightGrams,
    })),
  };
}

async function linkedMap(channel: ShopChannel, ids: string[]): Promise<Map<string, string>> {
  const rows = await db.select({ v: schema.shopVariants.variantId, s: schema.shopVariants.shopVariantId }).from(schema.shopVariants)
    .where(and(eq(schema.shopVariants.channel, channel), inArray(schema.shopVariants.variantId, ids)));
  return new Map(rows.map((r) => [r.v!, r.s]));
}

async function shopInfo(shop: Shop) {
  return (await gql<{ shop: { currencyCode: string; taxesIncluded: boolean } }>(shop, `{ shop { currencyCode taxesIncluded } }`)).shop;
}

async function pushToShop(shop: Shop, channel: ShopChannel, productId: string, userId?: string): Promise<PushResult | null> {
  const p = await loadProduct(productId, shop.stockBuffer, channel);
  if (!p) return null;
  const ids = p.variants.map((v) => v.id);
  let linked = await linkedMap(channel, ids);
  if (linked.size === ids.length) return null; // schon vollständig im Shop
  if (!shop.locationId) throw new PushError("noLocation");

  // Verbunden wird über den Barcode → ohne Barcode keine neue Verbindung
  if (p.variants.some((v) => !linked.has(v.id) && !v.barcode?.trim())) throw new PushError("noBarcode");

  if (linked.size === 0) {
    // Gibt es unsere Barcodes im Shop schon? Dann verbinden statt doppelt anlegen (dafür braucht es keine Kategorie).
    const found = await linkExisting(shop, channel, p);
    linked = await linkedMap(channel, ids);
    if (linked.size > 0) await logEvent(channel, "info", "products", `linkedExisting:${p.nameDe}`, p.sku);
    if (linked.size === ids.length) return { channel, outcome: "linked" };
    if (linked.size === 0) {
      if (found.elsewhere) throw new PushError("duplicate");
      // Neues Shop-Produkt: Kategorie des Shops (→ richtige Kollektion) und Preis nötig
      const storeType = resolveStoreType(p.category, await getStoreTypes(shop, 10 * 60_000, true), shop.categoryMap ?? {});
      const blockers = pushBlockers({ category: p.category, retailPriceCents: p.retailPriceCents, variants: p.variants }, { creating: true, storeType });
      if (blockers.length) throw new PushError(blockers[0]);
      return createProduct(shop, channel, p, storeType!, userId);
    }
  }
  // Teilweise im Shop → nur die fehlenden Größen/Farben an genau dieses Shop-Produkt anfügen
  const blockers = pushBlockers({ category: p.category, retailPriceCents: p.retailPriceCents, variants: p.variants.filter((v) => !linked.has(v.id)) }, { creating: false, storeType: null });
  if (blockers.length) throw new PushError(blockers[0]);
  return addVariants(shop, channel, p, linked, userId);
}

// ───────────────────────── Kategorien des Shops ─────────────────────────

const TYPES_Q = `{ productTypes(first: 250) { nodes } }`;
const COLLECTIONS_Q = `query($after: String) { collections(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
  nodes { title ruleSet { appliedDisjunctively rules { column relation condition } } } } }`;
type CollectionsData = { collections: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: {
  title: string; ruleSet: { appliedDisjunctively: boolean; rules: { column: string; relation: string; condition: string }[] } | null }[] } };

async function fetchStoreTypes(shop: Shop): Promise<StoreType[]> {
  const t = await gql<{ productTypes: { nodes: string[] } }>(shop, TYPES_Q);
  const cols: CollectionRules[] = [];
  try {
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const d: CollectionsData = await gql(shop, COLLECTIONS_Q, { after });
      for (const c of d.collections.nodes) if (c.ruleSet) cols.push({ title: c.title, disjunctive: c.ruleSet.appliedDisjunctively, rules: c.ruleSet.rules });
      if (!d.collections.pageInfo.hasNextPage) break;
      after = d.collections.pageInfo.endCursor;
    }
  } catch (e) { console.error("shopify collections", shop.channel, e); } // Kollektionen liefern nur die Anzeigenamen
  return storeTypesFrom(t.productTypes.nodes, cols);
}

/** Kategorien des Shops, zwischengespeichert in `shops.store_types`. strict = Fehler weitergeben statt den alten Stand zu nehmen. */
export async function getStoreTypes(shop: Shop, maxAgeMs: number, strict = false): Promise<StoreType[]> {
  const cached = shop.storeTypes ?? [];
  if (shop.storeTypesAt && Date.now() - shop.storeTypesAt.getTime() < maxAgeMs) return cached;
  try {
    const types = await fetchStoreTypes(shop);
    const now = new Date();
    await db.update(schema.shops).set({ storeTypes: types, storeTypesAt: now }).where(eq(schema.shops.channel, shop.channel));
    shop.storeTypes = types; shop.storeTypesAt = now;
    return types;
  } catch (e) {
    if (strict) throw e;
    console.error("shopify store types", shop.channel, e);
    return cached;
  }
}

/** Unsere Kategorie einer Kategorie des Shops zuordnen (type = null → Zuordnung entfernen). */
export async function setCategoryMapping(channel: ShopChannel, category: string, type: string | null, userId?: string): Promise<boolean> {
  const shop = await getShop(channel);
  const c = category.trim();
  if (!shop || !c) return false;
  const map = { ...(shop.categoryMap ?? {}) };
  if (type) {
    const hit = (shop.storeTypes ?? []).find((t) => t.type === type);
    if (!hit) return false;
    map[c] = hit.type;
  } else delete map[c];
  await db.transaction(async (tx) => {
    await tx.update(schema.shops).set({ categoryMap: map }).where(eq(schema.shops.channel, channel));
    await audit(tx, { entity: "shop", entityId: channel, action: "category_map", before: { [c]: shop.categoryMap?.[c] ?? null }, after: { [c]: map[c] ?? null }, userId });
  });
  return true;
}

// ───────────────────────── Noch nicht im Shop ─────────────────────────

export type PendingProduct = {
  id: string; sku: string; nameDe: string; category: string; imageId: string | null; barcodes: string[];
  variants: number; missing: number; kind: "new" | "add"; storeType: string | null; blockers: PushBlocker[];
};

/** Angehakte, aktive Artikel, von denen im Shop noch Varianten fehlen – mit dem, was zum Hochladen noch fehlt. */
export async function pendingProducts(channel: ShopChannel, shopRow?: Shop): Promise<PendingProduct[]> {
  const shop = shopRow ?? (await getShop(channel));
  if (!configured(shop)) return [];
  const flag = channel === "BRAND_SHOP" ? sql`p.in_brand_shop` : sql`p.in_general_shop`;
  const rows = await db.execute<Record<string, unknown>>(sql`
    select p.id, p.sku, p.name_de, p.category, p.image_file_id, p.retail_price_cents,
           count(*)::int as variants,
           count(*) filter (where not x.linked)::int as missing,
           count(*) filter (where not x.linked and coalesce(v.barcode, '') = '')::int as no_barcode,
           count(*) filter (where not x.linked and coalesce(v.retail_price_cents, 0) <= 0)::int as no_price,
           coalesce(array_agg(v.barcode order by v.created_at, v.id) filter (where coalesce(v.barcode, '') <> ''), '{}') as barcodes
    from products p
    join variants v on v.product_id = p.id and v.active
    cross join lateral (select exists (select 1 from shop_variants sv where sv.channel = ${channel} and sv.variant_id = v.id) as linked) x
    where p.active and ${flag}
    group by p.id
    having count(*) filter (where not x.linked) > 0
    order by p.name_de, p.id`);
  const types = shop.storeTypes ?? [], map = shop.categoryMap ?? {};
  return rows.rows.map((r) => {
    const variants = Number(r.variants), missing = Number(r.missing);
    const kind = missing === variants ? "new" as const : "add" as const;
    const category = String(r.category ?? "");
    const storeType = kind === "new" ? resolveStoreType(category, types, map) : null;
    const blockers: PushBlocker[] = [];
    if (Number(r.no_barcode) > 0) blockers.push("noBarcode");
    if (kind === "new") { if (!category.trim()) blockers.push("noCategory"); else if (!storeType) blockers.push("unknownCategory"); }
    if (Number(r.retail_price_cents) <= 0 && Number(r.no_price) > 0) blockers.push("noPrice");
    return {
      id: String(r.id), sku: String(r.sku), nameDe: String(r.name_de), category, imageId: (r.image_file_id as string | null) ?? null,
      barcodes: (r.barcodes as string[] | null) ?? [], variants, missing, kind, storeType, blockers,
    };
  });
}

/** Für Startseite und Artikelliste: je eingerichtetem Shop, wie viele Artikel noch fehlen und wie viele davon sofort hochgeladen werden können. */
export async function pendingSummary(): Promise<{ channel: ShopChannel; total: number; ready: number }[]> {
  const out: { channel: ShopChannel; total: number; ready: number }[] = [];
  for (const channel of CHANNELS) {
    const shop = await getShop(channel);
    if (!configured(shop)) continue;
    const list = await pendingProducts(channel, shop);
    if (list.length) out.push({ channel, total: list.length, ready: list.filter((x) => !x.blockers.length).length });
  }
  return out;
}

/** „Nicht für diesen Shop“: Häkchen entfernen – der Artikel verschwindet aus der Liste, im Shop ändert sich nichts. */
export async function unlistProduct(channel: ShopChannel, productId: string, userId?: string) {
  await db.transaction(async (tx) => {
    const before = await tx.query.products.findFirst({ where: eq(schema.products.id, productId) });
    if (!before) return;
    const set = channel === "BRAND_SHOP" ? { inBrandShop: false } : { inGeneralShop: false };
    await tx.update(schema.products).set(set).where(eq(schema.products.id, productId));
    await audit(tx, { entity: "product", entityId: productId, action: "update", before: { [flagCol(channel)]: before[flagCol(channel)] }, after: set, userId });
  });
}

// ───────────────────────── Alle auf einmal hochladen (im Hintergrund) ─────────────────────────

export type BulkState = {
  running: boolean; total: number; done: number; created: number; linked: number; updated: number; failed: number; skipped: number;
  current: string; startedAt: number; finishedAt: number | null;
};
// läuft im Server-Prozess (nur EINE Instanz, siehe CLAUDE.md)
const bulk = new Map<ShopChannel, BulkState>();
export const bulkPushStatus = (channel: ShopChannel): BulkState | null => { const s = bulk.get(channel); return s ? { ...s } : null; };

/** Alle Artikel ohne offene Punkte nacheinander hochladen. Läuft schon einer → dessen Stand. Artikel mit offenen Punkten = übersprungen. */
export async function startBulkPush(channel: ShopChannel, userId?: string, only?: string[]): Promise<BulkState> {
  const running = bulk.get(channel);
  if (running?.running) return { ...running };
  const shop = await getShop(channel);
  if (!configured(shop)) throw new ShopifyError("notConfigured", "Shop nicht eingerichtet");
  if (!shop.locationId) throw new PushError("noLocation");
  await getStoreTypes(shop, 10 * 60_000, true);
  const list = (await pendingProducts(channel, shop)).filter((x) => !only || only.includes(x.id)); // only: nur bestimmte Artikel (Tests)
  const todo = list.filter((x) => !x.blockers.length);
  const st: BulkState = { running: true, total: todo.length, done: 0, created: 0, linked: 0, updated: 0, failed: 0, skipped: list.length - todo.length,
    current: "", startedAt: Date.now(), finishedAt: null };
  bulk.set(channel, st);
  void (async () => {
    try {
      for (const x of todo) {
        st.current = x.nameDe;
        const r = await pushProductToShop(channel, x.id, userId).catch((e) => { console.error("bulk push", e); return { outcome: "failed" } as const; });
        if (r?.outcome === "created" || r?.outcome === "createdHidden") st.created++;
        else if (r?.outcome === "linked") st.linked++;
        else if (r?.outcome === "updated") st.updated++;
        else if (r) st.failed++;
        st.done++;
      }
    } finally {
      st.running = false; st.current = ""; st.finishedAt = Date.now();
      await logEvent(channel, st.failed ? "warn" : "info", "products", `bulkPushed:${st.created}|${st.linked}|${st.updated}|${st.failed}|${st.skipped}`).catch(() => {});
    }
  })();
  return { ...st };
}

// ───────────────────────── Neues Shop-Produkt ─────────────────────────

async function createProduct(shop: Shop, channel: ShopChannel, p: PushProduct, productType: string, userId?: string): Promise<PushResult> {
  const info = await shopInfo(shop);
  if (info.currencyCode !== "EUR") throw new PushError("currency");

  // Fotos hochladen (Galerie dieses Shops, sonst Lagerfoto, dann Variantenfotos) – geht das schief, wird das Produkt trotzdem angelegt
  let images = new Map<string, PushImage>(), imagesFailed = false;
  const wanted = productFiles(p.gallery ?? [], p.imageFileId, p.variants.map((v) => v.imageFileId));
  try { images = await withFreshToken(shop, () => uploadImages(shop, p.sku, wanted)); }
  catch (e) { imagesFailed = true; console.error("shopify push images", p.id, e); }

  const input = buildProductSet(p, { taxesIncluded: info.taxesIncluded, locationId: shop.locationId, images, productType });
  const d = await withFreshToken(shop, () => gql<ProductSetData>(shop, PRODUCT_SET_M, { input }));
  if (d.productSet.userErrors.length || !d.productSet.product) {
    throw new ShopifyError("userErrors", d.productSet.userErrors.map((e) => e.message).join("; ").slice(0, 500) || "productSet");
  }
  const created = d.productSet.product;
  let galleryCheck = false;

  // Varianten zuordnen (Bestand wurde beim Anlegen gesetzt → als gemeldet merken)
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
    await audit(tx, { entity: "product", entityId: p.id, action: "shop_create", after: { channel, shopProductId: created.id, handle: created.handle, productType, variants: Object.fromEntries(map) }, userId });
    // Galerie: Medium je Foto merken (Reihenfolge wie übergeben) – später löschen/umsortieren nur diese
    if (p.gallery?.length) {
      const sent = (input.files ?? []).map((f) => [...images.entries()].find(([, img]) => img.resourceUrl === f.originalSource)?.[0] ?? "");
      const m = mapCreatedMedia(sent, created.media?.nodes.map((n) => n.id) ?? [], p.gallery);
      for (const [fileId, mediaId] of m.map) {
        await tx.update(schema.shopMedia).set({ mediaId, error: "" }).where(and(eq(schema.shopMedia.productId, p.id), eq(schema.shopMedia.channel, channel),
          eq(schema.shopMedia.fileId, fileId), eq(schema.shopMedia.removed, false), eq(schema.shopMedia.hidden, false)));
      }
      if (!m.exact) galleryCheck = true;
    }
  });

  // Im Online Store veröffentlichen
  let visible = false;
  try { visible = await withFreshToken(shop, () => publishToOnlineStore(shop, created.id)); }
  catch (e) { console.error("shopify push publish", p.id, e); }
  await logEvent(channel, visible ? "info" : "warn", "products", `${visible ? "created" : "createdHidden"}:${p.nameDe}`, p.sku);
  if (imagesFailed) await logEvent(channel, "warn", "products", `imagesFailedFor:${p.nameDe}`, p.sku);
  if (galleryCheck) await logEvent(channel, "warn", "products", `galleryCheck:${p.nameDe}`, p.sku);
  return { channel, outcome: visible ? "created" : "createdHidden", imagesFailed };
}

// ───────────────────────── Größen/Farben ergänzen ─────────────────────────

const PRODUCT_OF_VARIANT_Q = `query($id: ID!) { productVariant(id: $id) { product {
  id hasOnlyDefaultVariant options { name position optionValues { name } }
  variants(first: 250) { nodes { id selectedOptions { name value } } } } } }`;
type ShopProductData = { productVariant: { product: {
  id: string; hasOnlyDefaultVariant: boolean; options: { name: string; position: number; optionValues: { name: string }[] }[];
  variants: { nodes: { id: string; selectedOptions: { name: string; value: string }[] }[] };
} } | null };

const OPTIONS_CREATE_M = `mutation($productId: ID!, $options: [OptionCreateInput!]!) {
  productOptionsCreate(productId: $productId, options: $options, variantStrategy: LEAVE_AS_IS) { userErrors { field message code } } }`;

const VARIANTS_CREATE_M = `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $media: [CreateMediaInput!]) {
  productVariantsBulkCreate(productId: $productId, variants: $variants, media: $media, strategy: PRESERVE_STANDALONE_VARIANT) {
    productVariants { id sku barcode displayName inventoryItem { id tracked } }
    userErrors { field message code } } }`;
type VariantsCreateData = { productVariantsBulkCreate: {
  productVariants: { id: string; sku: string | null; barcode: string | null; displayName: string; inventoryItem: { id: string; tracked: boolean } | null }[] | null;
  userErrors: { field: string[] | null; message: string; code: string | null }[];
} };

async function addVariants(shop: Shop, channel: ShopChannel, p: PushProduct, linked: Map<string, string>, userId?: string): Promise<PushResult> {
  const missing = p.variants.filter((v) => !linked.has(v.id));
  const d = await withFreshToken(shop, () => gql<ShopProductData>(shop, PRODUCT_OF_VARIANT_Q, { id: [...linked.values()][0] }));
  const prod = d.productVariant?.product;
  if (!prod) throw new PushError("other", "Shop-Variante nicht gefunden – bitte „Produkte aus dem Shop laden“");
  // unsere Varianten hängen an mehreren Shop-Produkten → nicht raten
  const inProduct = new Set(prod.variants.nodes.map((n) => n.id));
  if ([...linked.values()].some((id) => !inProduct.has(id))) {
    await logEvent(channel, "warn", "products", `pushBlocked:multipleProducts|${p.nameDe}`, p.sku);
    return { channel, outcome: "partial", reason: "multipleProducts", n: missing.length };
  }
  const shape: ShopProductShape = {
    hasOnlyDefaultVariant: prod.hasOnlyDefaultVariant,
    options: [...prod.options].sort((a, b) => a.position - b.position).map((o) => ({ name: o.name, values: o.optionValues.map((v) => v.name) })),
    variants: prod.variants.nodes,
  };
  const plan = planVariantAdds(shape, linked, p.variants, missing.map((v) => v.id));
  if (!plan.ok) {
    await logEvent(channel, "warn", "products", `pushBlocked:${plan.reason}|${p.nameDe}`, p.sku);
    return { channel, outcome: "partial", reason: plan.reason, n: missing.length };
  }
  const info = await shopInfo(shop);
  if (info.currencyCode !== "EUR") throw new PushError("currency");

  // eigene Fotos der neuen Varianten (das Artikelfoto hat das Shop-Produkt schon)
  let images = new Map<string, PushImage>(), imagesFailed = false;
  const fileIds = [...new Set(missing.map((v) => v.imageFileId).filter((x): x is string => Boolean(x) && x !== p.imageFileId))];
  if (fileIds.length) {
    try { images = await withFreshToken(shop, () => uploadImages(shop, p.sku, fileIds)); }
    catch (e) { imagesFailed = true; console.error("shopify push images", p.id, e); }
  }

  if (plan.createOptions.length) {
    const r = await withFreshToken(shop, () => gql<{ productOptionsCreate: { userErrors: { message: string }[] } }>(shop, OPTIONS_CREATE_M, { productId: prod.id, options: plan.createOptions }));
    if (r.productOptionsCreate.userErrors.length) throw new ShopifyError("userErrors", r.productOptionsCreate.userErrors.map((e) => e.message).join("; ").slice(0, 500));
  }
  const build = (withMedia: boolean) => plan.variants.map((pv) => {
    const v = missing.find((x) => x.id === pv.id)!;
    const img = withMedia && v.imageFileId ? images.get(v.imageFileId) : undefined;
    return {
      optionValues: pv.optionValues,
      price: money(shopPriceCents(v.retailPriceCents ?? p.retailPriceCents, p.vatRateBp, info.taxesIncluded)),
      ...(v.barcode ? { barcode: v.barcode } : {}),
      inventoryItem: { sku: variantSku(p.sku, v, false), tracked: true, ...(p.purchasePriceCents > 0 ? { cost: money(p.purchasePriceCents) } : {}), ...shopWeight(v.weightGrams) },
      inventoryQuantities: [{ locationId: shop.locationId, availableQuantity: Math.max(0, v.available) }],
      ...(img ? { mediaSrc: [img.resourceUrl] } : {}),
    };
  });
  const media = fileIds.filter((id) => images.has(id)).map((id) => ({ originalSource: images.get(id)!.resourceUrl, mediaContentType: "IMAGE", alt: p.nameDe }));
  let r = await withFreshToken(shop, () => gql<VariantsCreateData>(shop, VARIANTS_CREATE_M, { productId: prod.id, variants: build(true), media: media.length ? media : null }));
  if (r.productVariantsBulkCreate.userErrors.length && media.length) {
    // Fotos machen Ärger → ohne Fotos nochmal (Varianten sind wichtiger)
    console.error("shopify add variants with media", p.id, r.productVariantsBulkCreate.userErrors);
    imagesFailed = true;
    r = await withFreshToken(shop, () => gql<VariantsCreateData>(shop, VARIANTS_CREATE_M, { productId: prod.id, variants: build(false), media: null }));
  }
  const created = r.productVariantsBulkCreate.productVariants;
  if (r.productVariantsBulkCreate.userErrors.length || !created) {
    throw new ShopifyError("userErrors", r.productVariantsBulkCreate.userErrors.map((e) => e.message).join("; ").slice(0, 500) || "productVariantsBulkCreate");
  }

  // zuordnen über den Barcode (jede neue Variante hat einen), sonst Reihenfolge
  const byBarcode = new Map(missing.filter((v) => v.barcode).map((v) => [v.barcode!.trim(), v.id]));
  const now = new Date();
  let n = 0;
  await db.transaction(async (tx) => {
    for (const [i, c] of created.entries()) {
      const variantId = byBarcode.get((c.barcode ?? "").trim()) ?? plan.variants[i]?.id ?? null;
      const qty = missing.find((v) => v.id === variantId)?.available ?? null;
      const row = {
        inventoryItemId: c.inventoryItem?.id ?? "", title: c.displayName.slice(0, 300), sku: (c.sku ?? "").trim(), barcode: (c.barcode ?? "").trim(),
        tracked: c.inventoryItem?.tracked ?? true, variantId, matchedBy: variantId ? "created" : "", lastPushedQty: qty, lastPushedAt: now, pushError: "", seenAt: now,
      };
      await tx.insert(schema.shopVariants).values({ channel, shopVariantId: c.id, ...row })
        .onConflictDoUpdate({ target: [schema.shopVariants.channel, schema.shopVariants.shopVariantId], set: row });
      if (variantId) n++;
    }
    await audit(tx, { entity: "product", entityId: p.id, action: "shop_update", after: { channel, shopProductId: prod.id, added: created.map((c) => c.id), options: plan.createOptions }, userId });
  });
  await logEvent(channel, "info", "products", `variantsAdded:${p.nameDe} (${n})`, p.sku);
  if (imagesFailed) await logEvent(channel, "warn", "products", `imagesFailedFor:${p.nameDe}`, p.sku);
  return { channel, outcome: "updated", n, imagesFailed };
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

// ───────────────────────── productSet ─────────────────────────

const PRODUCT_SET_M = `mutation($input: ProductSetInput!) { productSet(synchronous: true, input: $input) {
  product { id handle variants(first: 250) { nodes { id sku barcode displayName selectedOptions { name value } inventoryItem { id tracked } } }
    media(first: 250) { nodes { id } } }
  userErrors { field message code } } }`;
type ProductSetData = { productSet: {
  product: { id: string; handle: string; variants: { nodes: (FoundVariant & { selectedOptions: { name: string; value: string }[] })[] }; media?: { nodes: { id: string }[] } } | null;
  userErrors: { field: string[] | null; message: string; code: string | null }[];
} };

// ───────────────────────── Anzeige im Artikel-Formular ─────────────────────────

const none = <T,>(v: () => T): Record<ShopChannel, T> => ({ BRAND_SHOP: v(), GENERAL_SHOP: v() });
export type ShopFormStatus = {
  connected: Record<ShopChannel, boolean>; linked: Record<ShopChannel, boolean>; linkedVariantIds: Record<ShopChannel, string[]>;
  storeTypes: Record<ShopChannel, StoreType[]>; categoryMap: Record<ShopChannel, Record<string, string>>;
};

/** Welche Shops sind eingerichtet, welche Varianten sind dort schon verbunden, welche Kategorien hat der Shop? (für die Rückfrage beim Speichern) */
export async function productShopStatus(productId?: string): Promise<ShopFormStatus> {
  const st: ShopFormStatus = { connected: none(() => false), linked: none(() => false), linkedVariantIds: none(() => []), storeTypes: none(() => []), categoryMap: none(() => ({})) };
  for (const s of await db.select().from(schema.shops)) {
    const c = s.channel as ShopChannel;
    if (!configured(s)) continue;
    st.connected[c] = true;
    st.categoryMap[c] = s.categoryMap ?? {};
    // höchstens stündlich frisch holen, nie länger als 3 Sekunden warten
    st.storeTypes[c] = await Promise.race([getStoreTypes(s, 3600_000), new Promise<StoreType[]>((r) => setTimeout(() => r(s.storeTypes ?? []), 3000))]);
  }
  if (productId) {
    const rows = await db.execute<{ channel: ShopChannel; variant_id: string }>(sql`
      select distinct sv.channel, sv.variant_id from shop_variants sv join variants v on v.id = sv.variant_id where v.product_id = ${productId} and v.active`);
    for (const r of rows.rows) { st.linked[r.channel] = true; st.linkedVariantIds[r.channel].push(r.variant_id); }
  }
  return st;
}
