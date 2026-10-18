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
