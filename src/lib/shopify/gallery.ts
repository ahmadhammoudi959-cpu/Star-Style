import "server-only";
/**
 * Shop-Galerie (Wunsch Inhaber 04.11.2026): im Lager EIN Foto, im Shop eigene Fotos je Shop (bis zu 10, das erste ist das Titelbild).
 * - Artikel-Formular → shop_media (saveGalleryTx). Ist der Artikel im Shop verbunden, gleicht syncGallery im Hintergrund ab:
 *   entfernte Fotos löschen (productDeleteMedia), neue hochladen (staged upload + productUpdate media), Reihenfolge (productReorderMedia).
 * - Neues Shop-Produkt: Galerie statt Lagerfoto (createProduct in product-push.ts), die Medien werden gleich gemerkt.
 * - „Fotos aus dem Shop holen“ (adoptShopGallery): vorhandene Fotos eines verbundenen Produkts übernehmen – danach von hier steuerbar.
 * Fremde Medien (im Shop von Hand ergänzt und nicht übernommen) fassen wir nie an; sie stehen hinter unserer Galerie.
 * API 2026-07: productDeleteMedia ist veraltet, aber vorhanden (ab 2026-10: fileUpdate referencesToRemove, braucht write_files).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "../stock";
import { storeImageBytes } from "../files";
import { gql, getShop, ShopifyError, type Shop, type ShopChannel } from "./client";
import { logEvent } from "./sync";
import { configured, uploadImages, withFreshToken, withProductLock } from "./admin";
import { afterChanges, diffGallery, GALLERY_MAX, newMediaIds, planGallery, reorderMoves } from "./gallery-map";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type GalleryItem = { fileId: string; mediaId: string; error: string };
const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];

/** Galerien eines Artikels je Shop (ohne Löschmarken), in Galerie-Reihenfolge */
export async function galleriesOf(productId: string): Promise<Record<ShopChannel, GalleryItem[]>> {
  const rows = await db.select().from(schema.shopMedia)
    .where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.removed, false)))
    .orderBy(asc(schema.shopMedia.position), asc(schema.shopMedia.createdAt));
  const out: Record<ShopChannel, GalleryItem[]> = { BRAND_SHOP: [], GENERAL_SHOP: [] };
  for (const r of rows) if (r.channel === "BRAND_SHOP" || r.channel === "GENERAL_SHOP") out[r.channel].push({ fileId: r.fileId, mediaId: r.mediaId, error: r.error });
  return out;
}

/** Galerie aus dem Formular speichern (in der Transaktion des Artikels). true = geändert. Nur echte Bild-Dateien (die IDs kommen aus dem Browser). */
export async function saveGalleryTx(tx: Tx, productId: string, channel: ShopChannel, wanted: string[], userId?: string): Promise<boolean> {
  const ok = wanted.length
    ? new Set((await tx.select({ id: schema.storedFiles.id }).from(schema.storedFiles)
      .where(and(inArray(schema.storedFiles.id, wanted), inArray(schema.storedFiles.mime, IMAGE_MIME)))).map((r) => r.id))
    : new Set<string>();
  const list = wanted.filter((id) => ok.has(id)).slice(0, GALLERY_MAX);
  const rows = await tx.select().from(schema.shopMedia).where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, channel)));
  const d = diffGallery(rows, list);
  if (!d.changed) return false;
  for (const k of d.keep) await tx.update(schema.shopMedia).set({ position: k.position }).where(eq(schema.shopMedia.id, k.id));
  if (d.add.length) await tx.insert(schema.shopMedia).values(d.add.map((a) => ({ productId, channel, fileId: a.fileId, position: a.position })));
  if (d.tombstone.length) await tx.update(schema.shopMedia).set({ removed: true, position: -1 }).where(inArray(schema.shopMedia.id, d.tombstone));
  if (d.drop.length) await tx.delete(schema.shopMedia).where(inArray(schema.shopMedia.id, d.drop));
  const before = rows.filter((r) => !r.removed).sort((a, b) => a.position - b.position).map((r) => r.fileId);
  await audit(tx, { entity: "product", entityId: productId, action: "shop_gallery", before: { channel, files: before }, after: { channel, files: list }, userId });
  return true;
}

