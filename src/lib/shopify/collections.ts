import "server-only";
/**
 * Kategorien im Shop (Wunsch Inhaber 04.11.2026): Kategorie anlegen → im Shop automatische Kollektion „Produkttyp ist gleich <Name>“,
 * im Online Store veröffentlicht, auf Wunsch als Punkt im Hauptmenü unter einer Gruppe. Artikel einer Kategorie bekommen im Shop den
 * passenden Produkttyp (dadurch landen sie in der Kollektion) – auch wenn man sie später in eine andere Kategorie verschiebt.
 * Rechte: write_products (Kollektion, Produkttyp), write_publications (veröffentlichen); fürs Menü read/write_online_store_navigation –
 * fehlt das, bleibt alles andere gleich und die Seite zeigt einen Link zur Navigation im Shopify-Admin.
 * API 2026-07: collectionCreate(input) mit ruleSet (ab 2026-10 veraltet → collection/sources).
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { gql, getShop, ShopifyError, type Shop, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { configured, publishToOnlineStore, shopAdminUrl, withFreshToken } from "./admin";
import { getStoreTypes } from "./product-push";
import { resolveStoreType, storeTypeLabel } from "./product-push-map";
import { categoryStoreState, collectionInput, menuDepth, menuGroups, menuHas, menuWithCollection, menuWithout, type MenuItem } from "./category-map";

const errs = (list: { message: string }[] | undefined) => (list ?? []).map((e) => e.message).join("; ").slice(0, 300);

// ───────────────────────── Menü ─────────────────────────

const MENU_Q = `fragment F on MenuItem { id title type resourceId url tags }
{ menus(first: 25) { nodes { id handle title items { ...F items { ...F items { ...F items { id } } } } } } }`;
type RawItem = { id: string; title: string; type: string; resourceId: string | null; url: string | null; tags: string[]; items?: RawItem[] };
type Menu = { id: string; handle: string; title: string; items: MenuItem[] };

// Recht für die Navigation fehlt → 6 Stunden nicht erneut fragen, im Protokoll höchstens 1×/Tag
const navDenied = new Map<ShopChannel, number>();
const navLogged = new Map<ShopChannel, number>();
const isDenied = (e: unknown) => e instanceof ShopifyError && /access denied|online_store_navigation/i.test(e.message);

const toItem = (r: RawItem): MenuItem => ({ id: r.id, title: r.title, type: r.type, resourceId: r.resourceId, url: r.url, tags: r.tags ?? [], items: (r.items ?? []).map(toItem) });

export type Navigation = { access: boolean; menu: Menu | null; groups: { id: string; title: string }[]; adminUrl: string };

/** Hauptmenü des Shops (für die Auswahl „Im Shop-Menü unter …“). access = false: der Shop-App fehlt das Recht. */
export async function navigation(shop: Shop): Promise<Navigation> {
  const ch = shop.channel as ShopChannel;
  const adminUrl = shopAdminUrl(shop, "/menus");
  const denied = navDenied.get(ch);
  if (denied && Date.now() - denied < 6 * 3600_000) return { access: false, menu: null, groups: [], adminUrl };
  try {
    const d = await gql<{ menus: { nodes: { id: string; handle: string; title: string; items: RawItem[] }[] } }>(shop, MENU_Q);
    const m = d.menus.nodes.find((x) => x.handle === "main-menu") ?? d.menus.nodes[0];
    if (!m) return { access: true, menu: null, groups: [], adminUrl };
    const menu = { id: m.id, handle: m.handle, title: m.title, items: m.items.map(toItem) };
    navDenied.delete(ch);
    return { access: true, menu, groups: menuGroups(menu.items), adminUrl: shopAdminUrl(shop, `/menus/${m.id.split("/").pop()}`) };
  } catch (e) {
    if (!isDenied(e)) throw e;
    navDenied.set(ch, Date.now());
    const last = navLogged.get(ch) ?? 0;
    if (Date.now() - last > 24 * 3600_000) {
      navLogged.set(ch, Date.now());
      await logEvent(ch, "info", "products", "needScopeNavigation").catch(() => {});
    }
    return { access: false, menu: null, groups: [], adminUrl };
  }
}

const MENU_UPDATE_M = `mutation($id: ID!, $title: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, items: $items) { menu { id } userErrors { field message } } }`;

async function updateMenu(shop: Shop, menu: Menu, items: unknown[]) {
  const r = await gql<{ menuUpdate: { userErrors: { message: string }[] } }>(shop, MENU_UPDATE_M, { id: menu.id, title: menu.title, items });
  if (r.menuUpdate.userErrors.length) throw new ShopifyError("userErrors", errs(r.menuUpdate.userErrors));
}

export type MenuOutcome = "added" | "exists" | "noAccess" | "skipped" | "failed";

