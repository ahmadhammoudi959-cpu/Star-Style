/**
 * Artikel aus Excel/CSV (Wunsch Inhaber 17.11.2026: „خش حط لي المنتجات دي كلها … والباركود موجود بالملف … والصور“).
 * Rein und getestet (tests/product-import.test.ts): Spalten erkennen, jede Zeile prüfen, Zeilen zu Artikeln mit
 * Größen/Farben zusammenfassen. Was schon im System ist, prüft src/lib/product-import-db.ts.
 */
import { norm } from "./agent/protocol";
import { netFromGross, parseMoney } from "./money";
import { parseWeight } from "./weight";
import { checkDigitOk } from "./barcode";
import type { Sheet } from "./sheet-read";

export const IMPORT_FIELDS = ["nameDe", "nameNl", "barcode", "sku", "category", "size", "color", "purchasePrice", "wholesalePrice", "retailPrice", "vat", "stock", "expiry", "minStock", "weight", "supplier", "description"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, number>>;
export const IMPORT_MAX_PRODUCTS = 2000;

/** Spaltennamen, wie sie in Lieferanten-Listen stehen (de/en/nl/ar/ku) – verglichen nach `norm` ohne Satzzeichen */
const SYN: Record<ImportField, string[]> = {
  nameDe: ["name", "name de", "bezeichnung", "artikel", "artikelname", "artikelbezeichnung", "produkt", "produktname", "product", "product name", "item", "item name", "titel", "title", "اسم", "الاسم", "اسم المنتج", "المنتج", "الصنف", "nav", "navê berhemê", "berhem"],
  nameNl: ["name nl", "naam", "nederlands", "niederlandisch", "hollandisch", "dutch", "produktname nl", "هولندي", "الاسم هولندي"],
  barcode: ["barcode", "ean", "ean13", "ean 13", "gtin", "upc", "strichcode", "streepjescode", "باركود", "الباركود", "barkod"],
  sku: ["sku", "art nr", "artnr", "artikelnummer", "artikel nr", "art nummer", "item no", "item number", "article number", "model", "modell", "ref", "referenz", "code", "artikelcode", "رقم المنتج", "رقم الصنف", "كود", "الكود", "hejmara berhemê"],
  category: ["kategorie", "category", "warengruppe", "gruppe", "produktgruppe", "typ", "type", "produkttyp", "categorie", "التصنيف", "الفئه", "القسم", "kategorî"],
  size: ["grosse", "size", "maat", "inhalt", "volumen", "content", "الحجم", "المقاس", "القياس", "mezinahî"],
  color: ["farbe", "color", "colour", "kleur", "farbton", "اللون", "reng"],
  purchasePrice: ["ek", "einkaufspreis", "ek preis", "ek netto", "einkauf", "purchase price", "cost", "cost price", "kosten", "inkoopprijs", "سعر الشراء", "التكلفه", "سعر التكلفه", "bihayê kirînê"],
  wholesalePrice: ["grosshandelspreis", "grosshandel", "wholesale", "wholesale price", "reseller", "reseller price", "wiederverkaufer", "wiederverkauferpreis", "handlerpreis", "haendlerpreis", "سعر جمله الجمله", "جمله الجمله"],
  retailPrice: ["einzelhandelspreis", "vk", "vk preis", "verkaufspreis", "preis", "price", "salon", "salonpreis", "verkoopprijs", "prijs", "سعر الجمله", "سعر البيع", "السعر", "bihayê firotinê", "biha"],
  vat: ["mwst", "mwst %", "ust", "vat", "steuer", "steuersatz", "tax", "btw", "الضريبه", "باج"],
  stock: ["bestand", "menge", "anzahl", "stuck", "stueck", "lager", "lagerbestand", "stock", "qty", "quantity", "aantal", "voorraad", "الكميه", "المخزون", "العدد", "hejmar", "embar"],
  expiry: ["mhd", "haltbarkeit", "haltbar bis", "ablaufdatum", "expiry", "expiry date", "best before", "houdbaarheid", "تاريخ الانتهاء", "الصلاحيه", "انتهاء الصلاحيه"],
  minStock: ["mindestbestand", "min bestand", "minimum", "min stock", "meldebestand", "الحد الادنى", "الحد الأدنى"],
  weight: ["gewicht", "weight", "gramm", "netto gewicht", "nettogewicht", "الوزن", "giranî"],
  supplier: ["lieferant", "hersteller", "marke", "brand", "supplier", "vendor", "manufacturer", "leverancier", "المورد", "الماركه", "الشركه", "dabînker"],
  description: ["beschreibung", "description", "details", "omschrijving", "الوصف", "التفاصيل", "danasîn"],
};
const key = (s: string) => norm(s).replace(/[^\p{L}\p{N}% ]+/gu, " ").replace(/\s+/g, " ").trim();
const SYN_KEYS = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, SYN[f].map(key)])) as Record<ImportField, string[]>;

