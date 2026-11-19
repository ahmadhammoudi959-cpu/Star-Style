import "server-only";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { AFRelationship, PDFDocument, PDFFont, PDFName, PDFPage, rgb, setCharacterSpacing, type PDFImage, type RGB } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { formatWeight, shipmentWeight } from "./weight";
import { formatCents, bpToPercent } from "./money";
import { addDaysIso, formatDate } from "./dates";
import { legalNotes } from "./tax";
import { buildCiiXml } from "./einvoice";
import { epcPayload, modulesPath, qrModules } from "./epc-qr";
import { DEFAULT_DESIGN, contrast, fillPlaceholders, hexToRgb, isDark, mix, parseDesign, type DocDesign, type Rgb } from "./doc-design";

export const MM = 2.8346;
export const W = 595.28, H = 841.89;
// Farben aus dem Logo: Nachtblau (Tabellenkopf), Blau (Summen), Rot (Akzent)
export const BRAND = rgb(0.067, 0.102, 0.2);
export const BLUE = rgb(0.09, 0.322, 0.839);
export const RED = rgb(0.89, 0.098, 0.11);
export const INK = rgb(0.114, 0.141, 0.2);
export const SOFT = rgb(0.36, 0.39, 0.46);
export const LINE = rgb(0.85, 0.87, 0.9);
export const ZEBRA = rgb(0.957, 0.965, 0.98);
export const WHITE = rgb(1, 1, 1);
/** helle Schrift auf Nachtblau, zarte Fläche für Kästen */
export const PALE = rgb(0.72, 0.78, 0.9);
export const TINT = rgb(0.945, 0.955, 0.978);
// Rahmen aller Belege (Wunsch Inhaber 12.11.2026, Vorlagen Q-Design-Angebot / Go-Trend-Rechnung): oben und unten ein Band in
// der Markenfarbe, darunter bzw. darüber die Logo-Linie Blau/Rot, unten alle Firmendaten.
export const BAND_TOP = 26 * MM, BAND_BOTTOM = 30 * MM, STRIPE = 1.6 * MM;
/** Inhalt beginnt auf Folgeseiten hier und endet unten hier */
export const CONTENT_TOP = H - BAND_TOP - STRIPE - 11 * MM, CONTENT_BOTTOM = BAND_BOTTOM + STRIPE + 9 * MM;

// ───────────────────────── Belegdesign → Farben, Größen ─────────────────────────
// Seite „Belegdesign“ (Wunsch Inhaber 12.11.2026). Standard = genau die Konstanten oben (bisheriges Aussehen, geprüft).
// Flächen in einer hellen Hauptfarbe bekommen dunkle Schrift (Kontrast), helle Kopfzeile das normale (dunkle) Logo.
export type Theme = {
  d: DocDesign; k: number;
  brand: RGB; blue: RGB; red: RGB; ink: RGB; soft: RGB; line: RGB; tint: RGB;
  /** Haupt-/Akzentfarbe als Schrift auf Weiß – zu helle Farben (z. B. Gelb) werden dafür abgedunkelt */
  brandText: RGB; accentText: RGB;
  bandDark: boolean; onBand: RGB; onBandSoft: RGB; onBandLine: RGB; onBandRule: RGB; onBrand: RGB; onAccent: RGB;
};
const toRgb = (c: Rgb) => rgb(c[0], c[1], c[2]);
/** so lange abdunkeln, bis die Farbe auf Weiß gut lesbar ist (Kontrast 4,5) */
const readable = (c: Rgb): Rgb => { let x = c; for (let i = 0; i < 14 && contrast(x, [1, 1, 1]) < 4.5; i++) x = mix(x, [0, 0, 0], 0.15); return x; };
export function makeTheme(design?: DocDesign | null): Theme {
  const d = design ?? DEFAULT_DESIGN, D = DEFAULT_DESIGN.colors;
  const P = hexToRgb(d.colors.primary), A = hexToRgb(d.colors.accent);
  const defP = d.colors.primary === D.primary, dark = isDark(P);
  const toward = (t: number, light: number) => toRgb(mix(P, dark ? [1, 1, 1] : [0, 0, 0], dark ? t : light));
  return {
    d, k: d.fontSize / 100,
    brand: defP ? BRAND : toRgb(P),
    blue: d.colors.accent === D.accent ? BLUE : toRgb(A),
    red: d.colors.accent2 === D.accent2 ? RED : toRgb(hexToRgb(d.colors.accent2)),
    ink: d.colors.text === D.text ? INK : toRgb(hexToRgb(d.colors.text)),
    soft: SOFT, line: LINE,
    tint: d.colors.accent === D.accent ? TINT : toRgb(mix([1, 1, 1], A, 0.07)),
    brandText: defP ? BRAND : toRgb(readable(P)),
    accentText: d.colors.accent === D.accent ? BLUE : toRgb(readable(A)),
    bandDark: dark,
    onBand: dark ? WHITE : INK,
    onBandSoft: defP ? PALE : toward(0.72, 0.62),
    onBandLine: defP ? rgb(0.87, 0.9, 0.96) : toward(0.86, 0.78),
    onBandRule: defP ? rgb(0.24, 0.3, 0.44) : toward(0.2, 0.22),
    onBrand: dark ? WHITE : INK,
    onAccent: isDark(A) ? WHITE : INK,
  };
}
export const DEFAULT_THEME = makeTheme(DEFAULT_DESIGN);
/** Design aus den Einstellungen (gespeichert sind nur die Abweichungen) */
export const designOf = (company: { docDesign?: unknown } | null | undefined) => parseDesign(company?.docDesign ?? {});

export type Fonts = { r: TFont; s: TFont; b: TFont };
type DocKind = "invoice" | "cancellation" | "offer" | "delivery";

type Party = { name: string; street: string; zip: string; city: string; country: string; vatId: string };
type Line = { position: number; sku: string; ean: string | null; category?: string; imageFileId?: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; netCents: number; vatRateBp: number; vatCents?: number; weightGrams?: number | null };
export type DocData = {
  kind: DocKind; number: string; date: string; deliveryDate: string | null; dueDate: string | null; validUntil: string | null;
  customerNo: number; customerId: string; buyer: Party; lines: Line[];
  subtotalCents: number; discountCents: number; discountBp: number; netCents: number; vatCents: number; grossCents: number;
  vatBreakdown: { rateBp: number; netCents: number; vatCents: number }[];
  taxMode: "DOMESTIC" | "EU_REVERSE_CHARGE" | "EU_PENDING_VATID" | "EU_B2C" | "EXPORT"; ossCountry: string | null;
  retentionOfTitle: boolean; notes: string; refNumber: string | null;
  /** nur Rechnung: bei Ausstellung bereits erhaltene Zahlungen und Ratenplan */
  received?: { amountCents: number; method: string }[]; installments?: { dueDate: string; amountCents: number }[];
  /** Positionen mit Bruttopreisen (Shop-Bestellungen) */
  pricesGross?: boolean;
};
const METHOD_DE: Record<string, string> = { CASH: "bar", BANK: "per Überweisung", CARD: "per Karte", ONLINE: "online" };

const COUNTRY: Record<string, string> = { DE: "", NL: "Niederlande", BE: "Belgien", AT: "Österreich", FR: "Frankreich", LU: "Luxemburg", PL: "Polen", CH: "Schweiz", IT: "Italien", ES: "Spanien", DK: "Dänemark", CZ: "Tschechien" };
const countryName = (c: string) => (c === "DE" ? "" : COUNTRY[c] ?? c);

// ───────────── Schrift mit Arabisch-Unterstützung ─────────────
// Lateinische Texte: IBM Plex Sans (Teilmenge). Arabische Textstücke: IBM Plex Sans Arabic (vollständig eingebettet,
// damit fontkit die Buchstaben verbindet und von rechts nach links setzt). Gemischte Zeilen werden in Stücke zerlegt
// und in der richtigen Reihenfolge gezeichnet (vereinfachter Bidi: Grundrichtung = erstes starkes Zeichen).
const AR = "\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF";
const AR_RUN = new RegExp(`[${AR}](?:[${AR}\\s]*[${AR}])?`, "g");
const HAS_AR = new RegExp(`[${AR}]`);
const FIRST_STRONG = new RegExp(`[${AR}A-Za-zÀ-ɏ]`);
export const hasArabic = (t: string) => HAS_AR.test(t);
const MIRROR: Record<string, string> = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<", "«": "»", "»": "«" };
const mirror = (c: string) => MIRROR[c] ?? c;

