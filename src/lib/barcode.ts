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

/**
 * Kamerabild für den Barcode-Leser vorbereiten (Wunsch Inhaber 12.11.2026: weißer Barcode auf rotem Karton wurde nicht gelesen,
 * schwarz auf weiß sofort). Arbeitet direkt auf RGBA-Daten (ImageData.data):
 * - Graustufe aus dem dunkelsten Farbkanal: Weiß bleibt hell, jede kräftige Farbe wird dunkel (Rot hat kaum Grün/Blau),
 *   so heben sich weiße Striche viel stärker ab als in der üblichen Graustufe.
 * - Kontrast auf die ganze Breite gezogen (1 %/99 %, einzelne Spiegelungen zählen nicht).
 * - invert: helle Striche auf farbigem Grund → dunkle Striche auf hellem Grund, wie jeder Leser sie erwartet
 *   (der eingebaute Leser von Android dreht nicht selbst um).
 */
export function prepareScanFrame(d: Uint8ClampedArray, invert: boolean): void {
  const n = d.length >> 2;
  if (!n) return;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const m = r < g ? (r < b ? r : b) : g < b ? g : b;
    d[i] = m; // Zwischenspeicher im Rot-Kanal
    hist[m]++;
  }
  const cut = Math.max(1, Math.floor(n * 0.01));
  let lo = 0, hi = 255;
  for (let acc = 0; lo < 255; lo++) { acc += hist[lo]; if (acc >= cut) break; }
  for (let acc = 0; hi > 0; hi--) { acc += hist[hi]; if (acc >= cut) break; }
  const span = hi - lo;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const s = span > 8 ? ((v - lo) * 255) / span : v; // fast einfarbig → nicht strecken
    lut[v] = invert ? 255 - s : s; // Uint8ClampedArray rundet und begrenzt auf 0…255
  }
  for (let i = 0; i < d.length; i += 4) { const v = lut[d[i]]; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255; }
}

/** Reihenfolge der Bilder beim Scannen: jedes zweite unverändert, dazwischen umgedreht (helle Striche) bzw. farbverstärkt */
export const scanFrameMode = (tick: number): "raw" | "inverted" | "color" => (tick % 2 === 0 ? "raw" : tick % 4 === 1 ? "inverted" : "color");