/** Erste verbundene Shop-Variante dieses Artikels (darüber finden wir das Shop-Produkt) */
async function linkedShopVariant(productId: string, channel: ShopChannel): Promise<string | null> {
  const r = await db.select({ s: schema.shopVariants.shopVariantId }).from(schema.shopVariants)
    .innerJoin(schema.variants, eq(schema.variants.id, schema.shopVariants.variantId))
    .where(and(eq(schema.shopVariants.channel, channel), eq(schema.variants.productId, productId)))
    .orderBy(asc(schema.variants.createdAt)).limit(1);
  return r[0]?.s ?? null;
}

const PRODUCT_MEDIA_Q = `query($id: ID!) { productVariant(id: $id) { product { id media(first: 250) { nodes { id } } } } }`;
type ProductMediaData = { productVariant: { product: { id: string; media: { nodes: { id: string }[] } } } | null };
const DELETE_MEDIA_M = `mutation($productId: ID!, $mediaIds: [ID!]!) { productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
  deletedMediaIds mediaUserErrors { field message } } }`;
const ADD_MEDIA_M = `mutation($product: ProductUpdateInput!, $media: [CreateMediaInput!]) { productUpdate(product: $product, media: $media) {
  product { id media(first: 250) { nodes { id } } } userErrors { field message } } }`;
const REORDER_M = `mutation($id: ID!, $moves: [MoveInput!]!) { productReorderMedia(id: $id, moves: $moves) { job { id } mediaUserErrors { field message } } }`;

const errs = (list: { message: string }[] | undefined) => (list ?? []).map((e) => e.message).join("; ").slice(0, 300);

export type GallerySync = { status: "done" | "nothing" | "notLinked" | "notConfigured" | "failed"; uploaded?: number; removed?: number; error?: string };

/** Galerie eines verbundenen Artikels mit dem Shop abgleichen. Läuft nie gleichzeitig mit einem Hochladen desselben Artikels. */
export async function syncGallery(productId: string, channel: ShopChannel): Promise<GallerySync> {
  const shop = await getShop(channel);
  if (!configured(shop)) return { status: "notConfigured" };
  return withProductLock(`${channel}:${productId}`, () => syncLocked(shop, productId, channel));
}

