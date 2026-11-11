/** Geld immer in Cent. */
export function formatCents(cents: number, locale = "de-DE", currency = "EUR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

/** "12,50" | "12.50" | "1.234,56" | "1,234.56" → 1250 / 123456. Ungültig → null. */
export function parseMoney(input: string | null | undefined): number | null {
  if (input == null) return null;
  let s = String(input).trim().replace(/[€\s]/g, "");
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // das letzte Trennzeichen ist das Dezimaltrennzeichen
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = s.replace(",", ".");
  }
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

/** Basispunkte → Prozent-Text: 1900 → "19" ; 550 → "5,5" */
export function bpToPercent(bp: number): string {
  return (bp / 100).toLocaleString("de-DE", { maximumFractionDigits: 2 });
}

export function parsePercentToBp(input: string | null | undefined): number | null {
  if (input == null || String(input).trim() === "") return 0;
  const v = parseMoney(String(input).replace("%", ""));
  if (v == null || v < 0 || v > 10000) return null;
  return v; // parseMoney liefert ×100 → genau Basispunkte
}

/** Rundung kaufmännisch auf ganze Cent */
export function applyBp(cents: number, bp: number): number {
  return Math.round((cents * bp) / 10000);
}

/** Brutto-Cent → Netto-Cent (so rechnet der Shop-Import: kaufmännisch gerundet) */
export function netFromGross(grossCents: number, vatRateBp: number): number {
  return Math.round((grossCents * 10000) / (10000 + vatRateBp));
}

/** Wie „rund“ ein Preis ist: ganze Euro 4, x,x0 3, x,x5 2, x,x9 1, sonst 0 */
export const priceRoundness = (c: number) => (c % 100 === 0 ? 4 : c % 10 === 0 ? 3 : c % 5 === 0 ? 2 : c % 10 === 9 ? 1 : 0);

/**
 * Netto-Cent → Brutto-Cent. Oft ergeben ZWEI Bruttopreise denselben Nettopreis (490,00 € und 489,99 € → 411,76 €), weil
 * 1 Cent netto 1,19 Cent brutto sind. Dann nimmt man den runderen – genau der stand im Shop, als der Preis importiert
 * wurde. Vorher immer kaufmännisch gerundet: „Alle Preise an den Shop senden“ machte am 09.11.2026 aus 69 Shop-Preisen
 * wie 490,00 € → 489,99 € bzw. 790,00 € → 790,01 €.
 */
export function grossFromNet(netCents: number, vatRateBp: number): number {
  const exact = (netCents * (10000 + vatRateBp)) / 10000;
  const base = Math.round(exact);
  let best = base;
  for (const g of [base - 1, base + 1]) {
    if (g < 0 || netFromGross(g, vatRateBp) !== netCents) continue;
    const better = priceRoundness(g) - priceRoundness(best) || Math.abs(best - exact) - Math.abs(g - exact);
    if (better > 0) best = g;
  }
  return best;
}