/** Kollektion ins Hauptmenü unter die Gruppe (groupId; "" = oben). Nie bei unerwartet tiefem Menü (wir könnten Punkte verlieren). */
export async function addToMenu(shop: Shop, groupId: string, c: { id: string; title: string; handle: string }): Promise<MenuOutcome> {
  let nav: Navigation;
  try { nav = await navigation(shop); } catch (e) { console.error("shopify menu", e); return "failed"; }
  if (!nav.access) return "noAccess";
  if (!nav.menu) return "failed";
  if (menuHas(nav.menu.items, c.id)) return "exists";
  if (menuDepth(nav.menu.items) > 3) return "failed";
  const items = menuWithCollection(nav.menu.items, groupId, c);
  if (!items) return "failed";
  try { await updateMenu(shop, nav.menu, items); return "added"; }
  catch (e) {
    if (isDenied(e)) { navDenied.set(shop.channel as ShopChannel, Date.now()); return "noAccess"; }
    console.error("shopify menu update", e);
    return "failed";
  }
}

// ───────────────────────── Kollektion anlegen / löschen ─────────────────────────

const COLLECTION_CREATE_M = `mutation($input: CollectionInput!) { collectionCreate(input: $input) {
  collection { id handle title } userErrors { field message } } }`;

export type StoreCategoryResult = {
  channel: ShopChannel;
  outcome: "created" | "createdHidden" | "exists" | "failed" | "notConfigured";
  label?: string; collectionId?: string; menu?: MenuOutcome; detail?: string;
};

/** Kategorie im Shop anlegen (gibt es sie dort schon unter gleichem Namen → nur melden). groupId: null = nicht ins Menü. */
export async function createStoreCategory(channel: ShopChannel, name: string, groupId: string | null): Promise<StoreCategoryResult> {
  const shop = await getShop(channel);
  if (!configured(shop)) return { channel, outcome: "notConfigured" };
  try {
    const types = await getStoreTypes(shop, 0, true);
    const st = categoryStoreState(name, types, {});
    if (st.state === "same") return { channel, outcome: "exists", label: st.label };
    const d = await withFreshToken(shop, () => gql<{ collectionCreate: { collection: { id: string; handle: string; title: string } | null; userErrors: { message: string }[] } }>(
      shop, COLLECTION_CREATE_M, { input: collectionInput(name) }));
    const c = d.collectionCreate.collection;
    if (d.collectionCreate.userErrors.length || !c) throw new ShopifyError("userErrors", errs(d.collectionCreate.userErrors) || "collectionCreate");
    let visible = false;
    try { visible = await withFreshToken(shop, () => publishToOnlineStore(shop, c.id)); }
    catch (e) { console.error("shopify collection publish", e); }
    // ohne Menü-Wunsch trotzdem sagen, ob es am fehlenden Recht liegt (die Auswahl fehlt dann im Formular)
    const menu: MenuOutcome = groupId !== null ? await addToMenu(shop, groupId, c)
      : (await navigation(shop).catch(() => null))?.access === false ? "noAccess" : "skipped";
    await getStoreTypes(shop, 0).catch(() => []); // neue Kategorie gleich in der Auswahl
    await logEvent(channel, visible ? "info" : "warn", "products", `${visible ? "categoryCreated" : "categoryHidden"}:${name}`);
    return { channel, outcome: visible ? "created" : "createdHidden", label: c.title, collectionId: c.id, menu };
  } catch (e) {
    console.error("shopify category", channel, name, e);
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    await logEvent(channel, "warn", "products", `categoryFailed:${name} – ${detail}`).catch(() => {});
    return { channel, outcome: "failed", detail };
  }
}

const COLLECTION_Q = `query($id: ID!) { collection(id: $id) { id productsCount { count } } }`;
const COLLECTION_DELETE_M = `mutation($input: CollectionDeleteInput!) { collectionDelete(input: $input) { deletedCollectionId userErrors { field message } } }`;

/** Eine Kollektion, die WIR angelegt haben, wieder löschen – nur wenn sie im Shop leer ist (vorher aus dem Menü nehmen). */
export async function deleteStoreCollection(channel: ShopChannel, collectionId: string): Promise<"deleted" | "gone" | "notEmpty" | "menu" | "notConfigured"> {
  const shop = await getShop(channel);
  if (!configured(shop)) return "notConfigured";
  const d = await gql<{ collection: { id: string; productsCount: { count: number } | null } | null }>(shop, COLLECTION_Q, { id: collectionId });
  if (!d.collection) return "gone";
  if ((d.collection.productsCount?.count ?? 0) > 0) return "notEmpty";
  const nav = await navigation(shop);
  if (nav.access && nav.menu && menuHas(nav.menu.items, collectionId)) {
    const m = menuWithout(nav.menu.items, collectionId);
    if (m.blocked) return "menu";
    await updateMenu(shop, nav.menu, m.items);
  }
  const r = await withFreshToken(shop, () => gql<{ collectionDelete: { deletedCollectionId: string | null; userErrors: { message: string }[] } }>(
    shop, COLLECTION_DELETE_M, { input: { id: collectionId } }));
  if (r.collectionDelete.userErrors.length) throw new ShopifyError("userErrors", errs(r.collectionDelete.userErrors));
  await getStoreTypes(shop, 0).catch(() => []);
  return "deleted";
}

