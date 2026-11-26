"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { can, requirePerm } from "@/lib/auth";
import { parseMoney } from "@/lib/money";
import { audit, receiveGoodsTx } from "@/lib/stock";
import { storeImage } from "@/lib/files";
import { copyManualPhoto } from "@/lib/direct";
import { todayIso } from "@/lib/dates";
import { deleteProduct, ProductDeleteError } from "@/lib/product-delete";
import { encodePush, pushProductToShops, pushTargets, setCategoryMapping } from "@/lib/shopify/product-push";
import { pushWeightsLater } from "@/lib/shopify/weights";
import { pushProductPrices } from "@/lib/shopify/prices";
import { encodePriceNotes } from "@/lib/shopify/product-push-map";
import { adoptShopGallery, saveGalleryTx, syncGallery, syncGalleryLater, type AdoptResult, type GallerySync } from "@/lib/shopify/gallery";
import { parseGalleryInput } from "@/lib/shopify/gallery-map";
import { syncProductTypesLater } from "@/lib/shopify/collections";
import type { ShopChannel } from "@/lib/shopify/client";
import { canonicalCategory } from "@/lib/categories";
import { parseWeight } from "@/lib/weight";
import { parseDims } from "@/lib/shipping-class";
import { pushFreightTagsLater } from "@/lib/shopify/freight-tags";

export type ProductFormState = { error?: string; field?: string; values?: Record<string, string> } | undefined;

// Bei einer Fehlermeldung setzt React das Formular zurück – die eingegebenen Texte kommen deshalb mit zurück und bleiben stehen
const KEEP = ["sku", "nameDe", "nameNl", "descriptionDe", "descriptionNl", "category", "supplierId", "vatRateBp"] as const;

const money = z.string().transform((s, ctx) => {
  const v = parseMoney(s === "" ? "0" : s);
  if (v == null || v < 0) { ctx.addIssue({ code: "custom", message: "money" }); return z.NEVER; }
  return v;
});

const VariantSchema = z.object({
  id: z.string().optional(),
  ref: z.string().max(64).default(""),
  size: z.string().trim().max(60).default(""),
  color: z.string().trim().max(60).default(""),
  barcode: z.string().trim().max(32).default(""),
  minStock: z.coerce.number().int().min(0).default(0),
  // Gewicht einer Packung: Text + Einheit („150“ g, „1,5“ kg, „250 g“)
  weight: z.string().trim().max(20).default(""),
  weightUnit: z.enum(["g", "kg"]).default("g"),
  // Paketmaße in cm (Länge, Breite, Höhe) – entscheiden mit dem Gewicht über Paket/Spedition
  pkgL: z.string().trim().max(12).default(""),
  pkgW: z.string().trim().max(12).default(""),
  pkgH: z.string().trim().max(12).default(""),
  // eigene Preise dieser Größe/Farbe (netto, Text wie die Preisfelder); leer = Preis des Artikels (Wunsch Inhaber 26.11.2026)
  purchasePrice: z.string().trim().max(20).default(""),
  wholesalePrice: z.string().trim().max(20).default(""),
  retailPrice: z.string().trim().max(20).default(""),
  // Anfangsbestand nur für neue Varianten: wird als Wareneingang gebucht (Bestand nie direkt setzen)
  initialQty: z.coerce.number().int().min(0).max(1_000_000).default(0),
  initialExpiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default(""),
});

const ProductSchema = z.object({
  id: z.string().optional(),
  sku: z.string().trim().max(64).default(""),
  nameDe: z.string().trim().min(1).max(200),
  nameNl: z.string().trim().max(200).default(""),
  descriptionDe: z.string().trim().max(4000).default(""),
  descriptionNl: z.string().trim().max(4000).default(""),
  category: z.string().trim().max(100).default(""),
  supplierId: z.string().default(""),
  vatRateBp: z.coerce.number().refine((n) => n === 1900 || n === 700),
  purchasePrice: money,
  wholesalePrice: money,
  retailPrice: money,
  tracksExpiry: z.string().optional().transform((v) => v === "on"),
  inBrandShop: z.string().optional().transform((v) => v === "on"),
  inGeneralShop: z.string().optional().transform((v) => v === "on"),
  shippingClass: z.enum(["", "PARCEL", "FREIGHT"]).default(""),
  variants: z.string().transform((s) => JSON.parse(s)).pipe(z.array(VariantSchema).min(1)),
});

