/**
 * Versandart je Artikel (Wunsch Inhaber 19.11.2026): Paket mit GLS oder Spedition (Möbel – Preis kommt später von einer
 * eigenen Speditionsfirma, bis dahin im Shop nur Abholung bzw. Anfrage per WhatsApp).
 * Grenzen aus dem GLS-Vertrag (AGB Ziffer 4.2, Übermaßpaket): höchstens 40 kg, Länge 200 cm, Breite 80 cm, Höhe 60 cm,
 * Gurtmaß 300 cm (Länge + 2 × Breite + 2 × Höhe; die Seiten der Größe nach: Länge = längste, Höhe = kürzeste).
 * Größer oder schwerer → Spedition. Rein und getestet (tests/shipping-class.test.ts) – auch im Browser benutzt.
 */

export const GLS_LIMITS = { grams: 40_000, lengthMm: 2000, widthMm: 800, heightMm: 600, girthMm: 3000 } as const;

export type ShippingClass = "PARCEL" | "FREIGHT";
/** Paketmaße in ganzen Millimetern (Länge, Breite, Höhe in beliebiger Reihenfolge) */
export type PackageDims = { l: number; w: number; h: number };
export type FreightReason = "weight" | "length" | "width" | "height" | "girth";

/** Tag am Shop-Produkt: daran erkennen Theme (Lieferhinweis) und Versandtarif (Kollektion ohne diesen Tag) die Möbel */
export const FREIGHT_TAG = "spedition";

export const MAX_DIM_MM = 10_000; // 10 m

/** Seiten absteigend sortiert: [Länge, Breite, Höhe] */
export function sortedSides(d: PackageDims): [number, number, number] {
  const s = [d.l, d.w, d.h].sort((a, b) => b - a);
  return [s[0], s[1], s[2]];
}

/** Gründe, warum eine Packung nicht als GLS-Paket geht (leer = geht als Paket bzw. nichts bekannt) */
export function freightReasons(weightGrams: number | null | undefined, dims: PackageDims | null | undefined): FreightReason[] {
  const r: FreightReason[] = [];
  if (weightGrams != null && weightGrams > GLS_LIMITS.grams) r.push("weight");
  if (dims) {
    const [L, W, H] = sortedSides(dims);
    if (L > GLS_LIMITS.lengthMm) r.push("length");
    if (W > GLS_LIMITS.widthMm) r.push("width");
    if (H > GLS_LIMITS.heightMm) r.push("height");
    if (L + 2 * W + 2 * H > GLS_LIMITS.girthMm) r.push("girth");
  }
  return r;
}

export type ProductShipping = {
  cls: ShippingClass;
  /** true = aus Gewicht/Maßen berechnet; false = am Artikel fest eingestellt */
  auto: boolean;
  /** Gründe aus Gewicht/Maßen (auch bei fester Einstellung zur Info) */
  reasons: FreightReason[];
  /** irgendeine Größe/Farbe hat Gewicht oder Paketmaße */
  known: boolean;
};

/**
 * Versandart eines Artikels: fest eingestellt (mode) oder automatisch – Spedition, sobald eine Größe/Farbe nicht als
 * GLS-Paket geht. Ohne Gewicht und Maße automatisch Paket (am Artikel auf „Spedition“ stellen, wenn es Möbel sind).
 */
export function productShipping(mode: ShippingClass | null | undefined,
  variants: { weightGrams: number | null | undefined; dims: PackageDims | null | undefined }[]): ProductShipping {
  const reasons = [...new Set(variants.flatMap((v) => freightReasons(v.weightGrams, v.dims)))];
  const known = variants.some((v) => (v.weightGrams ?? 0) > 0 || Boolean(v.dims));
  if (mode === "PARCEL" || mode === "FREIGHT") return { cls: mode, auto: false, reasons, known };
  return { cls: reasons.length ? "FREIGHT" : "PARCEL", auto: true, reasons, known };
}

/** Datenbank-Spalten → Maße (nur wenn alle drei gesetzt sind) */
export function dimsOf(row: { pkgLengthMm?: number | null; pkgWidthMm?: number | null; pkgHeightMm?: number | null }): PackageDims | null {
  const { pkgLengthMm: l, pkgWidthMm: w, pkgHeightMm: h } = row;
  return l && w && h ? { l, w, h } : null;
}

/** „51“, „45,5“ cm → mm; leer → null; ungültig → undefined */
function cmToMm(s: string): number | null | undefined {
  const t = s.trim().replace(/\s+/g, "").replace(/cm$/i, "");
  if (!t) return null;
  if (!/^\d+(?:[.,]\d+)?$/.test(t)) return undefined;
  const mm = Math.round(Number(t.replace(",", ".")) * 10);
  return mm > 0 && mm <= MAX_DIM_MM ? mm : undefined;
}

/**
 * Formular (Länge, Breite, Höhe in cm, Komma oder Punkt) → Maße in mm.
 * Alle drei leer → null (keine Maße). Nur ein Teil ausgefüllt oder ungültig → undefined (Fehlermeldung).
 */
export function parseDims(l: string, w: string, h: string): PackageDims | null | undefined {
  const v = [cmToMm(l ?? ""), cmToMm(w ?? ""), cmToMm(h ?? "")];
  if (v.every((x) => x === null)) return null;
  if (v.some((x) => x == null)) return undefined;
  return { l: v[0]!, w: v[1]!, h: v[2]! };
}

const cm = (mm: number) => (Math.round(mm) / 10).toString().replace(".", ",");

/** Maße → Formularfelder in cm („51“, „45,5“) */
export function dimsInputParts(d: PackageDims | null | undefined): { pkgL: string; pkgW: string; pkgH: string } {
  return d ? { pkgL: cm(d.l), pkgW: cm(d.w), pkgH: cm(d.h) } : { pkgL: "", pkgW: "", pkgH: "" };
}

/** Anzeige „51 × 46 × 41 cm“ (Reihenfolge wie eingegeben) */
export function formatDims(d: PackageDims): string {
  return `${cm(d.l)} × ${cm(d.w)} × ${cm(d.h)} cm`;
}

/**
 * Wert eines GLS-Pakets (Wunsch Inhaber 19.11.2026, GLS-AGB 10.2 und 4.1): GLS haftet je Paket höchstens mit 750 €
 * (Einkaufspreis), Pakete über 5.000 € Warenwert sind von der Beförderung ausgeschlossen.
 * Warenwert netto der Sendung gleichmäßig auf die Pakete verteilt → „ok“ / „over750“ / „over5000“.
 */
export const GLS_LIABILITY_CENTS = 75_000;
export const GLS_MAX_VALUE_CENTS = 500_000;
export function parcelValueLevel(goodsNetCents: number, parcels: number): "ok" | "over750" | "over5000" {
  const per = goodsNetCents / Math.max(1, parcels);
  if (per > GLS_MAX_VALUE_CENTS) return "over5000";
  if (per > GLS_LIABILITY_CENTS) return "over750";
  return "ok";
}
