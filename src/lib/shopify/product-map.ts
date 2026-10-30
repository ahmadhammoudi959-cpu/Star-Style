/**
 * Shopify-Produkte → Artikel in unserem System. Rein und getestet.
 * Grundsätze: Preise bei uns netto (Shop-Preise sind meist brutto), Bestand 0 (Ware kommt nur über den Wareneingang),
 * Größe/Farbe aus den Produkt-Optionen, der Barcode verbindet Artikel und Shop.
 */

export type ShopImportVariant = {
  id: string; sku: string | null; barcode: string | null; price: string; position: number;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { unitCost: { amount: string } | null } | null;
  product: {
    id: string; title: string; handle: string; productType: string; vendor: string; status: string; isGiftCard: boolean;
    options: { name: string; position: number }[];
    featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  };
};

/** priceCents = eigener Preis der Variante (nur wenn er vom Artikelpreis abweicht), gilt für Groß- und Einzelhandel */
export type DraftVariant = { shopVariantId: string; size: string; color: string; barcode: string | null; priceCents: number | null };

export type ProductDraft = {
  shopProductId: string; handle: string; sku: string; nameDe: string; category: string; vendor: string;
  vatRateBp: number; purchasePriceCents: number; retailPriceCents: number;
  imageUrl: string | null; variants: DraftVariant[];
};

const COLOR = /^(farbe|farben|colou?rs?|kleur|couleur|لون|اللون)$/i;
const clip = (s: string | null | undefined, n: number) => (s ?? "").trim().slice(0, n).trim();
const isDefault = (o: { name: string; value: string }) => o.name === "Title" && o.value === "Default Title";

/** Shop-Preis → Netto-Cent (bei Bruttopreisen USt herausrechnen). Ungültig oder ≤ 0 → 0. */
export function netCents(price: string | null | undefined, vatRateBp: number, taxesIncluded: boolean): number {
  const cents = Math.round(Number(price ?? 0) * 100);
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  return taxesIncluded ? Math.round((cents * 10000) / (10000 + vatRateBp)) : cents;
}

/** Varianten je Produkt bündeln (Reihenfolge wie im Shop); archivierte Produkte und Geschenkkarten fallen weg. */
export function groupByProduct(nodes: ShopImportVariant[]): ShopImportVariant[][] {
  const m = new Map<string, ShopImportVariant[]>();
  for (const n of nodes) {
    if (n.product.status === "ARCHIVED" || n.product.isGiftCard) continue;
    const list = m.get(n.product.id) ?? [];
    list.push(n);
    m.set(n.product.id, list);
  }
  return [...m.values()].map((l) => [...l].sort((a, b) => a.position - b.position));
}

export function mapShopProduct(variants: ShopImportVariant[], o: { taxesIncluded: boolean; vatRateBp?: number }): ProductDraft {
  const vat = o.vatRateBp ?? 1900;
  const first = variants[0];
  const p = first.product;
  const optionNames = [...p.options].sort((a, b) => a.position - b.position).map((x) => x.name);
  const colorName = optionNames.find((n) => COLOR.test(n.trim()));
  const prices = variants.map((v) => netCents(v.price, vat, o.taxesIncluded));
  const base = prices[0] ?? 0;

  const seen = new Set<string>();
  const out: DraftVariant[] = variants.map((v, i) => {
    const opts = v.selectedOptions.filter((x) => !isDefault(x));
    const color = colorName ? clip(opts.find((x) => x.name === colorName)?.value, 60) : "";
    const rest = optionNames.filter((n) => n !== colorName).map((n) => clip(opts.find((x) => x.name === n)?.value, 60)).filter(Boolean);
    let size = clip(rest.join(" / "), 60);
    // Größe/Farbe muss je Artikel eindeutig sein (auch ohne Beachtung der Groß-/Kleinschreibung)
    for (let k = 2; seen.has(`${size.toLowerCase()}|${color.toLowerCase()}`); k++) size = clip(`${rest.join(" / ").slice(0, 52)} (${k})`, 60);
    seen.add(`${size.toLowerCase()}|${color.toLowerCase()}`);
    const bc = clip(v.barcode, 64);
    return { shopVariantId: v.id, size, color, barcode: bc && bc.length <= 32 ? bc : null, priceCents: prices[i] === base ? null : prices[i] };
  });

  // Art.-Nr.: bei einer Variante die SKU des Shops (dann klappt auch die Zuordnung per Art.-Nr.), sonst der Shop-Handle
  const single = variants.length === 1;
  const sku = clip(single ? (clip(first.sku, 64) || clip(first.barcode, 64) || p.handle) : p.handle, 64) || p.id.split("/").pop()!;
  const cost = Math.round(Number(first.inventoryItem?.unitCost?.amount ?? 0) * 100);

  return {
    shopProductId: p.id, handle: p.handle, sku, nameDe: clip(p.title, 200) || p.handle, category: clip(p.productType, 100), vendor: clip(p.vendor, 120),
    vatRateBp: vat, purchasePriceCents: Number.isFinite(cost) && cost > 0 ? cost : 0, retailPriceCents: base,
    imageUrl: p.featuredMedia?.preview?.image?.url ?? null, variants: out,
  };
}