// ───────────────────────── Produkttyp verbundener Artikel ─────────────────────────

const VARIANT_PRODUCTS_Q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id product { id productType } } } }`;
const PRODUCT_TYPE_M = `mutation($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id productType } userErrors { field message } } }`;

export type TypeSync = { channel: ShopChannel; updated: number; unchanged: number; missing: number; failed: number };

/**
 * Kategorie geändert → im Shop den Produkttyp der verbundenen Produkte anpassen (= richtige Kollektion).
 * Gibt es die Kategorie im Shop nicht (und keine Zuordnung), bleibt das Produkt dort, wo es ist (missing).
 * Leere Kategorie → im Shop nichts ändern.
 */
export async function syncProductTypes(productIds: string[], only?: ShopChannel): Promise<TypeSync[]> {
  const out: TypeSync[] = [];
  if (!productIds.length) return out;
  for (const channel of only ? [only] : CHANNELS) {
    const shop = await getShop(channel);
    if (!configured(shop)) continue;
    const rows = (await db.execute<{ id: string; name_de: string; sku: string; category: string; svs: string[] }>(sql`
      select p.id, p.name_de, p.sku, p.category, array_agg(sv.shop_variant_id order by v.created_at) as svs
      from products p join variants v on v.product_id = p.id join shop_variants sv on sv.variant_id = v.id and sv.channel = ${channel}
      where p.id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)}) group by p.id`)).rows;
    if (!rows.length) continue;
    const r: TypeSync = { channel, updated: 0, unchanged: 0, missing: 0, failed: 0 };
    out.push(r);
    try {
      const types = await getStoreTypes(shop, 10 * 60_000);
      // Shop-Produkte zu unseren verbundenen Varianten (in Paketen)
      const all = [...new Set(rows.flatMap((x) => x.svs))];
      const productOf = new Map<string, { id: string; productType: string }>();
      for (let i = 0; i < all.length; i += 100) {
        const d = await gql<{ nodes: ({ id: string; product: { id: string; productType: string } } | null)[] }>(shop, VARIANT_PRODUCTS_Q, { ids: all.slice(i, i + 100) });
        for (const n of d.nodes) if (n?.product) productOf.set(n.id, n.product);
      }
      for (const x of rows) {
        if (!x.category.trim()) continue;
        const type = resolveStoreType(x.category, types, shop.categoryMap ?? {});
        if (!type) { r.missing++; await logEvent(channel, "warn", "products", `typeMissing:${x.name_de} → ${x.category}`, x.sku); continue; }
        const label = storeTypeLabel(types.find((t) => t.type === type) ?? { type, collection: null });
        const prods = new Map<string, string>();
        for (const s of x.svs) { const pr = productOf.get(s); if (pr) prods.set(pr.id, pr.productType); }
        for (const [pid, current] of prods) {
          if (current === type) { r.unchanged++; continue; }
          try {
            const u = await withFreshToken(shop, () => gql<{ productUpdate: { userErrors: { message: string }[] } }>(shop, PRODUCT_TYPE_M, { product: { id: pid, productType: type } }));
            if (u.productUpdate.userErrors.length) throw new ShopifyError("userErrors", errs(u.productUpdate.userErrors));
            r.updated++;
            await logEvent(channel, "info", "products", `typeUpdated:${x.name_de} → ${label}`, x.sku);
          } catch (e) {
            r.failed++;
            await logEvent(channel, "warn", "products", `typeFailed:${x.name_de} – ${(e as Error).message}`.slice(0, 1000), x.sku);
          }
        }
      }
    } catch (e) {
      console.error("shopify product types", channel, e);
      r.failed += rows.length;
      await logEvent(channel, "warn", "products", `typeFailed:${rows.length} – ${(e as Error).message}`.slice(0, 1000)).catch(() => {});
    }
  }
  return out;
}

/** Im Hintergrund (z. B. nach dem Speichern im Artikel-Formular) */
export function syncProductTypesLater(productIds: string[], only?: ShopChannel) {
  if (!productIds.length) return;
  void syncProductTypes(productIds, only).catch((e) => console.error("shopify product types later", e));
}
