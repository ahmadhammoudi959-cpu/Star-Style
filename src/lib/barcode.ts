/**
 * Gescannte Codes vergleichbar machen. Rein und getestet.
 * Kameras liefern dieselbe Nummer mal als UPC-A (12 Ziffern), mal als EAN-13 mit führender 0 – beides soll treffen.
 */

/** Alle Schreibweisen, unter denen der Code gespeichert sein könnte (Leerzeichen weg, UPC-A ↔ EAN-13 mit führender 0). */
export function barcodeCandidates(raw: string): string[] {
  const code = raw.replace(/\s+/g, "").trim();
  if (!code) return [];
  const out = new Set([code]);
  if (/^0\d{12}$/.test(code)) out.add(code.slice(1)); // EAN-13 „0…“ = UPC-A
  if (/^\d{12}$/.test(code)) out.add(`0${code}`);    // UPC-A → EAN-13
  return [...out];
}

/** Prüfziffer von EAN-8/EAN-13/UPC-A stimmt? (andere Codes: true – dort prüft der Leser selbst) */
export function checkDigitOk(code: string): boolean {
  if (!/^\d{8}$|^\d{12,13}$/.test(code)) return true;
  const digits = code.split("").map(Number);
  const check = digits.pop()!;
  // von rechts: abwechselnd ×3 und ×1
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
