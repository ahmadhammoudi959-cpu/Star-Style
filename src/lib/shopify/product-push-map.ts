/**
 * Artikel aus unserem System → Shopify (neues Produkt per productSet oder fehlende Größen/Farben an ein vorhandenes Produkt).
 * Rein und getestet – auch im Browser benutzt (Rückfrage im Artikel-Formular).
 * Grundsätze: Shop-Preis = Einzelhandelspreis (bei Shops mit Bruttopreisen inkl. MwSt.), Größe/Farbe werden Produkt-Optionen,
 * jede Variante bekommt Barcode, Art.-Nr. und den verfügbaren Bestand am Lagerort des Shops. Verbunden wird über den Barcode.
 */
import { COLOR } from "./product-map";

export type PushVariant = {
  id: string; size: string; color: string; barcode: string | null;
  retailPriceCents: number | null; // eigener Preis der Variante, sonst Artikelpreis
  imageFileId: string | null; available: number;
};

export type PushProduct = {
  id: string; sku: string; nameDe: string; descriptionDe: string; category: string; vendor: string;
  vatRateBp: number; retailPriceCents: number; purchasePriceCents: number; imageFileId: string | null;
  variants: PushVariant[];
};

export type PushImage = { resourceUrl: string; filename: string };

export const SIZE_OPTION = "Größe";
export const COLOR_OPTION = "Farbe";
const PLACEHOLDER = "Standard";

/** Netto-Cent → Shop-Preis-Cent (Shops mit Bruttopreisen: inkl. MwSt.) */
export function shopPriceCents(netCents: number, vatRateBp: number, taxesIncluded: boolean): number {
  return taxesIncluded ? Math.round((netCents * (10000 + vatRateBp)) / 10000) : netCents;
}

const money = (cents: number) => (cents / 100).toFixed(2);