export async function saveProduct(prev: ProductFormState, fd: FormData): Promise<ProductFormState> {
  const r = await saveProductInner(prev, fd);
  return r?.error ? { ...r, values: Object.fromEntries(KEEP.map((k) => [k, String(fd.get(k) ?? "")])) } : r;
}

async function saveProductInner(_: ProductFormState, fd: FormData): Promise<ProductFormState> {
  const session = await requirePerm("products.edit");
  const { image: _img, ...fields } = Object.fromEntries(fd);
  const parsed = ProductSchema.safeParse(fields);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: "required", field: String(issue.path[0] ?? "") };
  }
  const d = parsed.data;
  const keys = new Set<string>();
  for (const v of d.variants) {
    const k = `${v.size.toLowerCase()}|${v.color.toLowerCase()}`;
    if (keys.has(k)) return { error: "duplicateVariant" };
    keys.add(k);
  }
  const barcodes = d.variants.map((v) => v.barcode).filter(Boolean);
  if (new Set(barcodes).size !== barcodes.length) return { error: "barcodeTaken" };
  const weights = d.variants.map((v) => parseWeight(v.weight, v.weightUnit));
  if (weights.some((w) => w === undefined)) return { error: "weightInvalid" };
  const dims = d.variants.map((v) => parseDims(v.pkgL, v.pkgW, v.pkgH));
  if (dims.some((x) => x === undefined)) return { error: "pkgInvalid" };
  // eigene Preise je Größe/Farbe: leer (oder 0) = Artikelpreis, unlesbar → verständliche Meldung
  const ownCents = (txt: string): number | null | undefined => {
    if (!txt) return null;
    const c = parseMoney(txt);
    return c == null || c < 0 ? undefined : c === 0 ? null : c;
  };
  const rawPrices = d.variants.map((v) => ({ p: ownCents(v.purchasePrice), w: ownCents(v.wholesalePrice), r: ownCents(v.retailPrice) }));
  if (rawPrices.some((x) => x.p === undefined || x.w === undefined || x.r === undefined)) return { error: "variantPrice" };
  const vPrices = rawPrices.map((x) => ({ p: x.p ?? null, w: x.w ?? null, r: x.r ?? null }));
  // Art.-Nr. = Barcode (Wunsch Inhaber 03.11.2026): leer gelassen → Barcode der ersten Variante mit Barcode
  const sku = d.sku || barcodes[0] || "";
  if (!sku) return { error: "skuOrBarcode" };

  // Fotos (vorher, außerhalb der Transaktion; Dateien sind unveränderlich)
  let imageFileId: string | null | undefined;
  const variantImages = new Map<string, string | null>();
  try {
    const img = await storeImage(fd.get("image") as File | null);
    if (img) imageFileId = img; else if (fd.get("imageRemove") === "1") imageFileId = null;
    else if (!d.id && typeof fd.get("imageFrom") === "string") imageFileId = await copyManualPhoto(String(fd.get("imageFrom"))) ?? undefined;
    for (const v of d.variants) {
      if (!v.ref) continue;
      const vi = await storeImage(fd.get(`vimg_${v.ref}`) as File | null);
      if (vi) variantImages.set(v.ref, vi); else if (fd.get(`vimg_${v.ref}Remove`) === "1") variantImages.set(v.ref, null);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return { error: msg === "fileTooLarge" ? "fileTooLarge" : "imageType" };
  }

  // Preise (und MwSt.-Satz, er ändert den Shop-Preis) nur mit Recht „Preise ändern“, Einkaufspreis nur mit Recht
  // „Einkaufspreis sehen“, Anfangsbestand nur mit Recht „Wareneingang“ – sonst bleiben die bisherigen Werte
  const prev = d.id ? await db.query.products.findFirst({ where: eq(schema.products.id, d.id) }) : undefined;
  const canPrices = can(session, "products.prices"), canCost = can(session, "products.cost");
  if (!can(session, "stock.receive")) for (const v of d.variants) v.initialQty = 0;
  const values = {
    sku, nameDe: d.nameDe, nameNl: d.nameNl, descriptionDe: d.descriptionDe, descriptionNl: d.descriptionNl,
    category: d.category, supplierId: d.supplierId || null, vatRateBp: canPrices || !prev ? d.vatRateBp : prev.vatRateBp,
    purchasePriceCents: canCost ? d.purchasePrice : (prev?.purchasePriceCents ?? 0),
    wholesalePriceCents: canPrices ? d.wholesalePrice : (prev?.wholesalePriceCents ?? 0),
    retailPriceCents: canPrices ? d.retailPrice : (prev?.retailPriceCents ?? 0),
    tracksExpiry: d.tracksExpiry, inBrandShop: d.inBrandShop, inGeneralShop: d.inGeneralShop,
    shippingClass: d.shippingClass || null,
    ...(imageFileId !== undefined ? { imageFileId } : {}),
  };

  let productId = d.id;
  const weightChanged: string[] = []; // an die Shops melden
  const galleryChanged: ShopChannel[] = []; // eigene Shop-Fotos geändert → im Hintergrund an verbundene Shops
  let categoryChanged = false; // → im Shop den Produkttyp verbundener Produkte anpassen
  let priceChanged = false; // → Shop-Preis der verbundenen Varianten gleich melden
  let resellerChanged = false;
  try {
    await db.transaction(async (tx) => {
      // Kategorie so schreiben, wie sie im Verzeichnis steht (Groß/klein); neue kommen ins Verzeichnis (Seite „Kategorien“)
      values.category = await canonicalCategory(tx, d.category);
      // Eindeutigkeit vorab prüfen → verständliche Fehlermeldung
      // erst Barcode (Art.-Nr. = Barcode: ist er vergeben, ist das die verständlichere Meldung), dann Art.-Nr.
      if (barcodes.length) {
        const taken = await tx.select({ productId: schema.variants.productId }).from(schema.variants)
          .where(inArray(schema.variants.barcode, barcodes));
        if (taken.some((t) => t.productId !== d.id)) throw new Error("barcodeTaken");
      }
      const skuOwner = await tx.query.products.findFirst({ where: eq(schema.products.sku, sku) });
      if (skuOwner && skuOwner.id !== d.id) throw new Error("skuTaken");

      if (d.id) {
        const before = await tx.query.products.findFirst({ where: eq(schema.products.id, d.id) });
        if (!before) throw new Error("notFound");
        await tx.update(schema.products).set(values).where(eq(schema.products.id, d.id));
        await audit(tx, { entity: "product", entityId: d.id, action: "update", before, after: values, userId: session.uid });
        categoryChanged = before.category !== values.category;
        // Shop-Preis geändert (Großhandelspreis Salon oder MwSt.) → an verbundene Shop-Varianten melden (Wunsch Inhaber 09.11.2026)
        priceChanged = before.retailPriceCents !== values.retailPriceCents || before.vatRateBp !== values.vatRateBp;
        // Großhandelspreis (جملة الجملة) → Preisliste der Wiederverkäufer im Shop (Shopify B2B)
        resellerChanged = before.wholesalePriceCents !== values.wholesalePriceCents || before.vatRateBp !== values.vatRateBp;
        // (geänderte eigene Preise einer Größe/Farbe kommen unten bei den Varianten dazu; vorgemerkt wird danach)
      } else {
        const [p] = await tx.insert(schema.products).values(values).returning({ id: schema.products.id });
        productId = p.id;
        await audit(tx, { entity: "product", entityId: p.id, action: "create", after: values, userId: session.uid });
      }

      // Varianten: bestehende aktualisieren, neue anlegen, entfernte deaktivieren (Historie bleibt erhalten)
      // Barcodes dieses Artikels zuerst leeren, damit Tausch zwischen Varianten möglich ist
      await tx.update(schema.variants).set({ barcode: null }).where(eq(schema.variants.productId, productId!));
      const opening: { variantId: string; qty: number; expiryDate: string | null; unitCostCents: number }[] = [];
      const oldRows = await tx.select({
        id: schema.variants.id, size: schema.variants.size, color: schema.variants.color, w: schema.variants.weightGrams, l: schema.variants.pkgLengthMm, b: schema.variants.pkgWidthMm, h: schema.variants.pkgHeightMm,
        pp: schema.variants.purchasePriceCents, wp: schema.variants.wholesalePriceCents, rp: schema.variants.retailPriceCents,
      }).from(schema.variants).where(eq(schema.variants.productId, productId!));
      const oldWeights = new Map(oldRows.map((r) => [r.id, r.w]));
      const oldDims = new Map(oldRows.map((r) => [r.id, r.l && r.b && r.h ? [r.l, r.b, r.h] : null]));
      // bisherige eigene Preise (auch einer früher entfernten Größe/Farbe, die gleich wieder auflebt – gefunden über Größe/Farbe)
      const oldPrice = (v: { id?: string; size: string; color: string }) => {
        const row = oldRows.find((r) => (v.id ? r.id === v.id : r.size === v.size && r.color === v.color));
        return row ? { id: row.id, p: row.pp ?? null, w: row.wp ?? null, r: row.rp ?? null } : null;
      };
      for (const [vi, v] of d.variants.entries()) {
        const weightGrams = weights[vi] ?? null;
        const pkg = dims[vi] ?? null;
        // eigene Preise: gleich dem Artikelpreis = keiner (folgt dann dem Artikel); ohne Recht bleibt der bisherige Wert
        const old = oldPrice(v);
        const own = (c: number | null, base: number) => (c != null && c !== base ? c : null);
        const price = {
          purchasePriceCents: canCost ? own(vPrices[vi].p, values.purchasePriceCents) : (old?.p ?? null),
          wholesalePriceCents: canPrices ? own(vPrices[vi].w, values.wholesalePriceCents) : (old?.w ?? null),
          retailPriceCents: canPrices ? own(vPrices[vi].r, values.retailPriceCents) : (old?.r ?? null),
        };
        vPrices[vi].p = price.purchasePriceCents; // für den Anfangsbestand unten
        if (old && d.id) {
          const before = { purchasePriceCents: old.p, wholesalePriceCents: old.w, retailPriceCents: old.r };
          if (JSON.stringify(before) !== JSON.stringify(price))
            await audit(tx, { entity: "variant", entityId: old.id, action: "prices", before, after: price, userId: session.uid });
          if ((old.r ?? null) !== price.retailPriceCents) priceChanged = true;
          if ((old.w ?? null) !== price.wholesalePriceCents) resellerChanged = true;
        }
        const vals = {
          size: v.size, color: v.color, barcode: v.barcode || null, minStock: v.minStock, active: true, weightGrams,
          pkgLengthMm: pkg?.l ?? null, pkgWidthMm: pkg?.w ?? null, pkgHeightMm: pkg?.h ?? null, ...price,
          ...(variantImages.has(v.ref) ? { imageFileId: variantImages.get(v.ref) ?? null } : {}),
        };
        if (v.id && oldWeights.has(v.id) && (oldWeights.get(v.id) ?? null) !== weightGrams) {
          await audit(tx, { entity: "variant", entityId: v.id, action: "weight", before: { weightGrams: oldWeights.get(v.id) ?? null }, after: { weightGrams }, userId: session.uid });
          if (weightGrams) weightChanged.push(v.id);
        }
        const newDims = pkg ? [pkg.l, pkg.w, pkg.h] : null;
        if (v.id && oldDims.has(v.id) && JSON.stringify(oldDims.get(v.id) ?? null) !== JSON.stringify(newDims))
          await audit(tx, { entity: "variant", entityId: v.id, action: "package", before: { pkgMm: oldDims.get(v.id) ?? null }, after: { pkgMm: newDims }, userId: session.uid });
        if (v.id) await tx.update(schema.variants).set(vals).where(and(eq(schema.variants.id, v.id), eq(schema.variants.productId, productId!)));
        else {
          // evtl. früher deaktivierte Variante mit gleicher Größe/Farbe reaktivieren
          const existing = await tx.query.variants.findFirst({
            where: and(eq(schema.variants.productId, productId!), eq(schema.variants.size, v.size), eq(schema.variants.color, v.color)),
          });
          let variantId = existing?.id;
          if (existing) await tx.update(schema.variants).set(vals).where(eq(schema.variants.id, existing.id));
          else [{ id: variantId }] = await tx.insert(schema.variants).values({ productId: productId!, ...vals }).returning({ id: schema.variants.id });
          if (v.initialQty > 0) opening.push({ variantId: variantId!, qty: v.initialQty, expiryDate: d.tracksExpiry && v.initialExpiry ? v.initialExpiry : null, unitCostCents: vPrices[vi].p ?? values.purchasePriceCents });
        }
      }
      // Shop-Preis bzw. Preisliste der Wiederverkäufer geändert (Artikel oder eine Größe/Farbe) → an die verbundenen Shops melden
      if (d.id && (priceChanged || resellerChanged))
        await tx.insert(schema.shopPriceDirty).values({ productId: d.id }).onConflictDoUpdate({ target: schema.shopPriceDirty.productId, set: { at: new Date() } });
      const activeIds = (await tx.select({ id: schema.variants.id }).from(schema.variants)
        .where(and(eq(schema.variants.productId, productId!), eq(schema.variants.active, true)))).map((r) => r.id);
      const wanted = new Set<string>();
      for (const v of d.variants) {
        const row = await tx.query.variants.findFirst({
          where: and(eq(schema.variants.productId, productId!), eq(schema.variants.size, v.size), eq(schema.variants.color, v.color)),
        });
        if (row) wanted.add(row.id);
      }
      const drop = activeIds.filter((id) => !wanted.has(id));
      if (drop.length) {
        const withStock = await tx.select({ id: schema.variants.id }).from(schema.variants)
          .where(and(inArray(schema.variants.id, drop), ne(schema.variants.stockQty, 0)));
        if (withStock.length) throw new Error("variantHasStock");
        await tx.update(schema.variants).set({ active: false, barcode: null }).where(inArray(schema.variants.id, drop));
      }

      // Eigene Fotos je Shop (Galerie). Fehlt das Feld (Shop nicht angehakt), bleibt die Galerie unverändert.
      // Im Shop gelöscht wird nur, was beim Entfernen ausdrücklich so gewählt wurde (Wunsch Inhaber 04.11.2026).
      for (const channel of ["BRAND_SHOP", "GENERAL_SHOP"] as const) {
        const input = parseGalleryInput(fd.get(`gallery_${channel}`));
        if (input && await saveGalleryTx(tx, productId!, channel, input, session.uid)) galleryChanged.push(channel);
      }

      // Vorhandene Ware gleich mitbuchen – als normaler Wareneingang (Charge, EK, Nummer, Protokoll)
      if (opening.length) {
        await receiveGoodsTx(tx, {
          supplierId: d.supplierId || null, date: todayIso(), supplierInvoiceNo: "", note: "Anfangsbestand beim Anlegen",
          lines: opening.map((o) => ({ variantId: o.variantId, qty: o.qty, unitCostCents: o.unitCostCents, batchNo: "", expiryDate: o.expiryDate })),
        }, session.uid);
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "skuTaken" || msg === "barcodeTaken" || msg === "variantHasStock") return { error: msg };
    if (/variants_barcode_unique|barcode/.test(msg)) return { error: "barcodeTaken" };
    if (/products_sku_unique/.test(msg)) return { error: "skuTaken" };
    console.error(e);
    return { error: "error" };
  }
  revalidatePath("/products");
  revalidatePath("/stock");
  revalidatePath("/shops", "layout");
  // In die Shops nur nach Rückfrage (Wunsch Inhaber): „Ja, echter Artikel“ → hochladen, sonst bleibt er unter „Noch nicht im Shop“.
  // Fehler beim Shop ändern nichts am Speichern.
  let push = "";
  try {
    if (fd.get("shopPush") === "1") {
      // im Dialog gewählte Shop-Kategorie für unsere Kategorie merken (gilt für alle Artikel dieser Kategorie)
      for (const channel of ["BRAND_SHOP", "GENERAL_SHOP"] as const) {
        const type = String(fd.get(`storeType_${channel}`) ?? "").trim();
        if (type && d.category) await setCategoryMapping(channel, d.category, type, session.uid);
      }
      push = encodePush(await pushProductToShops(productId!, session.uid));
    } else {
      push = encodePush((await pushTargets(productId!)).map((channel) => ({ channel, outcome: "notNow" as const })));
    }
  } catch (e) { console.error("shopify push", e); }
  // geändertes Gewicht der schon verbundenen Größen/Farben im Hintergrund an die Shops (Versand nach Gewicht)
  pushWeightsLater(weightChanged);
  // geänderter Preis → gleich an die Shops (nur wo er dort abweicht); wartet höchstens 8 s, das Ergebnis steht über dem Formular.
  // Klappt es nicht, bleibt die Vormerkung und der Worker versucht es alle 5 min wieder.
  let price = "";
  if (priceChanged || resellerChanged) {
    try {
      const res = await pushProductPrices(productId!);
      if (priceChanged) price = encodePriceNotes(res);
    } catch (e) { console.error("shopify prices", e); }
  }
  // Kategorie geändert → verbundene Shop-Produkte wandern in die passende Kollektion; geänderte Shop-Fotos abgleichen
  if (categoryChanged) syncProductTypesLater([productId!]);
  // Versandart (aus Gewicht/Paketmaßen oder fest eingestellt) → Tag „spedition“ an den verbundenen Shop-Produkten
  pushFreightTagsLater([productId!]);
  syncGalleryLater(productId!, galleryChanged);
  redirect(`/products/${productId}?saved=1${push ? `&push=${encodeURIComponent(push)}` : ""}${price ? `&price=${encodeURIComponent(price)}` : ""}`);
}

/** Ein Foto für die Shop-Galerie sofort speichern (im Browser schon verkleinert) → ID für das Formular */
export async function uploadShopPhoto(fd: FormData): Promise<{ id?: string; error?: string }> {
  await requirePerm("products.edit");
  try {
    const id = await storeImage(fd.get("file") as File | null);
    return id ? { id } : { error: "imageType" };
  } catch (e) {
    return { error: e instanceof Error && e.message === "fileTooLarge" ? "fileTooLarge" : "imageType" };
  }
}

const isChannel = (c: unknown): c is ShopChannel => c === "BRAND_SHOP" || c === "GENERAL_SHOP";

/** „Fotos aus dem Shop holen“: vorhandene Fotos eines verbundenen Artikels als Galerie übernehmen */
export async function adoptShopPhotos(productId: string, channel: string): Promise<AdoptResult> {
  const session = await requirePerm("products.edit");
  if (!isChannel(channel) || typeof productId !== "string") return { ok: false, error: "failed" };
  const r = await adoptShopGallery(productId, channel, session.uid);
  if (r.ok) revalidatePath(`/products/${productId}`);
  return r;
}

/** „Erneut senden“, wenn Fotos nicht in den Shop gekommen sind */
export async function resendShopPhotos(productId: string, channel: string): Promise<GallerySync> {
  await requirePerm("products.edit");
  if (!isChannel(channel) || typeof productId !== "string") return { status: "failed" };
  const r = await syncGallery(productId, channel);
  revalidatePath(`/products/${productId}`);
  return r;
}

/** Test- oder Fehleintrag endgültig löschen (nur wenn nie verkauft, angeboten oder als Verlust gebucht) */
export async function deleteProductAction(_: ProductFormState, fd: FormData): Promise<ProductFormState> {
  const session = await requirePerm("products.edit");
  try {
    await deleteProduct(String(fd.get("id") ?? ""), session.uid);
  } catch (e) {
    if (e instanceof ProductDeleteError) return { error: e.code };
    console.error(e);
    return { error: "error" };
  }
  revalidatePath("/", "layout"); // Artikel, Lager, Wareneingang, „Erste Schritte“
  redirect("/products");
}

export async function setProductActive(id: string, active: boolean) {
  const session = await requirePerm("products.edit");
  await db.transaction(async (tx) => {
    await tx.update(schema.products).set({ active }).where(eq(schema.products.id, id));
    await audit(tx, { entity: "product", entityId: id, action: active ? "activate" : "deactivate", userId: session.uid });
  });
  revalidatePath("/products");
}