/** Wie gut passt eine Spaltenüberschrift zu einem Feld? 3 = genau, 2 = beginnt damit, 1 = enthält, 0 = nein */
function headerScore(header: string, field: ImportField): number {
  const h = key(header);
  if (!h) return 0;
  let best = 0;
  for (const s of SYN_KEYS[field]) {
    if (h === s) return 3;
    if (h.startsWith(s + " ") || h.endsWith(" " + s)) best = Math.max(best, 2);
    else if (s.length >= 3 && ` ${h} `.includes(` ${s} `)) best = Math.max(best, 1);
  }
  return best;
}

/** Zeile mit den Spaltennamen: unter den ersten 15 die mit den meisten erkannten Namen (sonst die erste nicht leere) */
export function guessHeaderRow(rows: string[][]): number {
  let bestRow = rows.findIndex((r) => r.some((c) => c)), best = 1;
  for (const [i, r] of rows.slice(0, 15).entries()) {
    const score = r.filter((c) => IMPORT_FIELDS.some((f) => headerScore(c, f) >= 2)).length;
    if (score > best) { best = score; bestRow = i; }
  }
  return Math.max(0, bestRow);
}

/** Spalten den Feldern zuordnen: jede Spalte höchstens einmal, jedes Feld höchstens einmal, beste Treffer zuerst */
export function guessMapping(header: string[]): Mapping {
  const pairs: { f: ImportField; c: number; s: number }[] = [];
  for (const [c, h] of header.entries()) for (const f of IMPORT_FIELDS) { const s = headerScore(h, f); if (s) pairs.push({ f, c, s }); }
  // „Name NL“ vor „Name“, damit die NL-Spalte nicht als deutscher Name landet
  pairs.sort((a, b) => b.s - a.s || (a.f === "nameNl" ? -1 : b.f === "nameNl" ? 1 : 0) || a.c - b.c);
  const m: Mapping = {}, usedCols = new Set<number>();
  for (const p of pairs) {
    if (m[p.f] !== undefined || usedCols.has(p.c)) continue;
    m[p.f] = p.c; usedCols.add(p.c);
  }
  return m;
}

/** Zuordnung aus den Formularfeldern m_<Feld>=<Spalte> (leer = nicht übernehmen) */
export function mappingFromParams(get: (k: string) => string | null | undefined): Mapping | null {
  let any = false;
  const m: Mapping = {};
  for (const f of IMPORT_FIELDS) {
    const v = get(`m_${f}`);
    if (v == null) continue;
    any = true;
    const n = Number(v);
    if (v !== "" && Number.isInteger(n) && n >= 0 && n < 100) m[f] = n;
  }
  return any ? m : null;
}

export type Issue = "noName" | "noCode" | "dupBarcode" | "dupVariant" | "badPrice" | "badVat" | "badStock" | "badWeight" | "badDate" | "badBarcode" | "longCode" | "barcodeTaken" | "skuTaken" | "noPrice" | "noExpiry";
export type ImportRow = {
  /** Zeilennummer im Blatt (wie in Excel) */
  row: number;
  nameDe: string; nameNl: string; barcode: string; sku: string; category: string; size: string; color: string; supplier: string; description: string;
  purchase: number; wholesale: number; retail: number; vatBp: number; stock: number; expiry: string | null; minStock: number; weightGrams: number | null;
  /** Bild in dieser Zeile (Index in sheet.images) bzw. per Dateiname zugeordnetes Foto (Index in photos) */
  image: number | null; photo: number | null;
  errors: Issue[]; warnings: Issue[];
  /** Artikel (Gruppe), zu dem die Zeile gehört; erste Zeile der Gruppe = Hauptzeile */
  group: number; first: boolean;
};
export type ImportGroup = { index: number; rows: number[]; sku: string };

