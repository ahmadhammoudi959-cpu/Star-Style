/**
 * Direktverkauf über den Bestell-Link (Wunsch Inhaber 19.11.2026: „لينك هتديه للزباين تشتري بيع مباشر“): reine Regeln,
 * auch im Browser benutzt (Katalog, Warenkorb, Summen) und auf dem Server (Prüfung beim Absenden, Begrenzung). Getestet.
 * Der Kunde sieht nur „verfügbar“/„nicht verfügbar“ – nie die Bestandszahl; was nicht verfügbar ist, kann er nicht bestellen.
 */
import { computeTotals } from "./tax";

export const DIRECT_MAX_LINES = 100;
export const DIRECT_MAX_QTY = 999;
/** Schneller ausgefüllt und abgeschickt = Programm, kein Mensch */
export const DIRECT_MIN_FILL_MS = 2500;
/** Begrenzung (Spam, Fehlbedienung): je Netz/Gerät, je E-Mail und insgesamt */
export const DIRECT_LIMITS = { perIpHour: 6, perIpDay: 20, perEmailDay: 10, allHour: 60 } as const;
/** Anfragen ohne Rechnung werden gelöscht (Datenschutz, steht so im Hinweis auf der Seite) */
export const DIRECT_KEEP_DAYS = { rejected: 90, open: 180 } as const;

export type CatalogVariant = {
  id: string; size: string; color: string; barcode: string;
  /** netto, Preis der Preisgruppe des Links (جملة bzw. جملة الجملة) */
  priceCents: number; grossCents: number; vatRateBp: number; imageId: string | null; inStock: boolean;
};
export type CatalogProduct = {
  id: string; name: string; category: string; sku: string; description: string; imageId: string | null; variants: CatalogVariant[];
};

export const variantLabel = (v: { size: string; color: string }) => [v.size, v.color].filter((x) => x.trim()).join(" · ");
/** Text der Position – genau wie im Rechnungs-Editor (optionLabel): „Name (Größe · Farbe)“ */
export function lineDescription(name: string, v: { size: string; color: string }) {
  const extra = variantLabel(v);
  return extra ? `${name} (${extra})` : name;
}

/** E-Mail als Schlüssel zum Kunden: klein, ohne Leerzeichen am Rand */
export const normalizeEmail = (s: string) => s.trim().toLowerCase();
/** USt-IdNr. wie im Kundenformular: Großbuchstaben, ohne Leerzeichen/Punkte/Striche */
export const cleanVatId = (s: string) => s.toUpperCase().replace(/[\s.\-/]/g, "");

/** günstigster und teuerster Preis eines Artikels (für „ab …“ auf der Karte) */
export function priceRange(p: Pick<CatalogProduct, "variants">): { min: number; max: number; minGross: number } {
  const vs = p.variants.length ? p.variants : [{ priceCents: 0, grossCents: 0 }];
  let min = vs[0], max = vs[0];
  for (const v of vs) { if (v.priceCents < min.priceCents) min = v; if (v.priceCents > max.priceCents) max = v; }
  return { min: min.priceCents, max: max.priceCents, minGross: min.grossCents };
}
export const productInStock = (p: Pick<CatalogProduct, "variants">) => p.variants.some((v) => v.inStock);

/** Suche im Katalog: Name, Kategorie, Art.-Nr., Barcode, Größe/Farbe (Groß-/Kleinschreibung egal); exakter Barcode zuerst */
export function searchCatalog(products: CatalogProduct[], q: string, category = ""): CatalogProduct[] {
  const s = q.trim().toLowerCase();
  const inCat = category ? products.filter((p) => p.category === category) : products;
  if (!s) return inCat;
  const exact = inCat.filter((p) => p.sku.toLowerCase() === s || p.variants.some((v) => v.barcode === s));
  const rest = inCat.filter((p) => !exact.includes(p) && [p.name, p.category, p.sku, ...p.variants.flatMap((v) => [v.barcode, v.size, v.color])]
    .some((f) => f.toLowerCase().includes(s)));
  return [...exact, ...rest];
}

/** Kategorien mit Anzahl Artikel, alphabetisch (deutsche Sortierung) */
export function catalogCategories(products: CatalogProduct[]): { name: string; n: number }[] {
  const m = new Map<string, number>();
  for (const p of products) if (p.category) m.set(p.category, (m.get(p.category) ?? 0) + 1);
  return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name, "de"));
}

