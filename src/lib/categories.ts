import "server-only";
/**
 * Kategorien (Wunsch Inhaber 04.11.2026): eigene Seite im Menü. Kategorie anlegen → auf Wunsch gleich in den Shops (Kollektion +
 * Menü), Artikel hinein- oder herausschieben → im Shop wandert das Produkt mit (Produkttyp). Artikel verweisen weiter per Name
 * (products.category) – die Tabelle `categories` ist das Verzeichnis (auch leere Kategorien) und merkt sich unsere Shop-Kollektionen.
 */
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";
import { getShop, type Shop, type ShopChannel } from "./shopify/client";
import { CHANNELS, logEvent } from "./shopify/sync";
import { configured, shopAdminUrl } from "./shopify/admin";
import { getStoreTypes } from "./shopify/product-push";
import { categoryStoreState, cleanCategoryName, type CategoryStoreState } from "./shopify/category-map";
import { createStoreCategory, deleteStoreCollection, navigation, syncProductTypes, type StoreCategoryResult, type TypeSync } from "./shopify/collections";
import type { StoreType } from "./shopify/product-push-map";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Db = typeof db | Tx;

/** Kategorien, die nur an Artikeln stehen (z. B. aus dem Shop-Import), ins Verzeichnis übernehmen – je Name einmal, Groß/klein egal */
export async function syncCategoryTable(x: Db = db) {
  await x.execute(sql`insert into categories (id, name)
    select gen_random_uuid()::text, min(trim(category)) from products where trim(category) <> '' group by lower(trim(category))
    on conflict do nothing`);
}

/** Name so, wie er schon im Verzeichnis steht (Groß/klein), sonst neu eintragen. "" bleibt "". */
export async function canonicalCategory(x: Db, raw: string): Promise<string> {
  const name = cleanCategoryName(raw);
  if (!name) return "";
  const hit = await x.select({ name: schema.categories.name }).from(schema.categories).where(sql`lower(${schema.categories.name}) = lower(${name})`).limit(1);
  if (hit[0]) return hit[0].name;
  await x.insert(schema.categories).values({ name }).onConflictDoNothing();
  return name;
}

/** Namen fürs Auswahlfeld im Artikel-Formular */
export async function categoryNames(): Promise<string[]> {
  await syncCategoryTable();
  return (await db.select({ name: schema.categories.name }).from(schema.categories).orderBy(asc(schema.categories.name))).map((r) => r.name);
}

// ───────────────────────── Shops: Kategorien des Shops (zwischengespeichert) ─────────────────────────

export type StoreCtx = { channel: ShopChannel; shop: Shop; types: StoreType[]; map: Record<string, string> };

/** Eingerichtete Shops mit ihren Kategorien – höchstens stündlich frisch, nie länger als 3 s warten */
export async function storeContexts(): Promise<StoreCtx[]> {
  const all = await Promise.all(CHANNELS.map(async (channel): Promise<StoreCtx | null> => {
    const shop = await getShop(channel);
    if (!configured(shop)) return null;
    const types = await Promise.race([getStoreTypes(shop, 3600_000), new Promise<StoreType[]>((r) => setTimeout(() => r(shop.storeTypes ?? []), 3000))]);
    return { channel, shop, types, map: shop.categoryMap ?? {} };
  }));
  return all.filter((x): x is StoreCtx => x !== null);
}

export type CategoryInfo = {
  id: string; name: string; n: number; createdAt: Date;
  ours: Partial<Record<ShopChannel, string>>;
  stores: Partial<Record<ShopChannel, CategoryStoreState>>;
};

export async function listCategories(stores: StoreCtx[]): Promise<CategoryInfo[]> {
  await syncCategoryTable();
  const rows = await db.execute<{ id: string; name: string; shop_collections: Partial<Record<ShopChannel, string>>; created_at: Date; n: number }>(sql`
    select c.id, c.name, c.shop_collections, c.created_at,
      (select count(*)::int from products p where p.active and lower(trim(p.category)) = lower(c.name)) as n
    from categories c order by lower(c.name)`);
  return rows.rows.map((r) => ({
    id: r.id, name: r.name, n: Number(r.n), createdAt: new Date(r.created_at), ours: r.shop_collections ?? {},
    stores: Object.fromEntries(stores.map((s) => [s.channel, categoryStoreState(r.name, s.types, s.map)])),
  }));
}

