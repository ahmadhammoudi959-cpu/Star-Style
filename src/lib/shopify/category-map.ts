/**
 * Kategorien ↔ Shop (Wunsch Inhaber 04.11.2026): eine Kategorie im Shop = automatische Kollektion „Produkttyp ist gleich <Name>“,
 * optional als Punkt im Hauptmenü unter einer Gruppe (z. B. „Salonmöbel“). Rein und getestet.
 */
import { resolveStoreType, storeTypeLabel, type StoreType } from "./product-push-map";

const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** Name einer Kategorie: ohne Leerzeichen am Rand und doppelte Leerzeichen, höchstens 100 Zeichen */
export const cleanCategoryName = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 100);

export type CategoryStoreState =
  | { state: "same"; type: string; label: string }    // gibt es im Shop unter gleichem Namen (Produkttyp oder Kollektion)
  | { state: "mapped"; type: string; label: string }  // von Hand einer anderen Shop-Kategorie zugeordnet
  | { state: "missing" };                             // gibt es im Shop nicht

export function categoryStoreState(name: string, types: StoreType[], map: Record<string, string>): CategoryStoreState {
  if (!types.length) return { state: "missing" };
  const type = resolveStoreType(name, types, map);
  if (!type) return { state: "missing" };
  const t = types.find((x) => x.type === type) ?? { type, collection: null };
  const same = norm(t.type) === norm(name) || (t.collection != null && norm(t.collection) === norm(name));
  return { state: same ? "same" : "mapped", type, label: storeTypeLabel(t) };
}

/** Regeln einer neuen automatischen Kollektion: Produkttyp ist gleich <Name> (API 2026-07: ruleSet) */
export function collectionInput(name: string) {
  return { title: name, ruleSet: { appliedDisjunctively: false, rules: [{ column: "TYPE", relation: "EQUALS", condition: name }] } };
}

// ───────────────────────── Menü des Shops ─────────────────────────

export type MenuItem = { id: string; title: string; type: string; resourceId: string | null; url: string | null; tags: string[]; items: MenuItem[] };
export type MenuItemInput = { id?: string; title: string; type: string; resourceId?: string; url?: string; tags?: string[]; items: MenuItemInput[] };

/** Gruppen, unter die eine Kategorie kommen kann: Punkte der obersten Ebene, die schon Unterpunkte haben (z. B. „Salonmöbel“) */
export function menuGroups(items: MenuItem[]): { id: string; title: string }[] {
  return items.filter((i) => i.items.length > 0).map((i) => ({ id: i.id, title: i.title }));
}

const itemInput = (i: MenuItem, items: MenuItemInput[]): MenuItemInput => ({
  id: i.id, title: i.title, type: i.type,
  ...(i.resourceId ? { resourceId: i.resourceId } : {}),
  ...(i.url ? { url: i.url } : {}),
  tags: [...(i.tags ?? [])],
  items,
});

/** Menü → Eingabe für menuUpdate: alles unverändert (IDs bleiben, sonst legt Shopify Punkte neu an). */
export function menuToInput(items: MenuItem[]): MenuItemInput[] {
  return items.map((i) => itemInput(i, menuToInput(i.items ?? [])));
}

/** Gibt es schon einen Menüpunkt zu dieser Kollektion (irgendwo im Menü)? */
export function menuHas(items: MenuItem[], resourceId: string): boolean {
  return items.some((i) => i.resourceId === resourceId || menuHas(i.items ?? [], resourceId));
}

/** Menü mit einem neuen Punkt für die Kollektion – hinten unter der Gruppe (groupId) bzw. oben, wenn groupId leer. null = Gruppe nicht gefunden. */
export function menuWithCollection(items: MenuItem[], groupId: string, c: { title: string; id: string; handle: string }): MenuItemInput[] | null {
  const input = menuToInput(items);
  const entry: MenuItemInput = { title: c.title, type: "COLLECTION", resourceId: c.id, url: `/collections/${c.handle}`, tags: [], items: [] };
  if (!groupId) return [...input, entry];
  const g = input.find((i) => i.id === groupId);
  if (!g) return null;
  g.items = [...g.items, entry];
  return input;
}

/** Menü ohne die Punkte zu dieser Kollektion (vor dem Löschen der Kollektion). blocked = ein solcher Punkt hat Unterpunkte → nicht anfassen. */
export function menuWithout(items: MenuItem[], resourceId: string): { items: MenuItemInput[]; removed: number; blocked: boolean } {
  let removed = 0, blocked = false;
  const strip = (list: MenuItem[]): MenuItemInput[] => list.flatMap((i) => {
    if (i.resourceId === resourceId) {
      if ((i.items ?? []).length) blocked = true;
      else { removed++; return []; }
    }
    return [itemInput(i, strip(i.items ?? []))];
  });
  const out = strip(items);
  return { items: out, removed: blocked ? 0 : removed, blocked };
}

/** Tiefe des Menüs (Shopify erlaubt 3 Ebenen). Mehr → nicht anfassen, wir könnten Punkte verlieren. */
export function menuDepth(items: MenuItem[]): number {
  return items.length ? 1 + Math.max(...items.map((i) => menuDepth(i.items ?? []))) : 0;
}

// ───────────────────────── Ergebnis für die Oberfläche ─────────────────────────

export const STORE_OUTCOMES = ["created", "createdHidden", "exists", "failed", "notConfigured"] as const;
export const MENU_OUTCOMES = ["added", "exists", "noAccess", "skipped", "failed"] as const;
export type StoreResultCode = { channel: "BRAND_SHOP" | "GENERAL_SHOP"; outcome: (typeof STORE_OUTCOMES)[number]; menu?: (typeof MENU_OUTCOMES)[number] };

/** Kurzform für die Adresszeile nach dem Anlegen: „Kanal.Ergebnis.Menü“, mehrere mit „~“ */
export function encodeStoreResults(r: StoreResultCode[]): string {
  return r.map((x) => [x.channel, x.outcome, x.menu ?? ""].join(".")).join("~");
}

/** Gegenstück – nur bekannte Werte */
export function decodeStoreResults(s: string | undefined): StoreResultCode[] {
  if (!s) return [];
  return s.split("~").slice(0, 2).flatMap((part) => {
    const [channel, outcome, menu = ""] = part.split(".");
    if ((channel !== "BRAND_SHOP" && channel !== "GENERAL_SHOP") || !(STORE_OUTCOMES as readonly string[]).includes(outcome)) return [];
    const r: StoreResultCode = { channel, outcome: outcome as StoreResultCode["outcome"] };
    if ((MENU_OUTCOMES as readonly string[]).includes(menu)) r.menu = menu as StoreResultCode["menu"];
    return [r];
  });
}
