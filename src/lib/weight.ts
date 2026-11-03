/**
 * Gewicht je Größe/Farbe (Wunsch Inhaber 03.11.2026, u. a. für Versand nach Gewicht im Shop). Gespeichert in ganzen Gramm.
 * Rein und getestet – auch im Browser benutzt.
 */

export type WeightUnit = "g" | "kg";
export const MAX_WEIGHT_GRAMS = 1_000_000; // 1 t

/**
 * Eingabe → Gramm. Steht eine Einheit im Text („1,5 kg“, „150g“), gilt sie, sonst die gewählte.
 * Leer oder 0 → null (kein Gewicht). Ungültig → undefined.
 */
export function parseWeight(text: string, unit: WeightUnit = "g"): number | null | undefined {
  const s = text.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const m = /^(\d+(?:[.,]\d+)?)(kg|g)?$/.exec(s);
  if (!m) return undefined;
  const value = Number(m[1].replace(",", "."));
  const grams = Math.round(value * ((m[2] ?? unit) === "kg" ? 1000 : 1));
  if (!Number.isFinite(grams) || grams > MAX_WEIGHT_GRAMS) return undefined;
  return grams > 0 ? grams : null;
}

const kgNumber = (grams: number) => (Math.round(grams / 10) / 100).toString().replace(".", ",");

/** Anzeige im deutschen Format: „150 g“, „1,5 kg“, „35 kg“ */
export function formatWeight(grams: number): string {
  return grams < 1000 ? `${grams} g` : `${kgNumber(grams)} kg`;
}

/** Gramm → Formularfeld (Text + Einheit): ab 1 kg in kg */
export function weightInputParts(grams: number | null | undefined): { weight: string; weightUnit: WeightUnit } {
  if (!grams) return { weight: "", weightUnit: "g" };
  return grams >= 1000 ? { weight: kgNumber(grams), weightUnit: "kg" } : { weight: String(grams), weightUnit: "g" };
}

/** Gesamtgewicht einer Sendung; missing = Positionen ohne Gewicht */
export function shipmentWeight(lines: { qty: number; weightGrams: number | null }[]): { grams: number; missing: number } {
  let grams = 0, missing = 0;
  for (const l of lines) {
    if (l.weightGrams && l.weightGrams > 0) grams += Math.abs(l.qty) * l.weightGrams;
    else if (l.qty) missing++;
  }
  return { grams, missing };
}

/** Gewicht aus Shopify (Einheit GRAMS/KILOGRAMS/OUNCES/POUNDS) → Gramm; 0 → null */
export function shopWeightToGrams(w: { unit: string; value: number } | null | undefined): number | null {
  if (!w || !(w.value > 0)) return null;
  const factor: Record<string, number> = { GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237 };
  const g = Math.round(w.value * (factor[w.unit] ?? 0));
  return g > 0 && g <= MAX_WEIGHT_GRAMS ? g : null;
}