async function syncLocked(shop: Shop, productId: string, channel: ShopChannel): Promise<GallerySync> {
  const rows = await db.select().from(schema.shopMedia).where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, channel)));
  if (!rows.length) return { status: "nothing" };
  const sv = await linkedShopVariant(productId, channel);
  if (!sv) return { status: "notLinked" };
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, productId) });
  if (!p) return { status: "nothing" };
  let step = "load";
  try {
    const d = await withFreshToken(shop, () => gql<ProductMediaData>(shop, PRODUCT_MEDIA_Q, { id: sv }));
    const prod = d.productVariant?.product;
    if (!prod) throw new ShopifyError("graphql", "Shop-Variante nicht gefunden – bitte „Produkte aus dem Shop laden“");
    let media = prod.media.nodes.map((n) => n.id);
    const plan = planGallery(rows, media);
    if (!plan.remove.length && !plan.upload.length && !plan.dropTombstones.length
      && !reorderMoves(media, rows.filter((r) => !r.removed && r.mediaId).sort((a, b) => a.position - b.position).map((r) => r.mediaId)).length) {
      if (rows.some((r) => r.error)) await db.update(schema.shopMedia).set({ error: "" }).where(inArray(schema.shopMedia.id, rows.map((r) => r.id)));
      return { status: "nothing" };
    }

    // 1. im Formular entfernte Fotos im Shop löschen
    step = "delete";
    let removed = 0;
    if (plan.remove.length) {
      const r = await withFreshToken(shop, () => gql<{ productDeleteMedia: { deletedMediaIds: string[] | null; mediaUserErrors: { message: string }[] } }>(
        shop, DELETE_MEDIA_M, { productId: prod.id, mediaIds: plan.remove }));
      if (r.productDeleteMedia.mediaUserErrors?.length) throw new ShopifyError("userErrors", errs(r.productDeleteMedia.mediaUserErrors));
      removed = r.productDeleteMedia.deletedMediaIds?.length ?? plan.remove.length;
      media = afterChanges(media, plan.remove, []);
    }
    const tomb = rows.filter((r) => r.removed).map((r) => r.id);
    if (tomb.length) await db.delete(schema.shopMedia).where(inArray(schema.shopMedia.id, tomb));
    if (plan.lost.length) await db.update(schema.shopMedia).set({ mediaId: "" }).where(inArray(schema.shopMedia.id, plan.lost.map((r) => r.id)));

    // 2. neue Fotos hochladen (hängen hinten an)
    step = "upload";
    let uploaded = 0;
    if (plan.upload.length) {
      const imgs = await withFreshToken(shop, () => uploadImages(shop, p.sku, plan.upload.map((r) => r.fileId)));
      const ready = plan.upload.filter((r) => imgs.has(r.fileId));
      const bad = plan.upload.filter((r) => !imgs.has(r.fileId));
      if (bad.length) await db.update(schema.shopMedia).set({ error: "imageType" }).where(inArray(schema.shopMedia.id, bad.map((r) => r.id)));
      if (ready.length) {
        const r = await withFreshToken(shop, () => gql<{ productUpdate: { product: { media: { nodes: { id: string }[] } } | null; userErrors: { message: string }[] } }>(
          shop, ADD_MEDIA_M, { product: { id: prod.id }, media: ready.map((x) => ({ originalSource: imgs.get(x.fileId)!.resourceUrl, mediaContentType: "IMAGE", alt: p.nameDe })) }));
        if (r.productUpdate.userErrors.length || !r.productUpdate.product) throw new ShopifyError("userErrors", errs(r.productUpdate.userErrors) || "productUpdate");
        const after = r.productUpdate.product.media.nodes.map((n) => n.id);
        const fresh = newMediaIds(media, after);
        // neue Medien kommen in der Reihenfolge der Eingabe; weicht die Anzahl ab, trotzdem der Reihe nach (sonst doppelt beim nächsten Mal)
        for (const [i, x] of ready.entries()) {
          if (!fresh[i]) continue;
          await db.update(schema.shopMedia).set({ mediaId: fresh[i], error: "" }).where(eq(schema.shopMedia.id, x.id));
          uploaded++;
        }
        if (fresh.length !== ready.length) await logEvent(channel, "warn", "products", `galleryCheck:${p.nameDe}`, p.sku);
        media = after;
      }
    }

    // 3. Reihenfolge: unsere Galerie vorne
    step = "order";
    const live = (await db.select().from(schema.shopMedia)
      .where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, channel), eq(schema.shopMedia.removed, false)))
      .orderBy(asc(schema.shopMedia.position), asc(schema.shopMedia.createdAt))).filter((r) => r.mediaId);
    const moves = reorderMoves(media, live.map((r) => r.mediaId));
    if (moves.length) {
      const r = await withFreshToken(shop, () => gql<{ productReorderMedia: { mediaUserErrors: { message: string }[] } }>(shop, REORDER_M, { id: prod.id, moves }));
      if (r.productReorderMedia.mediaUserErrors?.length) throw new ShopifyError("userErrors", errs(r.productReorderMedia.mediaUserErrors));
    }
    await logEvent(channel, "info", "products", `gallerySynced:${p.nameDe} (+${uploaded} / −${removed})`, p.sku);
    return { status: "done", uploaded, removed };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    console.error("shopify gallery", channel, productId, step, e);
    // Fehler an den noch nicht hochgeladenen Fotos merken (Anzeige im Formular); beim nächsten Speichern wird es erneut versucht
    await db.update(schema.shopMedia).set({ error: msg }).where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, channel),
      eq(schema.shopMedia.mediaId, ""), eq(schema.shopMedia.removed, false)));
    // Löschen geht dauerhaft nicht (Schema/Recht) → Löschmarken nicht ewig mitschleppen, im Protokoll steht es
    if (step === "delete" && e instanceof ShopifyError && e.code === "graphql") {
      await db.delete(schema.shopMedia).where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, channel), eq(schema.shopMedia.removed, true)));
    }
    await logEvent(channel, "warn", "products", `galleryFailed:${p.nameDe} – ${msg}`, p.sku);
    return { status: "failed", error: msg };
  }
}