/** Beschreibung als einfaches HTML: Absätze bei Leerzeilen, sonst Zeilenumbrüche */
export function descriptionHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\r?\n/g, "<br>")}</p>`).join("");
}

/** Optionswerte je Variante. Leere Werte bei mehreren Varianten → „Standard“ (Shopify verlangt einen Wert je Option). */
export function variantOptions(variants: Pick<PushVariant, "size" | "color">[]): { names: string[]; values: string[][] } {
  const hasSize = variants.some((v) => v.size.trim());
  const hasColor = variants.some((v) => v.color.trim());
  if (!hasSize && !hasColor) return { names: ["Title"], values: variants.map(() => ["Default Title"]) };
  const names = [...(hasSize ? [SIZE_OPTION] : []), ...(hasColor ? [COLOR_OPTION] : [])];
  const seen = new Set<string>();
  const values = variants.map((v) => {
    const base = [...(hasSize ? [v.size.trim() || PLACEHOLDER] : []), ...(hasColor ? [v.color.trim() || PLACEHOLDER] : [])];
    let vals = base;
    // Kombination muss eindeutig sein (z. B. „“ und „Standard“ ergäben dasselbe) → letzten Wert nummerieren
    for (let k = 2; seen.has(vals.join("|").toLowerCase()); k++) vals = [...base.slice(0, -1), `${base[base.length - 1]} (${k})`];
    seen.add(vals.join("|").toLowerCase());
    return vals;
  });
  return { names, values };
}

/** Art.-Nr. im Shop: bei einer Variante die Artikelnummer, sonst Artikelnummer-Größe-Farbe */
/** SKU im Shop: Art.-Nr. = Barcode (Wunsch Inhaber) → der Barcode der Variante; ohne Barcode Art.-Nr. bzw. Art.-Nr.-Größe-Farbe */
export function variantSku(sku: string, v: Pick<PushVariant, "size" | "color"> & { barcode?: string | null }, single: boolean): string {
  if (v.barcode?.trim()) return v.barcode.trim();
  if (single) return sku;
  const part = (s: string) => s.trim().replace(/\s+/g, "-");
  return [sku, part(v.size), part(v.color)].filter(Boolean).join("-").slice(0, 255);
}

export function buildProductSet(p: PushProduct, o: { taxesIncluded: boolean; locationId: string; images: Map<string, PushImage>; productType?: string }) {
  const opts = variantOptions(p.variants);
  const single = p.variants.length === 1;
  // Fotos: Artikelfoto zuerst (Titelbild), dann eigene Fotos der Varianten – jedes nur einmal
  const fileIds = [p.imageFileId, ...p.variants.map((v) => v.imageFileId)].filter((f): f is string => Boolean(f && o.images.has(f)));
  const unique = [...new Set(fileIds)];
  const file = (id: string) => ({ originalSource: o.images.get(id)!.resourceUrl, contentType: "IMAGE", alt: p.nameDe, filename: o.images.get(id)!.filename });
  const optionValues = (k: number) => opts.names.map((n, i) => ({ optionName: n, name: opts.values[k][i] }));

  return {
    title: p.nameDe,
    ...(p.descriptionDe.trim() ? { descriptionHtml: descriptionHtml(p.descriptionDe) } : {}),
    ...(p.vendor.trim() ? { vendor: p.vendor.trim() } : {}),
    // Produkttyp = Kategorie des Shops → das Produkt landet in der passenden automatischen Kollektion
    ...((o.productType ?? p.category).trim() ? { productType: (o.productType ?? p.category).trim() } : {}),
    status: "ACTIVE",
    productOptions: opts.names.map((n, i) => ({
      name: n, position: i + 1,
      values: [...new Set(opts.values.map((v) => v[i]))].map((name) => ({ name })),
    })),
    ...(unique.length ? { files: unique.map(file) } : {}),
    variants: p.variants.map((v, k) => ({
      optionValues: optionValues(k),
      price: money(shopPriceCents(v.retailPriceCents ?? p.retailPriceCents, p.vatRateBp, o.taxesIncluded)),
      ...(v.barcode ? { barcode: v.barcode } : {}),
      inventoryItem: {
        sku: variantSku(p.sku, v, single), tracked: true,
        ...(p.purchasePriceCents > 0 ? { cost: money(p.purchasePriceCents) } : {}),
      },
      inventoryQuantities: [{ locationId: o.locationId, name: "available", quantity: Math.max(0, v.available) }],
      ...(v.imageFileId && o.images.has(v.imageFileId) && v.imageFileId !== p.imageFileId ? { file: file(v.imageFileId) } : {}),
    })),
  };
}

/** Welche Shop-Variante gehört zu welcher unserer Varianten? (über die Optionswerte, Reihenfolge als Rückfall) */
export function matchCreatedVariants(
  ours: Pick<PushVariant, "id" | "size" | "color">[],
  created: { id: string; selectedOptions: { name: string; value: string }[] }[],
): Map<string, string> {
  const opts = variantOptions(ours);
  const key = (vals: string[]) => vals.join("|").toLowerCase();
  const byKey = new Map<string, string>(created.map((c) => [key(opts.names.map((n) => c.selectedOptions.find((s) => s.name === n)?.value ?? "")), c.id]));
  const out = new Map<string, string>();
  ours.forEach((v, k) => {
    const id = byKey.get(key(opts.values[k])) ?? (ours.length === created.length ? created[k]?.id : undefined);
    if (id) out.set(v.id, id);
  });
  return out;
}

// ───────────────────────── Kategorien des Shops ─────────────────────────

/** Eine Kategorie im Shop: der Produkttyp und – falls es sie gibt – der Titel der automatischen Kollektion „Produkttyp ist gleich …“
 *  (so heißt die Kategorie für die Kunden, z. B. Typ „Barberstuhl“ → Kollektion „Barberstühle“). */
export type StoreType = { type: string; collection: string | null };
export type CollectionRules = { title: string; disjunctive: boolean; rules: { column: string; relation: string; condition: string }[] };

const norm = (s: string) => s.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/** Produkttypen und Kollektionsregeln → Kategorien des Shops (ohne Doppelte, nach Anzeigename sortiert) */
export function storeTypesFrom(productTypes: string[], collections: CollectionRules[]): StoreType[] {
  const m = new Map<string, StoreType>();
  for (const c of collections) {
    // „alle Bedingungen“ mit mehreren Regeln: der Produkttyp allein reicht nicht → nicht als Kategorie anbieten
    if (!c.disjunctive && c.rules.length > 1) continue;
    for (const r of c.rules) {
      const type = r.condition.trim();
      if (r.column !== "TYPE" || r.relation !== "EQUALS" || !type || m.has(norm(type))) continue;
      m.set(norm(type), { type, collection: c.title.trim() || null });
    }
  }
  for (const t of productTypes) if (t.trim() && !m.has(norm(t))) m.set(norm(t), { type: t.trim(), collection: null });
  return [...m.values()].sort((a, b) => storeTypeLabel(a).localeCompare(storeTypeLabel(b), "de"));
}

export const storeTypeLabel = (t: StoreType) => t.collection ?? t.type;

/** Unsere Kategorie → Produkttyp im Shop: gleicher Name wie ein Produkttyp oder eine Kollektion, sonst die gespeicherte Zuordnung.
 *  null = unbekannt (der Nutzer muss die Kategorie des Shops wählen). Shop ohne Kategorien → unsere Kategorie unverändert. */
export function resolveStoreType(category: string, types: StoreType[], map: Record<string, string>): string | null {
  const c = norm(category);
  if (!c) return null;
  if (!types.length) return category.trim();
  const hit = types.find((t) => norm(t.type) === c) ?? types.find((t) => t.collection != null && norm(t.collection) === c);
  if (hit) return hit.type;
  const mapped = Object.entries(map).find(([k]) => norm(k) === c)?.[1];
  return mapped ? types.find((t) => norm(t.type) === norm(mapped))?.type ?? null : null;
}

// ───────────────────────── Was fehlt noch? ─────────────────────────

export const PUSH_BLOCKERS = ["noBarcode", "noCategory", "unknownCategory", "noPrice"] as const;
export type PushBlocker = (typeof PUSH_BLOCKERS)[number];

/** Voraussetzungen (Wunsch Inhaber): jede Variante hat einen Barcode; ein NEUES Shop-Produkt braucht zusätzlich eine Kategorie,
 *  die es im Shop gibt, und einen Einzelhandelspreis. Beim Ergänzen von Größen/Farben zählt nur Barcode und Preis. */
export function pushBlockers(
  p: { category: string; retailPriceCents: number; variants: { barcode: string | null; retailPriceCents?: number | null }[] },
  o: { creating: boolean; storeType: string | null },
): PushBlocker[] {
  const out: PushBlocker[] = [];
  if (p.variants.some((v) => !v.barcode?.trim())) out.push("noBarcode");
  if (o.creating) {
    if (!p.category.trim()) out.push("noCategory");
    else if (!o.storeType) out.push("unknownCategory");
  }
  if (p.retailPriceCents <= 0 && p.variants.some((v) => !v.retailPriceCents)) out.push("noPrice");
  return out;
}

// ───────────────────────── Größen/Farben an ein vorhandenes Shop-Produkt anfügen ─────────────────────────

export type ShopProductShape = {
  hasOnlyDefaultVariant: boolean;
  options: { name: string; values: string[] }[]; // in Shop-Reihenfolge
  variants: { id: string; selectedOptions: { name: string; value: string }[] }[];
};
export type AddPlan =
  | { ok: true; createOptions: { name: string; values: { name: string }[] }[]; variants: { id: string; optionValues: { optionName: string; name: string }[] }[] }
  | { ok: false; reason: "options" | "conflict" };

/**
 * Optionswerte für unsere fehlenden Varianten im vorhandenen Shop-Produkt.
 * - Produkt hat nur die Standard-Variante: erst unsere Optionen (Größe/Farbe) anlegen – die vorhandene Variante bekommt dabei die
 *   Werte der mit ihr verbundenen Variante –, dann die fehlenden Varianten.
 * - Sonst wie beim Import: Option „Farbe/Farbton/Nuance…“ ↔ Farbe, übrige Optionen ↔ Größe (mehrere als „A / B“).
 *   Nutzt der Artikel Größe oder Farbe gar nicht, kommt der Wert der schon verbundenen Shop-Variante.
 * Geht das nicht eindeutig → { ok: false } (dann bitte im Shop von Hand), nie raten.
 */
export function planVariantAdds(
  shop: ShopProductShape, linked: Map<string, string>,
  ours: Pick<PushVariant, "id" | "size" | "color">[], missingIds: string[],
): AddPlan {
  const isDefault = shop.hasOnlyDefaultVariant || (shop.options.length === 1 && shop.options[0].name === "Title" && shop.options[0].values.every((v) => v === "Default Title"));
  const key = (vals: string[]) => vals.map((x) => norm(x)).join("|");
  const missing = missingIds.map((id) => ours.find((v) => v.id === id)).filter((v): v is (typeof ours)[number] => Boolean(v));
  if (!missing.length) return { ok: true, createOptions: [], variants: [] };

  if (isDefault) {
    const opts = variantOptions(ours);
    const k = ours.findIndex((v) => linked.has(v.id));
    if (k < 0 || opts.names[0] === "Title") return { ok: false, reason: "options" };
    return {
      ok: true,
      createOptions: opts.names.map((name, i) => ({ name, values: [{ name: opts.values[k][i] }] })),
      variants: missing.map((m) => {
        const vals = opts.values[ours.indexOf(m)];
        return { id: m.id, optionValues: opts.names.map((optionName, i) => ({ optionName, name: vals[i] })) };
      }),
    };
  }

  const names = shop.options.map((o) => o.name);
  const colorName = names.find((n) => COLOR.test(n.trim()));
  const rest = names.filter((n) => n !== colorName);
  const distinct = (f: (v: (typeof ours)[number]) => string) => new Set(ours.map((v) => norm(f(v)))).size;
  const usesColor = ours.some((v) => v.color.trim()), usesSize = ours.some((v) => v.size.trim());
  // Artikel unterscheidet Farben/Größen, das Shop-Produkt hat dafür keine Option → nicht darstellbar
  if (!colorName && distinct((v) => v.color) > 1) return { ok: false, reason: "options" };
  if (!rest.length && distinct((v) => v.size) > 1) return { ok: false, reason: "options" };

  const linkedShopIds = new Set(linked.values());
  const sample = shop.variants.find((v) => linkedShopIds.has(v.id)) ?? shop.variants[0];
  const fallback = (name: string) => sample?.selectedOptions.find((o) => o.name === name)?.value || "Standard";
  const taken = new Set(shop.variants.map((v) => key(names.map((n) => v.selectedOptions.find((o) => o.name === n)?.value ?? ""))));

  const variants: { id: string; optionValues: { optionName: string; name: string }[] }[] = [];
  for (const m of missing) {
    const vals = new Map<string, string>();
    if (colorName) vals.set(colorName, m.color.trim() || (usesColor ? "Standard" : fallback(colorName)));
    if (rest.length) {
      const size = m.size.trim();
      const parts = !size ? [] : rest.length === 1 ? [size] : size.split(" / ").map((x) => x.trim());
      if (size && parts.length !== rest.length) return { ok: false, reason: "options" };
      rest.forEach((n, j) => vals.set(n, parts[j] || (usesSize ? "Standard" : fallback(n))));
    }
    const k = key(names.map((n) => vals.get(n)!));
    if (taken.has(k)) return { ok: false, reason: "conflict" }; // gibt es im Shop schon (ohne unseren Barcode) → von Hand klären
    taken.add(k);
    variants.push({ id: m.id, optionValues: names.map((optionName) => ({ optionName, name: vals.get(optionName)! })) });
  }
  return { ok: true, createOptions: [], variants };
}

// ───────────────────────── Ergebnis für die Oberfläche ─────────────────────────

export type PushChannel = "BRAND_SHOP" | "GENERAL_SHOP";
/** created/createdHidden = neu angelegt · linked = gab es schon, nur verbunden · updated = n Größen/Farben ergänzt ·
 *  partial = n Varianten konnten nicht ergänzt werden · failed = nichts passiert · notNow = Nutzer wollte (noch) nicht hochladen */
export type PushOutcome = "created" | "createdHidden" | "linked" | "updated" | "partial" | "failed" | "notNow";
const OUTCOMES: PushOutcome[] = ["created", "createdHidden", "linked", "updated", "partial", "failed", "notNow"];
export const PUSH_REASONS = ["noLocation", "noPrice", "currency", "noWriteAccess", "duplicate", "noBarcode", "noCategory", "unknownCategory",
  "options", "conflict", "multipleProducts", "other"] as const;
export type PushReason = (typeof PUSH_REASONS)[number];
export type PushResult = { channel: PushChannel; outcome: PushOutcome; reason?: PushReason; n?: number; imagesFailed?: boolean };

/** Kurzform für die Adresszeile nach dem Speichern: „Kanal.Ergebnis.Grund.Anzahl.Fotos“, mehrere mit „~“ */
export function encodePush(results: PushResult[]): string {
  return results.map((r) => [r.channel, r.outcome, r.reason ?? "", r.n != null ? String(r.n) : "", r.imagesFailed ? "1" : "0"].join(".")).join("~");
}

/** Gegenstück zu encodePush – nur bekannte Werte werden übernommen */
export function decodePush(s: string | undefined): PushResult[] {
  if (!s) return [];
  return s.split("~").slice(0, 2).flatMap((part) => {
    const [channel, outcome, reason = "", n = "", img = "0"] = part.split(".");
    if ((channel !== "BRAND_SHOP" && channel !== "GENERAL_SHOP") || !OUTCOMES.includes(outcome as PushOutcome)) return [];
    const r: PushResult = { channel, outcome: outcome as PushOutcome, imagesFailed: img === "1" };
    if ((PUSH_REASONS as readonly string[]).includes(reason)) r.reason = reason as PushReason;
    if (/^\d{1,4}$/.test(n)) r.n = Number(n);
    return [r];
  });
}