export async function getCategory(id: string) {
  return db.query.categories.findFirst({ where: eq(schema.categories.id, id) });
}

export type CategoryProduct = {
  id: string; sku: string; nameDe: string; imageId: string | null; active: boolean; barcode: string | null;
  linked: ShopChannel[]; inBrandShop: boolean; inGeneralShop: boolean;
};

export async function categoryProducts(name: string): Promise<CategoryProduct[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    select p.id, p.sku, p.name_de, p.image_file_id, p.active, p.in_brand_shop, p.in_general_shop,
      (select v.barcode from variants v where v.product_id = p.id and v.active and coalesce(v.barcode, '') <> '' order by v.created_at limit 1) as barcode,
      coalesce((select array_agg(distinct sv.channel::text) from shop_variants sv join variants v on v.id = sv.variant_id where v.product_id = p.id), '{}') as linked
    from products p where lower(trim(p.category)) = lower(${name})
    order by p.active desc, p.name_de, p.id`);
  return r.rows.map((x) => ({
    id: String(x.id), sku: String(x.sku), nameDe: String(x.name_de), imageId: (x.image_file_id as string | null) ?? null, active: Boolean(x.active),
    barcode: (x.barcode as string | null) ?? null, linked: ((x.linked as string[] | null) ?? []).filter((c): c is ShopChannel => c === "BRAND_SHOP" || c === "GENERAL_SHOP"),
    inBrandShop: Boolean(x.in_brand_shop), inGeneralShop: Boolean(x.in_general_shop),
  }));
}

// ───────────────────────── Anlegen / im Shop anlegen ─────────────────────────

export class CategoryError extends Error {
  constructor(public code: "nameRequired" | "exists" | "notFound" | "notEmpty" | "storeNotEmpty" | "storeMenu" | "storeFailed") { super(code); }
}

/** Neue Kategorie; channels = in diesen Shops gleich mit anlegen (groups: Menügruppe je Shop, null = nicht ins Menü) */
export async function createCategory(input: { name: string; channels: ShopChannel[]; groups?: Partial<Record<ShopChannel, string | null>> }, userId?: string) {
  const name = cleanCategoryName(input.name);
  if (!name) throw new CategoryError("nameRequired");
  await syncCategoryTable();
  const id = await db.transaction(async (tx) => {
    const exists = await tx.select({ id: schema.categories.id }).from(schema.categories).where(sql`lower(${schema.categories.name}) = lower(${name})`).limit(1);
    if (exists.length) throw new CategoryError("exists");
    const [row] = await tx.insert(schema.categories).values({ name }).returning({ id: schema.categories.id });
    await audit(tx, { entity: "category", entityId: row.id, action: "create", after: { name }, userId });
    return row.id;
  });
  const results: StoreCategoryResult[] = [];
  for (const c of input.channels) results.push(await addCategoryToStore(id, c, input.groups?.[c] ?? null, userId));
  return { id, name, results };
}

/** Kategorie in einem Shop anlegen (Kollektion + ggf. Menü). Artikel dieser Kategorie, die dort schon verbunden sind, wandern mit. */
export async function addCategoryToStore(categoryId: string, channel: ShopChannel, groupId: string | null, userId?: string): Promise<StoreCategoryResult> {
  const cat = await getCategory(categoryId);
  if (!cat) throw new CategoryError("notFound");
  const r = await createStoreCategory(channel, cat.name, groupId);
  if (r.collectionId) {
    const ours = { ...(cat.shopCollections ?? {}), [channel]: r.collectionId };
    await db.transaction(async (tx) => {
      await tx.update(schema.categories).set({ shopCollections: ours }).where(eq(schema.categories.id, categoryId));
      await audit(tx, { entity: "category", entityId: categoryId, action: "shop_create", after: { channel, collectionId: r.collectionId, menu: r.menu ?? null }, userId });
    });
  }
  if (r.outcome === "created" || r.outcome === "createdHidden" || r.outcome === "exists") {
    // schon verbundene Artikel dieser Kategorie in die (neue) Kollektion – im Hintergrund, kann bei vielen Artikeln dauern
    const ids = (await categoryProducts(cat.name)).filter((p) => p.linked.includes(channel)).map((p) => p.id);
    if (ids.length) void syncProductTypes(ids, channel).catch((e) => console.error("category types", e));
  }
  return r;
}

// ───────────────────────── Artikel verschieben ─────────────────────────

export type MoveResult = { name: string; before: string; category: string; shops: TypeSync[] };

/** Artikel in eine Kategorie (categoryId null = ohne Kategorie). Im Shop wandert das verbundene Produkt mit (Produkttyp). */
export async function moveProductToCategory(productId: string, categoryId: string | null, userId?: string): Promise<MoveResult> {
  const cat = categoryId ? await getCategory(categoryId) : null;
  if (categoryId && !cat) throw new CategoryError("notFound");
  const target = cat?.name ?? "";
  const before = await db.transaction(async (tx) => {
    const p = await tx.query.products.findFirst({ where: eq(schema.products.id, productId) });
    if (!p) throw new CategoryError("notFound");
    if (p.category !== target) {
      await tx.update(schema.products).set({ category: target }).where(eq(schema.products.id, productId));
      await audit(tx, { entity: "product", entityId: productId, action: "update", before: { category: p.category }, after: { category: target }, userId });
    }
    return { name: p.nameDe, category: p.category };
  });
  const shops = before.category === target || !target ? [] : await syncProductTypes([productId]);
  return { name: before.name, before: before.category, category: target, shops };
}

// ───────────────────────── Löschen (nur leer) ─────────────────────────

/** Leere Kategorie löschen; Kollektionen, die WIR im Shop angelegt haben, nur wenn sie dort auch leer sind (vorher aus dem Menü). */
export async function deleteCategory(id: string, userId?: string) {
  const cat = await getCategory(id);
  if (!cat) throw new CategoryError("notFound");
  const used = await db.execute<{ n: number }>(sql`select count(*)::int as n from products where lower(trim(category)) = lower(${cat.name})`);
  if (Number(used.rows[0]?.n ?? 0) > 0) throw new CategoryError("notEmpty");
  const removed: Partial<Record<ShopChannel, string>> = {};
  for (const [channel, collectionId] of Object.entries(cat.shopCollections ?? {}) as [ShopChannel, string][]) {
    if (!collectionId) continue;
    let r: Awaited<ReturnType<typeof deleteStoreCollection>>;
    try { r = await deleteStoreCollection(channel, collectionId); }
    catch (e) { console.error("category delete store", e); throw new CategoryError("storeFailed"); }
    if (r === "notEmpty") throw new CategoryError("storeNotEmpty");
    if (r === "menu") throw new CategoryError("storeMenu");
    if (r === "deleted") { removed[channel] = collectionId; await logEvent(channel, "info", "products", `categoryDeleted:${cat.name}`); }
  }
  await db.transaction(async (tx) => {
    await tx.delete(schema.categories).where(eq(schema.categories.id, id));
    await audit(tx, { entity: "category", entityId: id, action: "delete", before: { name: cat.name, shopCollections: cat.shopCollections }, after: { removedInShop: removed }, userId });
  });
  return { name: cat.name, removed };
}

export type StoreNav = { channel: ShopChannel; access: boolean | null; groups: { id: string; title: string }[]; adminUrl: string };

/** Menü-Gruppen je Shop (für „Im Shop-Menü unter …“) – nie länger als 3 s warten; access null = gerade unbekannt */
export async function storeNavs(stores: StoreCtx[]): Promise<StoreNav[]> {
  return Promise.all(stores.map(async (s) => {
    const fallback: StoreNav = { channel: s.channel, access: null, groups: [], adminUrl: shopAdminUrl(s.shop, "/menus") };
    const nav = await Promise.race([
      navigation(s.shop).then((n) => ({ channel: s.channel, access: n.access, groups: n.groups, adminUrl: n.adminUrl })).catch(() => fallback),
      new Promise<StoreNav>((r) => setTimeout(() => r(fallback), 3000)),
    ]);
    return nav;
  }));
}