export type CartLine = { variantId: string; qty: number };

/** Gleiche Variante zusammenfassen, Unsinn weg (Menge 1–999), höchstens 100 Positionen, Reihenfolge bleibt */
export function mergeCart(lines: CartLine[]): CartLine[] {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (!l.variantId || !Number.isInteger(l.qty) || l.qty <= 0) continue;
    m.set(l.variantId, Math.min(DIRECT_MAX_QTY, (m.get(l.variantId) ?? 0) + l.qty));
  }
  return [...m.entries()].slice(0, DIRECT_MAX_LINES).map(([variantId, qty]) => ({ variantId, qty }));
}

/** Summen wie auf der Rechnung (netto je Position, USt je Satz einmal gerundet) */
export function cartTotals(lines: { qty: number; priceCents: number; vatRateBp: number }[]) {
  const t = computeTotals(lines.map((l) => ({ qty: l.qty, unitPriceCents: l.priceCents, discountBp: 0, vatRateBp: l.vatRateBp })));
  return { netCents: t.netCents, vatCents: t.vatCents, grossCents: t.grossCents, vatByRate: t.vatByRate };
}

/**
 * Prüfung beim Absenden gegen den aktuellen Bestand: unbekannt/inaktiv oder nicht verfügbar → Menge 0,
 * mehr bestellt als verfügbar → die verfügbare Menge (der Browser passt an und zeigt einen Hinweis).
 */
export function cartProblems(lines: CartLine[], available: Map<string, number>): { variantId: string; available: number }[] {
  const out: { variantId: string; available: number }[] = [];
  for (const l of lines) {
    const a = Math.max(0, available.get(l.variantId) ?? 0);
    if (l.qty > a) out.push({ variantId: l.variantId, available: a });
  }
  return out;
}

/** Warenkorb nach der Antwort des Servers anpassen: nicht verfügbare raus, sonst auf die verfügbare Menge */
export function applyProblems(lines: CartLine[], problems: { variantId: string; available: number }[]): CartLine[] {
  const p = new Map(problems.map((x) => [x.variantId, x.available]));
  return lines.flatMap((l) => {
    if (!p.has(l.variantId)) return [l];
    const a = p.get(l.variantId)!;
    return a > 0 ? [{ ...l, qty: Math.min(l.qty, a) }] : [];
  });
}

export type RateCounts = { ipHour: number; ipDay: number; emailDay: number; allHour: number };
/** Zu viele Anfragen? (Zahlen der letzten Stunde/24 Stunden aus der Datenbank) */
export function rateLimited(c: RateCounts): boolean {
  const L = DIRECT_LIMITS;
  return c.ipHour >= L.perIpHour || c.ipDay >= L.perIpDay || c.emailDay >= L.perEmailDay || c.allHour >= L.allHour;
}

/** Anzeige-Stand einer Liste: Angebot bzw. Rechnungsentwurf gelöscht (ID weg) = wieder offen */
export type DirectState = "new" | "done" | "rejected";
export function directState(o: { status: string; invoiceId: string | null; offerId: string | null }): DirectState {
  if (o.status === "REJECTED") return "rejected";
  if (o.status === "CONVERTED" && (o.invoiceId || o.offerId)) return "done";
  return "new";
}

/** Preisgruppe eines Links: RETAIL = „جملة“ (Salons), WHOLESALE = „جملة الجملة“ (Wiederverkäufer) */
export const DIRECT_GROUPS = ["RETAIL", "WHOLESALE"] as const;
export type DirectGroup = (typeof DIRECT_GROUPS)[number];

/** Link aus Basisadresse und Token, ohne doppelten Schrägstrich */
export const directLinkUrl = (base: string, token: string) => `${base.replace(/\/+$/, "")}/b/${token}`;
/** Token-Form: 24 Zeichen base64url (18 Zufallsbytes) – alles andere wird gar nicht erst in der Datenbank gesucht */
export const looksLikeToken = (s: string) => /^[A-Za-z0-9_-]{24}$/.test(s);

/** Nachricht zum Teilen (WhatsApp) – Platzhalter {url} */
export const shareText = (template: string, url: string) => template.replace("{url}", url);