/** Nach dem Speichern im Hintergrund (Speichern soll nicht auf Shopify warten). Ergebnis im Shop-Protokoll und an den Fotos. */
export function syncGalleryLater(productId: string, channels: ShopChannel[]) {
  if (!channels.length) return;
  void (async () => {
    for (const c of channels) await syncGallery(productId, c).catch((e) => console.error("shopify gallery later", c, productId, e));
  })();
}

// ───────────────────────── Fotos aus dem Shop übernehmen ─────────────────────────

const STORE_IMAGES_Q = `query($id: ID!) { productVariant(id: $id) { product { id media(first: 50) { nodes {
  id mediaContentType status ... on MediaImage { image { url(transform: { maxWidth: 2048, maxHeight: 2048, preferredContentType: WEBP }) } } } } } } }`;
type StoreImagesData = { productVariant: { product: { id: string; media: { nodes: { id: string; mediaContentType: string; status: string; image?: { url: string } | null }[] } } } | null };

const allowedImage = (url: string) => url.startsWith("https://cdn.shopify.com/") || Boolean(process.env.SHOPIFY_MOCK_URL && url.startsWith(process.env.SHOPIFY_MOCK_URL));

export type AdoptResult = { ok: true; items: GalleryItem[] } | { ok: false; error: "notConfigured" | "notLinked" | "notEmpty" | "none" | "failed"; detail?: string };

/** Fotos, die im Shop schon am Produkt hängen, als Galerie übernehmen (nur wenn die Galerie dieses Shops leer ist). */
export async function adoptShopGallery(productId: string, channel: ShopChannel, userId?: string): Promise<AdoptResult> {
  const shop = await getShop(channel);
  if (!configured(shop)) return { ok: false, error: "notConfigured" };
  return withProductLock(`${channel}:${productId}`, async (): Promise<AdoptResult> => {
    const existing = await db.select({ id: schema.shopMedia.id }).from(schema.shopMedia)
      .where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, channel))).limit(1);
    if (existing.length) return { ok: false, error: "notEmpty" };
    const sv = await linkedShopVariant(productId, channel);
    if (!sv) return { ok: false, error: "notLinked" };
    try {
      const d = await withFreshToken(shop, () => gql<StoreImagesData>(shop, STORE_IMAGES_Q, { id: sv }));
      const imgs = (d.productVariant?.product.media.nodes ?? [])
        .filter((m) => m.mediaContentType === "IMAGE" && m.status === "READY" && m.image?.url && allowedImage(m.image.url)).slice(0, GALLERY_MAX);
      if (!imgs.length) return { ok: false, error: "none" };
      const got: { fileId: string; mediaId: string }[] = [];
      for (const [i, m] of imgs.entries()) {
        const res = await fetch(m.image!.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        got.push({ fileId: await storeImageBytes(Buffer.from(await res.arrayBuffer()), `shop-${i + 1}.webp`), mediaId: m.id });
      }
      await db.transaction(async (tx) => {
        await tx.insert(schema.shopMedia).values(got.map((g, position) => ({ productId, channel, fileId: g.fileId, mediaId: g.mediaId, position })));
        await audit(tx, { entity: "product", entityId: productId, action: "shop_gallery", after: { channel, adopted: got.map((g) => g.mediaId) }, userId });
      });
      return { ok: true, items: got.map((g) => ({ ...g, error: "" })) };
    } catch (e) {
      console.error("shopify gallery adopt", channel, productId, e);
      return { ok: false, error: "failed", detail: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
    }
  });
}

/** Für die Anzeige: ist der Artikel in diesem Shop verbunden? */
export async function linkedChannels(productId: string): Promise<ShopChannel[]> {
  const out: ShopChannel[] = [];
  for (const c of ["BRAND_SHOP", "GENERAL_SHOP"] as const) if (await linkedShopVariant(productId, c)) out.push(c);
  return out;
}