const cell = (r: string[], m: Mapping, f: ImportField) => (m[f] === undefined ? "" : (r[m[f]!] ?? "").trim());
/** Betrag: Excel-Zahl („12.5“, auch mehr Nachkommastellen) oder deutsche/englische Schreibweise („12,50 €“, „1.234,50“) */
export function importMoney(v: string): number | null {
  const s = v.replace(/[€\s]/g, "");
  if (!s) return 0;
  if (/^-?\d+\.\d+$/.test(s) && !/^-?\d{1,3}\.\d{3}$/.test(s)) return Math.round(parseFloat(s) * 100); // 12.345 = Tausender? nur bei genau 3 Stellen nach dem Punkt unklar → unten
  const c = parseMoney(s);
  return c == null ? null : c;
}
/** MwSt.: „19“, „19%“, „0,19“/„0.19“ (Excel-Prozentzelle) → Basispunkte; nur 19 % und 7 % sind erlaubt */
export function importVat(v: string): number | null {
  const s = v.replace(/[%\s]/g, "").replace(",", ".");
  if (!s) return 1900;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const pct = n > 0 && n < 1 ? n * 100 : n;
  if (Math.abs(pct - 19) < 0.01) return 1900;
  if (Math.abs(pct - 7) < 0.01) return 700;
  return null;
}
/** Datum: JJJJ-MM-TT, TT.MM.JJJJ, TT/MM/JJJJ (auch zweistellige Jahre) */
export function importDate(v: string): string | null {
  const s = v.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(s))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3].length === 2 ? `20${m[3]}` : m[3])];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
const stem = (name: string) => key(name.replace(/\.[^.]+$/, "")).replace(/\s+/g, "");

/**
 * Zeilen unter der Kopfzeile → geprüfte Zeilen + Artikel-Gruppen.
 * Gleicher Name (und gleiche Art.-Nr., falls angegeben) = ein Artikel; Größe/Farbe unterscheiden die Zeilen darin.
 * `photos` = zusätzlich abgelegte Fotos; Dateiname = Barcode, Art.-Nr. oder Artikelname.
 */