/** Text in sichtbarer Reihenfolge (links → rechts) als Stücke mit Schriftart-Kennzeichen */
export function visualRuns(text: string): { t: string; ar: boolean }[] {
  if (!HAS_AR.test(text)) return [{ t: text, ar: false }];
  const runs: { t: string; ar: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(AR_RUN)) {
    if (m.index! > last) runs.push({ t: text.slice(last, m.index), ar: false });
    runs.push({ t: m[0], ar: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) runs.push({ t: text.slice(last), ar: false });
  const rtl = HAS_AR.test(text.match(FIRST_STRONG)?.[0] ?? "");
  if (!rtl) return runs;
  // Rechts-nach-links: Reihenfolge umdrehen, Leerzeichen der lateinischen Stücke auf die andere Seite
  return runs.reverse().map((r) => {
    if (r.ar) return r;
    // Neutrale Zeichen (Leerzeichen, Striche, Klammern …) am Rand folgen der Grundrichtung (rechts nach links)
    // Vorzeichen direkt vor einer Ziffer gehört zur Zahl („+49 178 …“, „-400,00 €“), sonst stünde es am anderen Ende
    const lead = r.t.match(/^(?:(?![+\-\u2212]\d)[^\p{L}\p{N}])*/u)![0], trail = r.t.match(/[^\p{L}\p{N}]*$/u)![0];
    if (lead.length === r.t.length) return { t: [...r.t].reverse().map(mirror).join(""), ar: false };
    const core = r.t.slice(lead.length, r.t.length - trail.length);
    const rev = (x: string) => [...x].reverse().map(mirror).join("");
    return { t: rev(trail) + core + rev(lead), ar: false };
  });
}

export class TFont {
  constructor(public lat: PDFFont, public ar: PDFFont | null) {}
  private fontFor(ar: boolean) { return ar && this.ar ? this.ar : this.lat; }
  widthOfTextAtSize(t: string, size: number) {
    return visualRuns(t).reduce((w, r) => w + this.fontFor(r.ar).widthOfTextAtSize(r.t, size), 0);
  }
  draw(page: PDFPage, t: string, o: { x: number; y: number; size: number; color: RGB }) {
    let x = o.x;
    for (const r of visualRuns(t)) {
      const f = this.fontFor(r.ar);
      if (r.t) page.drawText(r.t, { x, y: o.y, size: o.size, font: f, color: o.color });
      x += f.widthOfTextAtSize(r.t, o.size);
    }
  }
}

export async function fonts(doc: PDFDocument, needArabic: boolean): Promise<Fonts> {
  doc.registerFontkit(fontkit);
  const dir = path.join(process.cwd(), "assets", "fonts");
  const load = (f: string, subset = true) => doc.embedFont(fs.readFileSync(path.join(dir, f)), { subset });
  const ar = async (f: string) => {
    if (!needArabic) return null;
    const data = fs.readFileSync(path.join(dir, f));
    const font = await doc.embedFont(data, { subset: false });
    // pdf-lib schreibt Breiten nur für Zeichen mit eigenem Unicode-Wert; arabische Anfangs-/Mittel-/Endformen
    // haben keinen → falsche Abstände. Darum Breitentabelle für ALLE Glyphen (aus einer eigenen, unberührten
    // fontkit-Instanz, damit die Formung der Buchstaben nicht gestört wird).
    const twin = fontkit.create(data) as unknown as { numGlyphs: number; unitsPerEm: number; getGlyph(i: number): { advanceWidth: number } };
    const widths = Array.from({ length: twin.numGlyphs }, (_, i) => Math.round((twin.getGlyph(i).advanceWidth * 1000) / twin.unitsPerEm));
    (font as unknown as { embedder: { computeWidths: () => unknown[] } }).embedder.computeWidths = () => [0, widths];
    return font;
  };
  return {
    r: new TFont(await load("IBMPlexSans-Regular.woff"), await ar("IBMPlexSansArabic_400Regular.ttf")),
    s: new TFont(await load("IBMPlexSans-SemiBold.woff"), await ar("IBMPlexSansArabic_600SemiBold.ttf")),
    b: new TFont(await load("IBMPlexSans-Bold.woff"), await ar("IBMPlexSansArabic_700Bold.ttf")),
  };
}

export function wrap(text: string, font: TFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) <= width) line = test;
      else { if (line) out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

// ───────────────────────── Rahmen: Kopfband, Fußband ─────────────────────────

/** Gesperrter Text (Kapitälchen-Optik); arabische Texte ohne Sperrung, sonst reißen die verbundenen Buchstaben auseinander */
export function spacedWidth(font: TFont, t: string, size: number, spacing: number) {
  return font.widthOfTextAtSize(t, size) + (hasArabic(t) ? 0 : spacing * Math.max(0, [...t].length - 1));
}
export function drawSpaced(page: PDFPage, font: TFont, t: string, o: { x: number; y: number; size: number; color: RGB; spacing: number }) {
  if (!o.spacing || hasArabic(t)) return font.draw(page, t, o);
  page.pushOperators(setCharacterSpacing(o.spacing));
  font.draw(page, t, o);
  page.pushOperators(setCharacterSpacing(0));
}
/** Rechteck mit runden Ecken (x, y = unten links) */
export function roundRect(page: PDFPage, x: number, y: number, w: number, h: number, r: number, color: RGB, outline?: number) {
  const d = `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
  if (outline) page.drawSvgPath(d, { x, y: y + h, borderColor: color, borderWidth: outline });
  else page.drawSvgPath(d, { x, y: y + h, color });
}
export const formatIban = (iban: string) => iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

/**
 * Logo fürs Kopfband: auf dunklem Band die helle Fassung (weiße Schrift) aus public/brand, sonst das Logo aus den Einstellungen
 * auf weißem Feld; heller Kopf (Belegdesign „hell“/„schlicht“ oder helle Hauptfarbe) → das normale Logo ohne Feld.
 */
export async function embedBandLogo(doc: PDFDocument, fileId: string | null, th: Theme = DEFAULT_THEME): Promise<{ img: PDFImage; tile: boolean } | null> {
  if (th.d.header !== "band" || !th.bandDark) {
    const img = await embedLogo(doc, fileId);
    return img ? { img, tile: false } : null;
  }
  const light = path.join(process.cwd(), "public", "brand", "logo-light.png");
  if (fs.existsSync(light)) return { img: await doc.embedPng(fs.readFileSync(light)), tile: false };
  const img = await embedLogo(doc, fileId);
  return img ? { img, tile: true } : null;
}

export type BandHead = { label: string; number: string; date: string };
type BandCompany = Pick<typeof schema.companySettings.$inferSelect, "name" | "street" | "zip" | "city" | "owner" | "phone" | "email" | "website" | "bankName" | "iban" | "bic" | "vatId" | "taxNumber">;
export type FooterLabels = { thanks: string; contact: string; bank: string; tax: string; owner: string; phone: string; page: string };
export const FOOTER_DE: FooterLabels = { thanks: "Vielen Dank für Ihr Vertrauen.", contact: "Kontakt", bank: "Bankverbindung", tax: "Steuern", owner: "Gesellschafter", phone: "Tel.", page: "Seite {n} von {m}" };

/**
 * Kopf: Logo am Anfang, Belegart/Nummer/Datum am Ende (RTL gespiegelt). Belegdesign: „band“ = Fläche in der Hauptfarbe
 * (bisher), „light“ = weiß, „minimal“ = weiß ohne Linie; darunter die Logo-Linie (abschaltbar); optional ein Zusatztext
 * in der Mitte (z. B. Slogan). Gleiche Höhe in allen Varianten – Anschrift bleibt im Fenster des Umschlags.
 */
export function drawHeaderBand(page: PDFPage, f: Fonts, logo: { img: PDFImage; tile: boolean } | null, head: BandHead, brandName: string, rtl = false, th: Theme = DEFAULT_THEME) {
  const L = 20 * MM, R = W - 20 * MM, blue = W * 0.72;
  const band = th.d.header === "band";
  if (band) page.drawRectangle({ x: 0, y: H - BAND_TOP, width: W, height: BAND_TOP, color: th.brand });
  if (th.d.stripe && th.d.header !== "minimal") {
    page.drawRectangle({ x: rtl ? W - blue : 0, y: H - BAND_TOP - STRIPE, width: blue, height: STRIPE, color: th.blue });
    page.drawRectangle({ x: rtl ? 0 : blue, y: H - BAND_TOP - STRIPE, width: W - blue, height: STRIPE, color: th.red });
  } else if (th.d.header === "light") {
    page.drawLine({ start: { x: L, y: H - BAND_TOP }, end: { x: R, y: H - BAND_TOP }, thickness: 0.8, color: th.line });
  }
  const strong = band ? th.onBand : th.brandText, soft = band ? th.onBandSoft : th.soft, label = band ? th.onBandSoft : th.accentText;
  const scale = th.d.logoSize === "s" ? 0.78 : th.d.logoSize === "l" ? 1.2 : 1;
  let logoEnd = L;
  if (logo) {
    const h = (logo.tile ? 13 * MM : 15.5 * MM) * scale;
    const w = Math.min(62 * MM * scale, (logo.img.width / logo.img.height) * h);
    const lh = (logo.img.height / logo.img.width) * w, x = rtl ? R - w : L, y = H - BAND_TOP / 2 - lh / 2;
    if (logo.tile) roundRect(page, x - 2 * MM, y - 1.6 * MM, w + 4 * MM, lh + 3.2 * MM, 1.6 * MM, WHITE);
    page.drawImage(logo.img, { x, y, width: w, height: lh });
    logoEnd = L + w;
  } else {
    const t = brandName || "Star Style", w = f.b.widthOfTextAtSize(t, 17);
    f.b.draw(page, t, { x: rtl ? R - w : L, y: H - BAND_TOP / 2 - 6, size: 17, color: strong });
    logoEnd = L + w;
  }
  let labelW = 0;
  const end = (t: string, font: TFont, size: number, y: number, color: RGB, spacing = 0) => {
    const w = spacedWidth(font, t, size, spacing);
    labelW = Math.max(labelW, w);
    drawSpaced(page, font, t, { x: rtl ? L : R - w, y, size, color, spacing });
  };
  end(head.label.toLocaleUpperCase("de-DE"), f.s, 7.5, H - 9.6 * MM, label, 1.4);
  if (head.number) end(head.number, f.b, 14, H - 15.9 * MM, strong);
  if (head.date) end(head.date, f.r, 8, H - 20.8 * MM, soft);
  // Zusatztext (Belegdesign): zwischen Logo und Belegart, höchstens zwei Zeilen
  const note = th.d.common.headerNote;
  if (note) {
    const from = logoEnd + 6 * MM, to = R - labelW - 6 * MM, cw = to - from;
    if (cw > 25 * MM) {
      const rows = wrap(note, f.r, 8, cw).slice(0, 2);
      rows.forEach((row, i) => {
        const w = f.r.widthOfTextAtSize(row, 8), cx = rtl ? W - (from + cw / 2) : from + cw / 2;
        f.r.draw(page, row, { x: cx - w / 2, y: H - BAND_TOP / 2 - 1 + (rows.length - 1) * 2.1 * MM - i * 4.2 * MM, size: 8, color: soft });
      });
    }
  }
}

/**
 * Fuß: Logo-Linie (gespiegelt), Dank + Seitenzahl, darunter alle Firmendaten in Spalten. Belegdesign: „band“ = Fläche in der
 * Hauptfarbe (bisher), „light“ = weiß mit Linie. Firma, Anschrift und Steuernummern bleiben immer (Pflichtangaben § 14 UStG);
 * Webseite, Bankverbindung und Seitenzahl sind abschaltbar, ein Zusatztext steht hinter dem Dank.
 */
export function drawFooterBand(page: PDFPage, f: Fonts, c: BandCompany, n: number, m: number, lb: FooterLabels, rtl = false, th: Theme = DEFAULT_THEME) {
  const L = 20 * MM, R = W - 20 * MM, CW = R - L, red = W * 0.28;
  const band = th.d.footer === "band", show = th.d.show;
  if (band) page.drawRectangle({ x: 0, y: 0, width: W, height: BAND_BOTTOM, color: th.brand });
  if (th.d.stripe) {
    page.drawRectangle({ x: rtl ? W - red : 0, y: BAND_BOTTOM, width: red, height: STRIPE, color: th.red });
    page.drawRectangle({ x: rtl ? 0 : red, y: BAND_BOTTOM, width: W - red, height: STRIPE, color: th.blue });
  } else if (!band) {
    page.drawLine({ start: { x: L, y: BAND_BOTTOM }, end: { x: R, y: BAND_BOTTOM }, thickness: 0.8, color: th.line });
  }
  const strong = band ? th.onBand : th.brandText, soft = band ? th.onBandSoft : th.soft;
  const body = band ? th.onBandLine : th.ink, rule = band ? th.onBandRule : th.line, heads = band ? th.onBandSoft : th.accentText;
  const put = (t: string, s: number, y: number, size: number, font: TFont, color: RGB, maxW = CW, spacing = 0) => {
    let sz = size;
    const w0 = spacedWidth(font, t, sz, spacing);
    if (w0 > maxW) sz = Math.max(5.2, (sz * maxW) / w0);
    const w = spacedWidth(font, t, sz, spacing);
    drawSpaced(page, font, t, { x: rtl ? R - s - w : L + s, y, size: sz, color, spacing });
    return w;
  };
  const website = show.website ? c.website : "";
  put([lb.thanks, website, th.d.common.footerNote].filter(Boolean).join("   |   "), 0, 24.4 * MM, 8, f.s, strong, CW - 30 * MM);
  if (show.pageNumbers) {
    const pg = lb.page.replace("{n}", String(n)).replace("{m}", String(m));
    put(pg, CW - f.r.widthOfTextAtSize(pg, 7), 24.4 * MM, 7, f.r, soft);
  }
  page.drawLine({ start: { x: L, y: 21.3 * MM }, end: { x: R, y: 21.3 * MM }, thickness: 0.4, color: rule });
  const cols = [
    { head: c.name, bold: true, lines: [c.street, [c.zip, c.city].filter(Boolean).join(" "), c.owner ? `${lb.owner}: ${c.owner}` : ""] },
    { head: lb.contact, lines: [c.phone ? `${lb.phone} ${c.phone}` : "", c.email, website] },
    { head: lb.bank, lines: show.bank ? [c.bankName, c.iban ? `IBAN ${formatIban(c.iban)}` : "", c.bic ? `BIC ${c.bic}` : ""] : [] },
    { head: lb.tax, lines: [c.vatId ? `USt-IdNr. ${c.vatId}` : "", c.taxNumber ? `St.-Nr. ${c.taxNumber}` : ""] },
  ].map((col) => ({ ...col, lines: col.lines.filter(Boolean) })).filter((col) => col.lines.length);
  const colW = CW / Math.max(1, cols.length);
  cols.forEach((col, i) => {
    const s = i * colW;
    if (col.bold) put(col.head, s, 17 * MM, 7.6, f.b, strong, colW - 3 * MM);
    else put(col.head.toLocaleUpperCase("de-DE"), s, 17 * MM, 6.2, f.s, heads, colW - 3 * MM, 0.9);
    col.lines.forEach((l, li) => put(l, s, 13.6 * MM - li * 3.3 * MM, 7, f.r, body, colW - 3 * MM));
  });
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  pages: PDFPage[] = [];
  constructor(public doc: PDFDocument, public f: Fonts, public company: typeof schema.companySettings.$inferSelect, public logo: { img: PDFImage; tile: boolean } | null, public head: BandHead, public th: Theme = DEFAULT_THEME) {}

  /** Schriftgröße bzw. Zeilenabstand nach Belegdesign (100 % = bisher) */
  z(n: number) { return n * this.th.k; }
  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.pageNo++;
    drawHeaderBand(this.page, this.f, this.logo, this.head, this.company.name, false, this.th);
    this.y = CONTENT_TOP;
  }
  text(t: string, x: number, y: number, size = 9, font = this.f.r, color: RGB = this.th.ink) {
    font.draw(this.page, t, { x, y, size, color });
  }
  right(t: string, xRight: number, y: number, size = 9, font = this.f.r, color: RGB = this.th.ink) {
    font.draw(this.page, t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, color });
  }
  ensure(space: number, onBreak?: () => void) {
    if (this.y - space < CONTENT_BOTTOM) { this.newPage(); onBreak?.(); }
  }
  footer() {
    this.pages.forEach((p, i) => drawFooterBand(p, this.f, this.company, i + 1, this.pages.length, { ...FOOTER_DE, thanks: this.th.d.common.thanks }, false, this.th));
  }
  /** Kleine gesperrte Überschrift in Großbuchstaben (z. B. „RECHNUNG AN“) */
  label(t: string, x: number, y: number, color: RGB = this.th.accentText, size = 6.5) {
    drawSpaced(this.page, this.f.s, t.toLocaleUpperCase("de-DE"), { x, y, size: this.z(size), color, spacing: 1.1 });
  }
  /** Infoblock rechts wie in den Vorlagen: Zeilen mit feiner Linie darunter; gibt die Höhe der letzten Zeile zurück */
  infoRows(rows: [string, string][], top: number) {
    const x0 = 118 * MM, x1 = W - 20 * MM;
    let y = top;
    for (const [k, v] of rows) {
      this.text(k, x0, y, this.z(8), this.f.r, this.th.soft);
      this.right(v, x1, y, this.z(8.5), this.f.s);
      this.page.drawLine({ start: { x: x0, y: y - this.z(2.3 * MM) }, end: { x: x1, y: y - this.z(2.3 * MM) }, thickness: 0.4, color: this.th.line });
      y -= this.z(6.3 * MM);
    }
    return y;
  }
  /** Titel mit kurzer Logo-Linie darunter (Größe und Linie nach Belegdesign) */
  title(t: string, y: number) {
    this.text(t, 20 * MM, y, this.th.d.titleSize, this.f.b, this.th.brandText);
    if (!this.th.d.stripe) return;
    const gap = (this.th.d.titleSize / 21) * 4.2 * MM;
    this.page.drawRectangle({ x: 20 * MM, y: y - gap, width: 13 * MM, height: 1.1 * MM, color: this.th.blue });
    this.page.drawRectangle({ x: 33 * MM, y: y - gap, width: 5 * MM, height: 1.1 * MM, color: this.th.red });
  }
  /** Tabellenkopf: Fläche in der Hauptfarbe mit runden Ecken (oder nur Linie), Spaltennamen gesperrt */
  tableHead(cols: { t: string; x: number; right?: boolean }[]) {
    const filled = this.th.d.tableHead === "filled", size = this.z(7);
    if (filled) roundRect(this.page, 20 * MM, this.y - this.z(2.7 * MM), W - 40 * MM, this.z(8.2 * MM), 1.6 * MM, this.th.brand);
    else this.page.drawLine({ start: { x: 20 * MM, y: this.y - this.z(2.7 * MM) }, end: { x: W - 20 * MM, y: this.y - this.z(2.7 * MM) }, thickness: 1, color: this.th.brand });
    for (const c of cols) {
      const t = c.t.toLocaleUpperCase("de-DE"), w = spacedWidth(this.f.s, t, size, 0.6);
      drawSpaced(this.page, this.f.s, t, { x: c.right ? c.x - w : c.x, y: this.y, size, color: filled ? this.th.onBrand : this.th.brandText, spacing: 0.6 });
    }
    this.y -= this.z(9 * MM);
  }
  /** Summe im farbigen Kasten (wie „Gesamtbetrag“ der Vorlagen) oder nur umrandet */
  totalBox(label: string, value: string, x0 = 112 * MM) {
    const filled = this.th.d.totalBox === "filled", fg = filled ? this.th.onAccent : this.th.brandText;
    roundRect(this.page, x0, this.y - this.z(3.6 * MM), W - 20 * MM - x0, this.z(10.5 * MM), 1.8 * MM, this.th.blue, filled ? undefined : 1.2);
    this.text(label, x0 + 4 * MM, this.y, this.z(10.5), this.f.b, fg);
    this.right(value, W - 24 * MM, this.y - this.z(0.3 * MM), this.z(12), this.f.b, fg);
    this.y -= this.z(14 * MM);
  }
  /** Hinweise-Kasten wie im Q-Design-Angebot: zarte Fläche, farbige Kante links */
  noteBox(heading: string, paras: string[]) {
    const width = W - 40 * MM - 10 * MM, size = this.z(8.5), step = this.z(4.1 * MM), gapH = this.z(1.4 * MM);
    const lines = paras.flatMap((p, i) => [...wrap(p, this.f.r, size, width).map((l) => ({ l, gap: false })), ...(i < paras.length - 1 ? [{ l: "", gap: true }] : [])]);
    const h = this.z(9 * MM) + lines.reduce((s, x) => s + (x.gap ? gapH : step), 0) + 2 * MM;
    this.ensure(h + 4 * MM);
    const top = this.y + 2 * MM;
    this.page.drawRectangle({ x: 20 * MM, y: top - h, width: W - 40 * MM, height: h, color: this.th.tint });
    this.page.drawRectangle({ x: 20 * MM, y: top - h, width: 1.2 * MM, height: h, color: this.th.blue });
    let y = top - this.z(6 * MM);
    this.text(heading, 26 * MM, y, this.z(9.5), this.f.b, this.th.brandText);
    y -= this.z(5.6 * MM);
    for (const x of lines) { if (!x.gap) this.text(x.l, 26 * MM, y, size, this.f.r, this.th.ink); y -= x.gap ? gapH : step; }
    this.y = top - h - 6 * MM;
  }
  /** Unterschriftenzeilen (z. B. Auftragserteilung im Angebot) */
  signLines(heading: string, left: string, rightText: string) {
    this.ensure(26 * MM);
    this.text(heading, 20 * MM, this.y, this.z(9), this.f.b, this.th.brandText);
    this.y -= 15 * MM;
    this.page.drawLine({ start: { x: 20 * MM, y: this.y }, end: { x: 98 * MM, y: this.y }, thickness: 0.6, color: this.th.soft });
    this.page.drawLine({ start: { x: 112 * MM, y: this.y }, end: { x: W - 20 * MM, y: this.y }, thickness: 0.6, color: this.th.soft });
    this.text(left, 20 * MM, this.y - this.z(4 * MM), this.z(7.5), this.f.r, this.th.soft);
    this.text(rightText, 112 * MM, this.y - this.z(4 * MM), this.z(7.5), this.f.r, this.th.soft);
    this.y -= 12 * MM;
  }
}

/** Zahlungsinformationen mit EPC-QR („Scannen & bezahlen“) – nur wenn noch etwas offen ist und die IBAN bekannt ist */
function paymentBox(w: Writer, o: { amountCents: number; reference: string }) {
  const c = w.company;
  if (!c.iban || o.amountCents <= 0) return;
  // Entwurf: kein QR-Code (sonst könnte jemand mit „ENTWURF“ als Verwendungszweck überweisen)
  const payload = o.reference === "ENTWURF" ? null : epcPayload({ name: c.name, iban: c.iban, bic: c.bic, amountCents: o.amountCents, text: o.reference });
  const rows: [string, string][] = [["Empfänger", c.name], ["Bank", c.bankName], ["IBAN", formatIban(c.iban)], ["BIC", c.bic], ["Betrag", formatCents(o.amountCents)], ["Verwendungszweck", o.reference]].filter(([, v]) => v) as [string, string][];
  const step = w.z(4.6 * MM);
  const h = Math.max(rows.length * step + w.z(13 * MM), payload ? 38 * MM : 0);
  w.ensure(h + 4 * MM);
  const top = w.y + 2 * MM;
  roundRect(w.page, 20 * MM, top - h, W - 40 * MM, h, 2 * MM, w.th.tint);
  let y = top - w.z(7 * MM);
  w.text("Zahlungsinformationen", 25 * MM, y, w.z(10), w.f.b, w.th.accentText);
  y -= w.z(6.2 * MM);
  for (const [k, v] of rows) {
    w.text(k, 25 * MM, y, w.z(8), w.f.r, w.th.soft);
    w.text(v, 25 * MM + w.z(33 * MM), y, w.z(8.5), k === "IBAN" || k === "Betrag" || k === "Verwendungszweck" ? w.f.b : w.f.r);
    y -= step;
  }
  if (payload) {
    const m = qrModules(payload), size = 27 * MM, unit = size / m.length;
    const qx = W - 25 * MM - size, qy = top - 4.5 * MM; // oben rechts im Kasten
    w.page.drawRectangle({ x: qx - 1.5 * MM, y: qy - size - 1.5 * MM, width: size + 3 * MM, height: size + 3 * MM, color: WHITE });
    w.page.drawSvgPath(modulesPath(m), { x: qx, y: qy, scale: unit, color: rgb(0, 0, 0) });
    const cap = "Scannen & bezahlen";
    w.text(cap, qx + size / 2 - w.f.r.widthOfTextAtSize(cap, 6.5) / 2, qy - size - 4.6 * MM, 6.5, w.f.r, w.th.soft);
  }
  w.y = top - h - 7 * MM;
}

/** Logo aus den Einstellungen, sonst das Firmenlogo aus assets/logo.jpg */
export async function embedLogo(doc: PDFDocument, fileId: string | null) {
  if (fileId) {
    const file = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, fileId) });
    if (file?.mime === "image/png") return doc.embedPng(file.data);
    if (file?.mime === "image/jpeg") return doc.embedJpg(file.data);
  }
  const fallback = path.join(process.cwd(), "assets", "logo.jpg");
  return fs.existsSync(fallback) ? doc.embedJpg(fs.readFileSync(fallback)) : null;
}

/** Produktfoto als kleines JPEG fürs Angebot (wie im Q-Design-Angebot); ohne Foto oder ohne sharp → null */
async function embedThumbs(doc: PDFDocument, ids: (string | null | undefined)[]): Promise<Map<string, PDFImage>> {
  const out = new Map<string, PDFImage>();
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return out;
  let sharp: (typeof import("sharp"))["default"];
  try { sharp = (await import("sharp")).default; } catch { return out; }
  for (const id of want) {
    try {
      const file = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, id) });
      if (!file || !/^image\//.test(file.mime)) continue;
      const jpg = await sharp(Buffer.from(file.data)).rotate().resize(240, 240, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
      out.set(id, await doc.embedJpg(jpg));
    } catch { /* Foto kaputt → ohne Bild */ }
  }
  return out;
}

export type RenderOpts = { xml?: string; /** Vorschau im Belegdesign: dieses Design statt des gespeicherten */ design?: DocDesign };

export async function renderPdf(d: DocData, opts: RenderOpts = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const company = (await db.query.companySettings.findFirst()) ?? ({ name: "", street: "", zip: "", city: "", country: "DE", owner: "", email: "", phone: "", website: "", vatId: "", taxNumber: "", bankName: "", iban: "", bic: "", logoFileId: null, invoiceFooter: "", defaultPaymentDays: 14, offerValidityDays: 14, id: "company", updatedAt: new Date(), docDesign: {} } as unknown as typeof schema.companySettings.$inferSelect);
  // Belegdesign: Farben, Kopf/Fuß, Schriftgröße, Texte, was angezeigt wird (Standard = bisheriges Aussehen)
  const design = opts.design ?? designOf(company);
  const th = makeTheme(design), T = design.texts[d.kind], C = design.common, show = design.show;
  const z = (n: number) => n * th.k;
  doc.setTitle(`${T.title} ${d.number}`);
  doc.setLanguage("de-DE");
  doc.setAuthor(company.name);
  doc.setCreator("Star Style");
  const f = await fonts(doc, hasArabic(JSON.stringify(d) + JSON.stringify(company) + JSON.stringify(T) + JSON.stringify(C)));
  const w = new Writer(doc, f, company, await embedBandLogo(doc, company?.logoFileId ?? null, th),
    { label: T.title, number: d.kind === "delivery" && d.number === "ENTWURF" ? "" : d.number, date: formatDate(d.date) }, th);
  w.newPage();
  const L = 20 * MM, R = W - 20 * MM;
  const fillText = (s: string) => fillPlaceholders(s, { number: d.number, date: formatDate(d.date), customer: d.buyer.name, ref: d.refNumber ?? "", valid: d.validUntil ? formatDate(d.validUntil) : "" });
  const paragraph = (s: string, size = 9.5) => { for (const l of wrap(fillText(s), f.r, z(size), R - L)) { w.ensure(z(6 * MM)); w.text(l, L, w.y, z(size)); w.y -= z(5 * MM); } };

  // Absenderzeile + Anschrift (Fensterumschlag), darüber „RECHNUNG AN“ wie in den Vorlagen
  if (show.senderLine) {
    const sender = [company.name, company.street, [company.zip, company.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    w.text(sender, L, H - 45 * MM, z(7), f.r, th.soft);
    w.page.drawLine({ start: { x: L, y: H - 46 * MM }, end: { x: 105 * MM, y: H - 46 * MM }, thickness: 0.4, color: th.line });
  }
  if (T.to) w.label(T.to, L, H - 51 * MM);
  const addr = [d.buyer.name, d.buyer.street, [d.buyer.zip, d.buyer.city].filter(Boolean).join(" "), countryName(d.buyer.country)].filter(Boolean);
  addr.forEach((l, i) => w.text(l, L, H - 56.5 * MM - i * z(4.9 * MM), z(i === 0 ? 10.5 : 10), i === 0 ? f.s : f.r));

  // Infoblock rechts: Zeilen mit feiner Linie (Pflichtangaben – im Belegdesign nicht abschaltbar)
  const info: [string, string][] = [];
  const label = d.kind === "offer" ? "Angebotsnr." : d.kind === "delivery" ? "Zu Rechnung" : d.kind === "cancellation" ? "Storno-Nr." : "Rechnungsnr.";
  info.push([label, d.number]);
  info.push([d.kind === "offer" ? "Angebotsdatum" : d.kind === "invoice" ? "Rechnungsdatum" : "Datum", formatDate(d.date)]);
  if (d.refNumber) info.push([d.kind === "cancellation" ? "Storno zu" : "Ersetzt", d.refNumber]);
  if (d.deliveryDate && d.kind !== "offer") info.push(["Lieferdatum", formatDate(d.deliveryDate)]);
  if (d.validUntil) info.push(["Gültig bis", formatDate(d.validUntil)]);
  info.push(["Kundennr.", String(d.customerNo)]);
  if (d.buyer.vatId) info.push(["USt-IdNr. Kunde", d.buyer.vatId]);
  if (d.dueDate && d.kind === "invoice") info.push(["Fällig am", formatDate(d.dueDate)]);
  const infoEnd = w.infoRows(info, H - 48 * MM);

  // Titel mit Logo-Linie
  w.y = Math.min(H - 97 * MM, infoEnd - 8 * MM, H - 56.5 * MM - addr.length * z(4.9 * MM) - 12 * MM);
  w.title(`${T.title} ${d.kind === "delivery" ? "" : d.number}`.trim(), w.y);
  w.y -= (design.titleSize / 21) * 12.5 * MM;
  if (T.greeting) { w.text(fillText(T.greeting), L, w.y, z(9.5)); w.y -= z(5 * MM); }
  if (T.intro) paragraph(T.intro);
  w.y -= z(4.5 * MM);

  // Tabelle: Kopf in der Hauptfarbe, Zeilen mit feiner Linie, Kategorie klein über dem Artikel (wie im Q-Design-Angebot)
  const priced = d.kind !== "delivery";
  // Rabatt-Spalte: immer (Standard) oder nur, wenn es Rabatt gibt – gibt es Rabatt, steht sie immer da (§ 14 Abs. 4 Nr. 7 UStG)
  const hasDiscount = d.lines.some((l) => l.discountBp);
  const discCol = priced && (show.discountColumn || hasDiscount);
  const posCol = show.posColumn;
  // Spalten (rechte Kanten): Menge, Einzelpreis, Rabatt, Gesamt – so breit, dass die gesperrten Überschriften nicht ineinanderlaufen
  const X = { pos: L + 2 * MM, desc: posCol ? L + 11 * MM : L + 2 * MM, qtyR: priced ? 124 * MM : 160 * MM, price: discCol ? 147 * MM : 160 * MM, disc: 160 * MM, total: R - 2.5 * MM };
  const descW = ((priced ? 83 : 110) + (posCol ? 0 : 9)) * MM;
  const head = () => w.tableHead([
    ...(posCol ? [{ t: "Pos.", x: X.pos }] : []),
    ...(priced
      ? [{ t: C.colItem, x: X.desc }, { t: C.colQty, x: X.qtyR, right: true }, { t: d.pricesGross ? C.colPriceGross : C.colPrice, x: X.price, right: true },
        ...(discCol ? [{ t: C.colDiscount, x: X.disc, right: true }] : []), { t: d.pricesGross ? C.colTotalGross : C.colTotal, x: X.total, right: true }]
      : [{ t: `Art.-Nr. · ${C.colItem}`, x: X.desc }, { t: C.colQty, x: X.qtyR, right: true }, { t: "Geladen", x: X.total, right: true }]),
  ]);
  head();
  // Angebot: Produktfoto je Position (Vorlage Q-Design); Rechnung bleibt ohne Bilder (Archiv klein, Standard)
  const thumbs = d.kind === "offer" && show.photos ? await embedThumbs(doc, d.lines.map((l) => l.imageFileId)) : new Map<string, PDFImage>();
  const TH = 14 * MM; // Bildfeld; gibt es Fotos, rücken alle Zeilen ein (gleiche Textkante)
  d.lines.forEach((l) => {
    // Art.-Nr. = Barcode (Regel seit 03.11.2026): je Position genau eine Nummer – der Barcode der gelieferten Größe/Farbe
    // (beim Verladen scanbar), ohne Barcode die Art.-Nr.
    const no = l.ean || l.sku;
    const title = priced ? l.description : `${no ? no + " · " : ""}${l.description}`;
    // Ladeliste: Gewicht je Stück und zusammen (Versand)
    const sub = priced ? (show.itemCode ? no : "") : l.weightGrams ? `Gewicht: je ${formatWeight(l.weightGrams)} · zus. ${formatWeight(l.weightGrams * Math.abs(l.qty))}` : "";
    const cat = show.category ? (l.category ?? "").trim() : "";
    const img = l.imageFileId ? thumbs.get(l.imageFileId) : undefined;
    const tx = thumbs.size ? X.desc + TH + 3 * MM : X.desc, tw = thumbs.size ? descW - TH - 3 * MM : descW;
    const rows = wrap(title, f.s, z(9), tw);
    const textH = (cat ? z(3.9 * MM) : 0) + rows.length * z(4.4 * MM) + (sub ? z(3.8 * MM) : 0);
    const h = Math.max(textH, img ? TH + 1.5 * MM : 0) + 3.2 * MM;
    w.ensure(h, head);
    let y = w.y;
    if (img) {
      const sc = Math.min(TH / img.width, TH / img.height), iw = img.width * sc, ih = img.height * sc;
      w.page.drawRectangle({ x: X.desc, y: w.y + 3 * MM - TH - 0.5 * MM, width: TH, height: TH, color: th.tint });
      w.page.drawImage(img, { x: X.desc + (TH - iw) / 2, y: w.y + 3 * MM - 0.5 * MM - TH + (TH - ih) / 2, width: iw, height: ih });
    }
    if (cat) { drawSpaced(w.page, f.s, cat.toLocaleUpperCase("de-DE"), { x: tx, y, size: z(6), color: th.accentText, spacing: 0.7 }); y -= z(3.9 * MM); }
    const first = y;
    rows.forEach((r) => { w.text(r, tx, y, z(9), f.s); y -= z(4.4 * MM); });
    if (sub) { w.text(sub, tx, y + 0.5 * MM, z(7.5), f.r, th.soft); y -= z(3.8 * MM); }
    if (img) y = Math.min(y, w.y - TH + 1.4 * MM);
    if (posCol) w.text(String(l.position), X.pos, first, z(9), f.r, th.soft);
    w.right(String(Math.abs(l.qty)), X.qtyR, first, z(9));
    if (priced) {
      w.right(formatCents(l.unitPriceCents), X.price, first, z(9));
      if (discCol) w.right(l.discountBp ? `${bpToPercent(l.discountBp)} %` : "", X.disc, first, z(9), f.r, th.soft);
      w.right(formatCents(d.pricesGross ? l.netCents + (l.vatCents ?? 0) : l.netCents), X.total, first, z(9), f.b);
    } else {
      w.page.drawRectangle({ x: X.total - 4 * MM, y: first - 1 * MM, width: 4 * MM, height: 4 * MM, borderColor: th.ink, borderWidth: 0.7 });
    }
    w.page.drawLine({ start: { x: L, y: y + 1.6 * MM }, end: { x: R, y: y + 1.6 * MM }, thickness: 0.4, color: th.line });
    w.y = y - 3.2 * MM + 1.6 * MM;
  });
  w.y -= 2 * MM;

  // Ladeliste: Gesamtmenge zum Gegenprüfen beim Verladen
  if (!priced) {
    const total = d.lines.reduce((sum, l) => sum + Math.abs(l.qty), 0);
    w.ensure(z(8 * MM));
    w.y -= 2.5 * MM;
    w.text(`Gesamtmenge (${d.lines.length} ${d.lines.length === 1 ? "Position" : "Positionen"})`, X.desc, w.y, z(9), f.s);
    w.right(String(total), X.qtyR, w.y, z(9.5), f.b);
    w.y -= z(6 * MM);
    // Gesamtgewicht der Sendung (Positionen ohne Gewicht werden genannt)
    const sw = shipmentWeight(d.lines.map((l) => ({ qty: l.qty, weightGrams: l.weightGrams ?? null })));
    if (sw.grams > 0) {
      w.ensure(z(6 * MM));
      w.text(`Gesamtgewicht${sw.missing ? ` (ohne ${sw.missing} ${sw.missing === 1 ? "Position" : "Positionen"} ohne Gewicht)` : ""}`, X.desc, w.y, z(9), f.s);
      w.right(`ca. ${formatWeight(sw.grams)}`, X.qtyR, w.y, z(9.5), f.b);
      w.y -= z(6 * MM);
    }
  }

  // Summen: Zeilen mit feiner Linie, Gesamtbetrag im farbigen Kasten (Pflichtangaben – nur das Aussehen ist einstellbar)
  if (priced) {
    const rows: [string, string][] = [];
    if (d.discountCents) {
      rows.push(["Zwischensumme", formatCents(d.subtotalCents)]);
      rows.push([`Rabatt ${bpToPercent(d.discountBp)} %`, `- ${formatCents(Math.abs(d.discountCents))}`]);
    }
    rows.push(["Nettobetrag", formatCents(d.netCents)]);
    for (const g of d.vatBreakdown) rows.push([`USt. ${bpToPercent(g.rateBp)} % auf ${formatCents(g.netCents)}`, formatCents(g.vatCents)]);
    w.ensure(rows.length * z(6 * MM) + z(18 * MM));
    w.y -= 2 * MM;
    for (const [k, v] of rows) {
      w.text(k, 114 * MM, w.y, z(8.5), f.r, th.soft);
      w.right(v, R - 2.5 * MM, w.y, z(9));
      w.page.drawLine({ start: { x: 112 * MM, y: w.y - z(2.2 * MM) }, end: { x: R, y: w.y - z(2.2 * MM) }, thickness: 0.4, color: th.line });
      w.y -= z(6 * MM);
    }
    w.y -= 2.5 * MM;
    w.totalBox(T.total, formatCents(d.grossCents));
  }

  // Hinweise (Zahlung, Steuer, eigene Notizen) im Kasten wie im Q-Design-Angebot
  const notes: string[] = [];
  let open = 0;
  if (d.kind === "invoice") {
    const got = (d.received ?? []).reduce((s, p) => s + p.amountCents, 0);
    const rest = d.grossCents - got;
    open = rest;
    if (got > 0) {
      const how = [...new Set((d.received ?? []).map((p) => METHOD_DE[p.method] ?? ""))].filter(Boolean).join(" / ");
      notes.push(rest <= 0 ? `Betrag ${how} dankend erhalten. Die Rechnung ist bezahlt.` : `Bereits ${how} erhalten: ${formatCents(got)}. Noch offen: ${formatCents(rest)}.`);
    }
    const plan = d.installments ?? [];
    if (rest > 0 && plan.length > 1) {
      let pool = got;
      const openRates = plan.map((r) => { const paid = Math.min(pool, r.amountCents); pool -= paid; return { ...r, open: r.amountCents - paid }; }).filter((r) => r.open > 0);
      notes.push(`Ratenzahlung vereinbart: ${openRates.map((r, i) => `${i + 1}. Rate ${formatCents(r.open)} fällig am ${formatDate(r.dueDate)}`).join("; ")}.`);
    } else if (rest > 0 && d.dueDate) notes.push(`Bitte überweisen Sie den Betrag ohne Abzug bis zum ${formatDate(d.dueDate)} unter Angabe der Rechnungsnummer ${d.number}.`);
    if (d.deliveryDate === d.date) notes.push("Das Lieferdatum entspricht dem Rechnungsdatum.");
    if (d.pricesGross) notes.push("Alle Preise inklusive der ausgewiesenen Umsatzsteuer.");
  }
  if (d.kind === "offer" && d.validUntil) notes.push(`Dieses Angebot ist gültig bis ${formatDate(d.validUntil)}. Die Ware ist bis dahin für Sie reserviert.`);
  if (d.kind !== "delivery") notes.push(...legalNotes(d.taxMode, { ossCountry: d.ossCountry, retentionOfTitle: d.kind === "invoice" && d.retentionOfTitle }));
  if (d.notes) notes.push(d.notes);
  if (company.invoiceFooter && d.kind !== "delivery") notes.push(company.invoiceFooter);
  if (notes.length) w.noteBox(C.notesTitle, notes);

  // Zahlungsinformationen mit QR-Code (Banking-App: „Scannen & bezahlen“) – im Belegdesign abschaltbar
  if (d.kind === "invoice" && open > 0 && show.paymentQr) paymentBox(w, { amountCents: open, reference: d.number });

  // eigener Schlusstext (Belegdesign), z. B. Lieferbedingungen oder ein persönlicher Satz
  if (T.closing) { w.y -= 2 * MM; paragraph(T.closing); w.y -= z(2 * MM); }

  if (d.kind === "delivery") {
    w.ensure(30 * MM);
    w.y -= 10 * MM;
    const boxes = ["Verladen und geprüft von (Name, Unterschrift)", "Ware vollständig erhalten – Kunde / Fahrer"];
    boxes.forEach((b, i) => {
      const x = L + i * 92 * MM;
      w.page.drawLine({ start: { x, y: w.y }, end: { x: x + 78 * MM, y: w.y }, thickness: 0.6, color: th.ink });
      w.text(b, x, w.y - 4 * MM, z(7.5), f.r, th.soft);
    });
    w.y -= 12 * MM;
    w.text("Datum: ____________________", L, w.y, z(9));
  } else if (T.signoff) {
    w.ensure(z(12 * MM));
    w.y -= 2 * MM;
    w.text(fillText(T.signoff), L, w.y, z(9.5)); w.y -= z(5 * MM);
    w.text(company.name, L, w.y, z(9.5), f.s);
  }
  // Angebot: Auftragserteilung durch den Kunden (wie im Q-Design-Angebot)
  if (d.kind === "offer" && show.signature) { w.y -= 12 * MM; w.signLines("Auftragserteilung", "Ort, Datum", "Unterschrift / Firmenstempel"); }

  w.footer();

  if (opts.xml) {
    await doc.attach(Buffer.from(opts.xml, "utf8"), "factur-x.xml", {
      mimeType: "text/xml", description: "Factur-X/ZUGFeRD Rechnungsdaten (EN 16931)",
      creationDate: new Date(), modificationDate: new Date(), afRelationship: AFRelationship.Alternative,
    });
    setFacturXMetadata(doc, `${T.title} ${d.number}`, company.name);
  }
  return doc.save();
}

/** XMP-Metadaten, damit Lesegeräte die eingebettete ZUGFeRD-Datei erkennen. */
function setFacturXMetadata(doc: PDFDocument, title: string, author: string) {
  const now = new Date().toISOString();
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description>
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title><dc:creator><rdf:Seq><rdf:li>${author}</rdf:li></rdf:Seq></dc:creator></rdf:Description>
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:CreateDate>${now}</xmp:CreateDate><xmp:ModifyDate>${now}</xmp:ModifyDate><xmp:CreatorTool>Star Style</xmp:CreatorTool></rdf:Description>
<rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"><fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>factur-x.xml</fx:DocumentFileName><fx:Version>1.0</fx:Version><fx:ConformanceLevel>EN 16931</fx:ConformanceLevel></rdf:Description>
</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const stream = doc.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream));
}

// ───────────────────────── Daten laden ─────────────────────────

async function linesWithProducts(lines: { position: number; variantId: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; netCents?: number; vatRateBp: number; vatCents?: number; photoFileId?: string | null }[]) {
  const out: Line[] = [];
  for (const l of lines.sort((a, b) => a.position - b.position)) {
    // Artikel von Hand (Angebot aus dem Bestell-Link): sein Foto
    let sku = "", ean: string | null = null, weightGrams: number | null = null, category = "", imageFileId: string | null = l.variantId ? null : l.photoFileId ?? null;
    if (l.variantId) {
      const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, l.variantId), with: { product: true } });
      sku = v?.product.sku ?? ""; ean = v?.barcode ?? null; weightGrams = v?.weightGrams ?? null; category = v?.product.category ?? ""; imageFileId = v?.imageFileId ?? v?.product.imageFileId ?? null;
    }
    const raw = l.qty * l.unitPriceCents;
    out.push({ position: l.position, sku, ean, category, imageFileId, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, netCents: l.netCents ?? raw - Math.round((raw * l.discountBp) / 10000), vatRateBp: l.vatRateBp, vatCents: l.vatCents, weightGrams });
  }
  return out;
}

export async function invoicePdf(invoiceId: string, variant: "invoice" | "delivery" = "invoice") {
  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { lines: true, customer: true, installments: true, payments: true } });
  if (!inv) throw new Error("notFound");
  const isDraft = inv.status === "DRAFT";
  const ref = inv.cancelsInvoiceId
    ? (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.cancelsInvoiceId) }))?.number ?? null
    : inv.replacesInvoiceId ? (await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.replacesInvoiceId) }))?.number ?? null : null;
  const c = inv.customer;
  const buyer = isDraft
    ? { name: c.name, street: c.street, zip: c.zip, city: c.city, country: c.country, vatId: c.vatId }
    : { name: inv.custName, street: inv.custStreet, zip: inv.custZip, city: inv.custCity, country: inv.custCountry, vatId: inv.custVatId };
  const kind: DocKind = variant === "delivery" ? "delivery" : inv.kind === "CANCELLATION" ? "cancellation" : "invoice";
  const date = inv.issueDate ?? new Date().toISOString().slice(0, 10);
  const data: DocData = {
    kind, number: inv.number ?? "ENTWURF", date, deliveryDate: inv.deliveryDate ?? date, dueDate: inv.dueDate, validUntil: null,
    customerNo: c.number, customerId: c.id, buyer, lines: await linesWithProducts(inv.lines),
    subtotalCents: inv.subtotalCents, discountCents: inv.discountCents, discountBp: inv.discountBp, netCents: inv.netCents, vatCents: inv.vatCents,
    grossCents: inv.grossCents, vatBreakdown: inv.vatBreakdown, taxMode: inv.taxMode, ossCountry: inv.ossCountry,
    retentionOfTitle: inv.retentionOfTitle, notes: inv.notes, refNumber: ref,
    installments: [...inv.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    pricesGross: inv.pricesGross,
    // Entwurf: geplante Zahlung bei Ausstellung; ausgestellt: Zahlungen bis zum Rechnungsdatum (PDF wird beim ersten Abruf archiviert)
    received: isDraft
      ? (inv.initialPaymentCents > 0 ? [{ amountCents: inv.initialPaymentCents, method: inv.initialPaymentMethod ?? "CASH" }] : [])
      : inv.payments.filter((p) => !p.cancelledAt && p.date <= date).map((p) => ({ amountCents: p.amountCents, method: p.method })),
  };
  if (kind === "delivery" || isDraft) return renderPdf(data);
  const company = await db.query.companySettings.findFirst();
  const xml = buildCiiXml({
    number: data.number, typeCode: kind === "cancellation" ? "381" : "380", issueDate: date, deliveryDate: data.deliveryDate!, dueDate: inv.dueDate,
    notes: legalNotes(inv.taxMode, { ossCountry: inv.ossCountry, retentionOfTitle: inv.retentionOfTitle && kind === "invoice" }),
    seller: { name: company?.name ?? "", street: company?.street ?? "", zip: company?.zip ?? "", city: company?.city ?? "", country: company?.country ?? "DE", vatId: company?.vatId ?? "", taxNumber: company?.taxNumber ?? "", email: company?.email ?? "", iban: company?.iban ?? "", bic: company?.bic ?? "", bankName: company?.bankName ?? "" },
    buyer: { id: String(c.number), ...buyer },
    taxMode: inv.taxMode, lines: data.lines.map((l) => ({ position: l.position, name: l.description, sku: l.sku, ean: l.ean, qty: l.qty, unitPriceCents: l.unitPriceCents, netCents: l.netCents, vatRateBp: l.vatRateBp,
      netUnitPrice: inv.pricesGross && l.qty ? (Math.abs(l.netCents) / Math.abs(l.qty) / 100).toFixed(4) : undefined })),
    vatBreakdown: inv.vatBreakdown, netCents: inv.netCents, vatCents: inv.vatCents, grossCents: inv.grossCents,
    paymentTermsText: inv.dueDate ? `Zahlbar bis ${formatDate(inv.dueDate)} ohne Abzug.` : "Sofort fällig.",
  });
  return renderPdf(data, { xml });
}

/** Ausgestellte Rechnungen werden einmalig als PDF archiviert und danach immer unverändert ausgeliefert. */
export async function archivedInvoicePdf(invoiceId: string): Promise<Uint8Array> {
  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
  if (!inv) throw new Error("notFound");
  if (inv.status === "DRAFT") return invoicePdf(invoiceId);
  if (inv.pdfFileId) {
    const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, inv.pdfFileId) });
    if (f) return new Uint8Array(f.data);
  }
  const bytes = await invoicePdf(invoiceId);
  const buf = Buffer.from(bytes);
  await db.transaction(async (tx) => {
    const again = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId) });
    if (again?.pdfFileId) return;
    const [file] = await tx.insert(schema.storedFiles).values({
      name: `${inv.number}.pdf`, mime: "application/pdf", size: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
    }).returning({ id: schema.storedFiles.id });
    await tx.update(schema.invoices).set({ pdfFileId: file.id }).where(eq(schema.invoices.id, invoiceId));
  });
  return bytes;
}

export async function offerPdf(offerId: string) {
  const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, offerId), with: { lines: true, customer: true } });
  if (!o) throw new Error("notFound");
  const { computeTotals } = await import("./tax");
  const t = computeTotals(o.lines.sort((a, b) => a.position - b.position), o.discountBp);
  const c = o.customer;
  const { determineTaxMode } = await import("./tax");
  return renderPdf({
    kind: "offer", number: o.number, date: o.date, deliveryDate: null, dueDate: null, validUntil: o.validUntil,
    customerNo: c.number, customerId: c.id, buyer: { name: c.name, street: c.street, zip: c.zip, city: c.city, country: c.country, vatId: c.vatId },
    lines: (await linesWithProducts(o.lines)).map((l, i) => ({ ...l, netCents: t.lines[i].netCents })),
    subtotalCents: t.subtotalCents, discountCents: t.discountCents, discountBp: o.discountBp, netCents: t.netCents, vatCents: t.vatCents,
    grossCents: t.grossCents, vatBreakdown: t.vatByRate, taxMode: determineTaxMode(c), ossCountry: null,
    retentionOfTitle: false, notes: o.notes, refNumber: null,
  });
}

// ───────────────────────── Briefe: Quittung, Mahnung ─────────────────────────

export type Letter = {
  title: string; buyer: Party; info: [string, string][]; paragraphs: string[];
  /** Kopfband: Belegart, Nummer, Datum */
  head: BandHead;
  table?: { head: string[]; rows: string[][]; widths: number[] }; total?: [string, string]; afterTable?: string[]; signature?: boolean;
};

async function companyAndLogo(doc: PDFDocument, design?: DocDesign) {
  const company = (await db.query.companySettings.findFirst()) as typeof schema.companySettings.$inferSelect;
  const th = makeTheme(design ?? designOf(company));
  const logo = await embedBandLogo(doc, company?.logoFileId ?? null, th);
  return { company, logo, th };
}

export async function renderLetter(l: Letter, opts: { design?: DocDesign } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(l.title); doc.setLanguage("de-DE"); doc.setCreator("Star Style");
  const { company, logo, th } = await companyAndLogo(doc, opts.design);
  const f = await fonts(doc, hasArabic(JSON.stringify(l) + JSON.stringify(company) + JSON.stringify(th.d.common)));
  const w = new Writer(doc, f, company, logo, l.head, th);
  const z = (n: number) => w.z(n);
  w.newPage();
  const L = 20 * MM, R = W - 20 * MM;
  if (th.d.show.senderLine) {
    const sender = [company.name, company.street, [company.zip, company.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
    w.text(sender, L, H - 45 * MM, z(7), f.r, th.soft);
    w.page.drawLine({ start: { x: L, y: H - 46 * MM }, end: { x: 105 * MM, y: H - 46 * MM }, thickness: 0.4, color: th.line });
  }
  w.label("An", L, H - 51 * MM);
  const addr = [l.buyer.name, l.buyer.street, [l.buyer.zip, l.buyer.city].filter(Boolean).join(" "), countryName(l.buyer.country)].filter(Boolean);
  addr.forEach((s, i) => w.text(s, L, H - 56.5 * MM - i * z(4.9 * MM), z(i === 0 ? 10.5 : 10), i === 0 ? f.s : f.r));
  const infoEnd = w.infoRows(l.info, H - 48 * MM);
  w.y = Math.min(H - 97 * MM, infoEnd - 8 * MM, H - 56.5 * MM - addr.length * z(4.9 * MM) - 12 * MM);
  w.title(l.title, w.y); w.y -= (th.d.titleSize / 21) * 12.5 * MM;
  const para = (s: string, size = 9.5) => { for (const r of wrap(s, f.r, z(size), R - L)) { w.ensure(z(6 * MM)); w.text(r, L, w.y, z(size)); w.y -= z(4.8 * MM); } w.y -= 2.5 * MM; };
  l.paragraphs.forEach((p) => para(p));
  if (l.table) {
    const { head, rows, widths } = l.table;
    const xs: number[] = []; let x = L; for (const wd of widths) { x += wd * MM; xs.push(x); }
    const drawHead = () => w.tableHead(head.map((h, i) => (i === 0 ? { t: h, x: L + 2 * MM } : { t: h, x: xs[i] - 2.5 * MM, right: true })));
    w.y -= 2 * MM; drawHead();
    rows.forEach((r) => {
      w.ensure(z(7 * MM), drawHead);
      r.forEach((cell, i) => (i === 0 ? w.text(cell, L + 2 * MM, w.y, z(9)) : w.right(cell, xs[i] - 2.5 * MM, w.y, z(9), f.s)));
      w.page.drawLine({ start: { x: L, y: w.y - z(2.4 * MM) }, end: { x: R, y: w.y - z(2.4 * MM) }, thickness: 0.4, color: th.line });
      w.y -= z(6.6 * MM);
    });
  }
  if (l.total) { w.ensure(z(16 * MM)); w.y -= 3 * MM; w.totalBox(l.total[0], l.total[1]); }
  (l.afterTable ?? []).forEach((p) => para(p, 9));
  w.ensure(28 * MM); w.y -= 2 * MM;
  w.text("Mit freundlichen Grüßen", L, w.y, z(9.5)); w.y -= z(5 * MM);
  w.text(company.name, L, w.y, z(9.5), f.s);
  if (l.signature) {
    w.y -= 16 * MM;
    w.page.drawLine({ start: { x: L, y: w.y }, end: { x: 90 * MM, y: w.y }, thickness: 0.6, color: th.soft });
    w.text("Unterschrift Empfänger der Zahlung", L, w.y - z(4 * MM), z(7.5), f.r, th.soft);
  }
  w.footer();
  return doc.save();
}

const invBuyer = (inv: typeof schema.invoices.$inferSelect): Party => ({ name: inv.custName, street: inv.custStreet, zip: inv.custZip, city: inv.custCity, country: inv.custCountry, vatId: inv.custVatId });

export async function receiptPdf(paymentId: string) {
  const p = await db.query.payments.findFirst({ where: eq(schema.payments.id, paymentId), with: { invoice: { with: { customer: true, payments: true } } } });
  if (!p) throw new Error("notFound");
  const inv = p.invoice;
  const before = inv.payments.filter((x) => !x.cancelledAt && x.id !== p.id && (x.date < p.date || (x.date === p.date && x.number < p.number))).reduce((s, x) => s + x.amountCents, 0);
  const rest = inv.grossCents - before - p.amountCents;
  if (p.amountCents < 0) {
    // Erstattung an den Kunden (Retoure): Auszahlungsbeleg, bei Barauszahlung mit Unterschrift des Kunden.
    // Ganz zurückgegeben (Rechnung storniert) → zu zahlen ist 0, alles Bezahlte war Guthaben.
    const amt = formatCents(-p.amountCents);
    const due = inv.status === "CANCELLED" ? 0 : inv.grossCents;
    const left = due - before - p.amountCents;
    return renderLetter({
      title: p.cancelledAt ? `Erstattung ${p.number} – STORNIERT` : `Erstattung ${p.number}`,
      head: { label: p.cancelledAt ? "Erstattung – storniert" : "Erstattung", number: p.number, date: formatDate(p.date) },
      buyer: invBuyer(inv),
      info: [["Beleg-Nr.", p.number], ["Datum", formatDate(p.date)], ["Zu Rechnung", inv.number ?? ""], ["Kundennr.", String(inv.customer.number)]],
      paragraphs: [`Wir haben Ihnen am ${formatDate(p.date)} ${amt} (${METHOD_DE[p.method] ?? p.method}) erstattet – zur Rechnung ${inv.number} vom ${formatDate(inv.issueDate)}.`,
        ...(p.note ? [p.note] : []), ...(p.cancelledAt ? [`Diese Erstattung wurde am ${formatDate(p.cancelledAt.toISOString().slice(0, 10))} storniert. Grund: ${p.cancelReason}`] : [])],
      table: { head: ["", "Betrag"], widths: [120, 50], rows: [[inv.status === "CANCELLED" ? "Rechnungsbetrag (storniert)" : "Rechnungsbetrag", formatCents(due)], ["Vorher bezahlt", formatCents(before)], ["Erstattet", amt]] },
      total: [left > 0 ? "Noch offen" : left < 0 ? "Restguthaben" : "Ausgeglichen", formatCents(Math.abs(left))],
      signature: p.method === "CASH",
    });
  }
  return renderLetter({
    title: p.cancelledAt ? `Quittung ${p.number} – STORNIERT` : `Quittung ${p.number}`,
    head: { label: p.cancelledAt ? "Quittung – storniert" : "Quittung", number: p.number, date: formatDate(p.date) },
    buyer: invBuyer(inv),
    info: [["Quittungsnr.", p.number], ["Datum", formatDate(p.date)], ["Zu Rechnung", inv.number ?? ""], ["Kundennr.", String(inv.customer.number)]],
    paragraphs: [`Wir bestätigen den Eingang von ${formatCents(p.amountCents)} (${METHOD_DE[p.method] ?? p.method}) am ${formatDate(p.date)} für die Rechnung ${inv.number} vom ${formatDate(inv.issueDate)}.`,
      ...(p.note ? [p.note] : []), ...(p.cancelledAt ? [`Diese Zahlung wurde am ${formatDate(p.cancelledAt.toISOString().slice(0, 10))} storniert. Grund: ${p.cancelReason}`] : [])],
    table: { head: ["", "Betrag"], widths: [120, 50], rows: [["Rechnungsbetrag", formatCents(inv.grossCents)], ["Bereits vorher bezahlt", formatCents(before)], ["Diese Zahlung", formatCents(p.amountCents)]] },
    total: [rest > 0 ? "Noch offen" : rest < 0 ? "Guthaben" : "Vollständig bezahlt", formatCents(Math.abs(rest))],
    signature: p.method === "CASH",
  });
}

export async function dunningPdf(dunningId: string) {
  const d = await db.query.dunnings.findFirst({ where: eq(schema.dunnings.id, dunningId), with: { invoice: { with: { customer: true } } } });
  if (!d) throw new Error("notFound");
  const inv = d.invoice;
  const { DUNNING_LEVELS } = await import("./payments");
  const cfg = DUNNING_LEVELS[d.level - 1];
  const intro = d.level === 1
    ? "sicher haben Sie es im Tagesgeschäft übersehen: Für die folgende Rechnung konnten wir bis heute keinen vollständigen Zahlungseingang feststellen."
    : d.level === 2 ? "leider ist der unten genannte Betrag trotz unserer Zahlungserinnerung noch offen."
    : "trotz unserer bisherigen Schreiben ist der folgende Betrag weiterhin offen. Wir bitten Sie dringend um Ausgleich.";
  const rows = [[`Rechnung ${inv.number} vom ${formatDate(inv.issueDate)} – fälliger, unbezahlter Betrag`, formatCents(d.openCents)]];
  if (d.feeCents) rows.push(["Mahngebühr", formatCents(d.feeCents)]);
  return renderLetter({
    title: cfg.title, buyer: invBuyer(inv), head: { label: cfg.title, number: inv.number ?? "", date: formatDate(d.date) },
    info: [["Datum", formatDate(d.date)], ["Rechnungsnr.", inv.number ?? ""], ["Kundennr.", String(inv.customer.number)], ["Zahlbar bis", formatDate(d.newDueDate)]],
    paragraphs: ["Sehr geehrte Damen und Herren,", intro],
    table: { head: ["Position", "Betrag"], widths: [120, 50], rows },
    total: ["Zu zahlen", formatCents(d.openCents + d.feeCents)],
    afterTable: [`Bitte überweisen Sie den Betrag bis zum ${formatDate(d.newDueDate)} unter Angabe der Rechnungsnummer ${inv.number}.`,
      "Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos."],
  });
}

// ───────────────────────── Bericht (Monatsübersicht) ─────────────────────────

type ReportSection = { heading: string; head: string[]; widths: number[]; rows: string[][]; total?: [string, string]; note?: string };

export async function renderReport(r: { title: string; subtitle: string; sections: ReportSection[]; notes: string[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(r.title); doc.setLanguage("de-DE"); doc.setCreator("Star Style");
  const { company, logo, th: theme } = await companyAndLogo(doc);
  const th = { ...theme, k: 1 }; // interne Übersicht: Farben/Kopf/Fuß wie die Belege, Schriftgröße bleibt (breite Tabellen)
  const f = await fonts(doc, hasArabic(JSON.stringify(r) + JSON.stringify(company)));
  const [label, ...rest] = r.title.split(" ");
  const w = new Writer(doc, f, company ?? ({ name: "" } as typeof schema.companySettings.$inferSelect), logo, { label, number: rest.join(" "), date: "" }, th);
  w.newPage();
  const L = 20 * MM, R = W - 20 * MM;
  w.title(r.title, w.y); w.y -= 10 * MM;
  w.text(r.subtitle, L, w.y, 9, f.r, th.soft); w.y -= 10 * MM;
  for (const s of r.sections) {
    w.ensure(30 * MM);
    w.label(s.heading, L, w.y, th.accentText, 7.5); w.y -= 6 * MM;
    const xs: number[] = []; let x = L; for (const wd of s.widths) { x += wd * MM; xs.push(x); }
    const head = () => w.tableHead(s.head.map((h, i) => (i === 0 ? { t: h, x: L + 2 * MM } : { t: h, x: xs[i] - 2.5 * MM, right: true })));
    head();
    if (!s.rows.length) { w.text("–", L + 2 * MM, w.y, 8.5, f.r, th.soft); w.y -= 5.5 * MM; }
    s.rows.forEach((row) => {
      w.ensure(6 * MM, head);
      row.forEach((cell, i) => (i === 0 ? w.text(cell, L + 2 * MM, w.y, 8.5) : w.right(cell, xs[i] - 2.5 * MM, w.y, 8.5)));
      w.page.drawLine({ start: { x: L, y: w.y - 2 * MM }, end: { x: R, y: w.y - 2 * MM }, thickness: 0.4, color: th.line });
      w.y -= 5.8 * MM;
    });
    if (s.total) { w.y -= 2 * MM; w.ensure(14 * MM); w.totalBox(s.total[0], s.total[1], 100 * MM); w.y += 4 * MM; }
    if (s.note) { w.text(s.note, L, w.y, 7.5, f.r, th.soft); w.y -= 5 * MM; }
    w.y -= 5 * MM;
  }
  for (const n of r.notes) for (const line of wrap(n, f.r, 7.5, R - L)) { w.ensure(5 * MM); w.text(line, L, w.y, 7.5, f.r, th.soft); w.y -= 3.8 * MM; }
  w.footer();
  return doc.save();
}