export function buildImport(sheet: Sheet, headerRow: number, m: Mapping, o: { gross?: boolean; photos?: { name: string }[] } = {}): { rows: ImportRow[]; groups: ImportGroup[] } {
  const rows: ImportRow[] = [];
  const photoByStem = new Map<string, number>();
  (o.photos ?? []).forEach((p, i) => { const k = stem(p.name); if (k && !photoByStem.has(k)) photoByStem.set(k, i); });
  const imageByRow = new Map<number, number>();
  sheet.images.forEach((img, i) => { if (!imageByRow.has(img.row)) imageByRow.set(img.row, i); });

  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    if (!r.some((c) => c)) continue;
    const errors: Issue[] = [], warnings: Issue[] = [];
    const nameDe = cell(r, m, "nameDe").replace(/\s+/g, " ").slice(0, 200);
    const barcode = cell(r, m, "barcode").replace(/\s+/g, "");
    const sku = cell(r, m, "sku").replace(/\s+/g, " ");
    if (!nameDe) errors.push("noName");
    if (barcode.length > 32 || sku.length > 64) errors.push("longCode");
    else if (barcode && !checkDigitOk(barcode)) warnings.push("badBarcode");
    const vat = importVat(cell(r, m, "vat"));
    if (vat == null) warnings.push("badVat");
    const vatBp = vat ?? 1900;
    const money = (f: ImportField) => {
      const c = importMoney(cell(r, m, f));
      if (c == null || c < 0) { if (!errors.includes("badPrice")) errors.push("badPrice"); return 0; }
      return o.gross ? netFromGross(c, vatBp) : c;
    };
    const purchase = money("purchasePrice"), wholesale = money("wholesalePrice"), retail = money("retailPrice");
    if (!errors.includes("badPrice") && !wholesale && !retail) warnings.push("noPrice");
    const stockText = cell(r, m, "stock").replace(/\s/g, "").replace(/[.,]0+$/, "");
    const stock = stockText ? Number(stockText) : 0;
    if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) errors.push("badStock");
    const minText = cell(r, m, "minStock").replace(/\s/g, "").replace(/[.,]0+$/, "");
    const minStock = minText ? Number(minText) : 0;
    const expiryText = cell(r, m, "expiry");
    const expiry = expiryText ? importDate(expiryText) : null;
    if (expiryText && !expiry) warnings.push("badDate");
    const w = parseWeight(cell(r, m, "weight"));
    if (w === undefined) warnings.push("badWeight");
    const photo = photoByStem.get(stem(barcode)) ?? photoByStem.get(stem(sku)) ?? photoByStem.get(stem(nameDe)) ?? null;
    rows.push({
      row: i + 1, nameDe, nameNl: cell(r, m, "nameNl").slice(0, 200), barcode, sku,
      category: cell(r, m, "category").slice(0, 100), size: cell(r, m, "size").slice(0, 60), color: cell(r, m, "color").slice(0, 60),
      supplier: cell(r, m, "supplier").slice(0, 200), description: cell(r, m, "description").slice(0, 4000),
      purchase, wholesale, retail, vatBp, stock: errors.includes("badStock") ? 0 : stock, expiry,
      minStock: Number.isInteger(minStock) && minStock >= 0 ? minStock : 0, weightGrams: w ?? null,
      image: imageByRow.get(i) ?? null, photo, errors, warnings, group: -1, first: false,
    });
  }

  // doppelte Barcodes in der Datei: die späteren Zeilen nicht
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.barcode) continue;
    if (seen.has(r.barcode)) r.errors.push("dupBarcode"); else seen.add(r.barcode);
  }

  // Artikel bilden: Name + (Art.-Nr., falls angegeben)
  const groups: ImportGroup[] = [];
  const byKey = new Map<string, ImportGroup>();
  for (const [idx, r] of rows.entries()) {
    if (r.errors.includes("noName")) continue;
    const k = `${key(r.nameDe)}|${key(r.sku)}`;
    let g = byKey.get(k);
    if (!g) { g = { index: groups.length, rows: [], sku: "" }; groups.push(g); byKey.set(k, g); }
    const variant = `${key(r.size)}|${key(r.color)}`;
    if (g.rows.some((j) => `${key(rows[j].size)}|${key(rows[j].color)}` === variant && !rows[j].errors.length)) { r.errors.push("dupVariant"); continue; }
    g.rows.push(idx);
  }
  for (const g of groups) {
    const ok = g.rows.filter((j) => !rows[j].errors.length);
    g.sku = rows[g.rows[0]]?.sku || ok.map((j) => rows[j].barcode).find(Boolean) || "";
    if (!g.sku) for (const j of g.rows) if (!rows[j].errors.length) rows[j].errors.push("noCode");
    // Artikel mit MHD: jeder Bestand braucht ein MHD (Abgang nach FEFO) – sonst diese Zeile nicht
    if (g.rows.some((j) => rows[j].expiry)) for (const j of g.rows) if (!rows[j].errors.length && rows[j].stock > 0 && !rows[j].expiry) rows[j].errors.push("noExpiry");
    g.rows.forEach((j, n) => { rows[j].group = g.index; rows[j].first = n === 0; });
  }
  return { rows, groups: groups.filter((g) => g.rows.length) };
}

/** Spaltenname für die Auswahl: „B · Barcode“ */
export function columnLabel(header: string[], c: number): string {
  let n = c + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  const h = header[c] ?? "";
  return h ? `${s} · ${h.length > 24 ? `${h.slice(0, 23)}…` : h}` : s;
}
