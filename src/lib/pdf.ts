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

export type Fonts = { r: TFont; s: TFont; b: TFont };
type DocKind = "invoice" | "cancellation" | "offer" | "delivery";

type Party = { name: string; street: string; zip: string; city: string; country: string; vatId: string };
type Line = { position: number; sku: string; ean: string | null; category?: string; imageFileId?: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; netCents: number; vatRateBp: number; vatCents?: number; weightGrams?: number | null };
type DocData = {
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
export function roundRect(page: PDFPage, x: number, y: number, w: number, h: number, r: number, color: RGB) {
  const d = `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
  page.drawSvgPath(d, { x, y: y + h, color });
}
export const formatIban = (iban: string) => iban.replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

/** Logo fürs Kopfband: helle Fassung (weiße Schrift) aus public/brand, sonst das Logo aus den Einstellungen auf weißem Feld */
export async function embedBandLogo(doc: PDFDocument, fileId: string | null): Promise<{ img: PDFImage; tile: boolean } | null> {
  const light = path.join(process.cwd(), "public", "brand", "logo-light.png");
  if (fs.existsSync(light)) return { img: await doc.embedPng(fs.readFileSync(light)), tile: false };
  const img = await embedLogo(doc, fileId);
  return img ? { img, tile: true } : null;
}

export type BandHead = { label: string; number: string; date: string };
type BandCompany = Pick<typeof schema.companySettings.$inferSelect, "name" | "street" | "zip" | "city" | "owner" | "phone" | "email" | "website" | "bankName" | "iban" | "bic" | "vatId" | "taxNumber">;
export type FooterLabels = { thanks: string; contact: string; bank: string; tax: string; owner: string; phone: string; page: string };
export const FOOTER_DE: FooterLabels = { thanks: "Vielen Dank für Ihr Vertrauen.", contact: "Kontakt", bank: "Bankverbindung", tax: "Steuern", owner: "Inhaber", phone: "Tel.", page: "Seite {n} von {m}" };

/** Kopfband: Nachtblau, Logo am Anfang, Belegart/Nummer/Datum am Ende, darunter die Logo-Linie (RTL gespiegelt) */
export function drawHeaderBand(page: PDFPage, f: Fonts, logo: { img: PDFImage; tile: boolean } | null, head: BandHead, brandName: string, rtl = false) {
  const L = 20 * MM, R = W - 20 * MM, blue = W * 0.72;
  page.drawRectangle({ x: 0, y: H - BAND_TOP, width: W, height: BAND_TOP, color: BRAND });
  page.drawRectangle({ x: rtl ? W - blue : 0, y: H - BAND_TOP - STRIPE, width: blue, height: STRIPE, color: BLUE });
  page.drawRectangle({ x: rtl ? 0 : blue, y: H - BAND_TOP - STRIPE, width: W - blue, height: STRIPE, color: RED });
  if (logo) {
    const h = logo.tile ? 13 * MM : 15.5 * MM;
    const w = Math.min(62 * MM, (logo.img.width / logo.img.height) * h);
    const lh = (logo.img.height / logo.img.width) * w, x = rtl ? R - w : L, y = H - BAND_TOP / 2 - lh / 2;
    if (logo.tile) roundRect(page, x - 2 * MM, y - 1.6 * MM, w + 4 * MM, lh + 3.2 * MM, 1.6 * MM, WHITE);
    page.drawImage(logo.img, { x, y, width: w, height: lh });
  } else {
    const t = brandName || "Star Style", w = f.b.widthOfTextAtSize(t, 17);
    f.b.draw(page, t, { x: rtl ? R - w : L, y: H - BAND_TOP / 2 - 6, size: 17, color: WHITE });
  }
  const end = (t: string, font: TFont, size: number, y: number, color: RGB, spacing = 0) => {
    const w = spacedWidth(font, t, size, spacing);
    drawSpaced(page, font, t, { x: rtl ? L : R - w, y, size, color, spacing });
  };
  end(head.label.toLocaleUpperCase("de-DE"), f.s, 7.5, H - 9.6 * MM, PALE, 1.4);
  if (head.number) end(head.number, f.b, 14, H - 15.9 * MM, WHITE);
  if (head.date) end(head.date, f.r, 8, H - 20.8 * MM, PALE);
}

/** Fußband: Logo-Linie (gespiegelt), Nachtblau, Dank + Seitenzahl, darunter alle Firmendaten in Spalten */
export function drawFooterBand(page: PDFPage, f: Fonts, c: BandCompany, n: number, m: number, lb: FooterLabels, rtl = false) {
  const L = 20 * MM, R = W - 20 * MM, CW = R - L, red = W * 0.28;
  page.drawRectangle({ x: 0, y: 0, width: W, height: BAND_BOTTOM, color: BRAND });
  page.drawRectangle({ x: rtl ? W - red : 0, y: BAND_BOTTOM, width: red, height: STRIPE, color: RED });
  page.drawRectangle({ x: rtl ? 0 : red, y: BAND_BOTTOM, width: W - red, height: STRIPE, color: BLUE });
  const put = (t: string, s: number, y: number, size: number, font: TFont, color: RGB, maxW = CW, spacing = 0) => {
    let sz = size;
    const w0 = spacedWidth(font, t, sz, spacing);
    if (w0 > maxW) sz = Math.max(5.2, (sz * maxW) / w0);
    const w = spacedWidth(font, t, sz, spacing);
    drawSpaced(page, font, t, { x: rtl ? R - s - w : L + s, y, size: sz, color, spacing });
    return w;
  };
  put([lb.thanks, c.website].filter(Boolean).join("   |   "), 0, 24.4 * MM, 8, f.s, WHITE, CW - 30 * MM);
  const pg = lb.page.replace("{n}", String(n)).replace("{m}", String(m));
  put(pg, CW - f.r.widthOfTextAtSize(pg, 7), 24.4 * MM, 7, f.r, PALE);
  page.drawLine({ start: { x: L, y: 21.3 * MM }, end: { x: R, y: 21.3 * MM }, thickness: 0.4, color: rgb(0.24, 0.3, 0.44) });
  const cols = [
    { head: c.name, bold: true, lines: [c.street, [c.zip, c.city].filter(Boolean).join(" "), c.owner ? `${lb.owner}: ${c.owner}` : ""] },
    { head: lb.contact, lines: [c.phone ? `${lb.phone} ${c.phone}` : "", c.email, c.website] },
    { head: lb.bank, lines: [c.bankName, c.iban ? `IBAN ${formatIban(c.iban)}` : "", c.bic ? `BIC ${c.bic}` : ""] },
    { head: lb.tax, lines: [c.vatId ? `USt-IdNr. ${c.vatId}` : "", c.taxNumber ? `St.-Nr. ${c.taxNumber}` : ""] },
  ].map((col) => ({ ...col, lines: col.lines.filter(Boolean) })).filter((col) => col.lines.length);
  const colW = CW / Math.max(1, cols.length);
  cols.forEach((col, i) => {
    const s = i * colW;
    if (col.bold) put(col.head, s, 17 * MM, 7.6, f.b, WHITE, colW - 3 * MM);
    else put(col.head.toLocaleUpperCase("de-DE"), s, 17 * MM, 6.2, f.s, PALE, colW - 3 * MM, 0.9);
    col.lines.forEach((l, li) => put(l, s, 13.6 * MM - li * 3.3 * MM, 7, f.r, rgb(0.87, 0.9, 0.96), colW - 3 * MM));
  });
}

class Writer {
  page!: PDFPage;
  y = 0;
  pageNo = 0;
  pages: PDFPage[] = [];
  constructor(public doc: PDFDocument, public f: Fonts, public company: typeof schema.companySettings.$inferSelect, public logo: { img: PDFImage; tile: boolean } | null, public head: BandHead) {}

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.pages.push(this.page);
    this.pageNo++;
    drawHeaderBand(this.page, this.f, this.logo, this.head, this.company.name);
    this.y = CONTENT_TOP;
  }
  text(t: string, x: number, y: number, size = 9, font = this.f.r, color: RGB = INK) {
    font.draw(this.page, t, { x, y, size, color });
  }
  right(t: string, xRight: number, y: number, size = 9, font = this.f.r, color: RGB = INK) {
    font.draw(this.page, t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, color });
  }
  ensure(space: number, onBreak?: () => void) {
    if (this.y - space < CONTENT_BOTTOM) { this.newPage(); onBreak?.(); }
  }
  footer() {
    this.pages.forEach((p, i) => drawFooterBand(p, this.f, this.company, i + 1, this.pages.length, FOOTER_DE));
  }
  /** Kleine gesperrte Überschrift in Großbuchstaben (z. B. „RECHNUNG AN“) */
  label(t: string, x: number, y: number, color: RGB = BLUE, size = 6.5) {
    drawSpaced(this.page, this.f.s, t.toLocaleUpperCase("de-DE"), { x, y, size, color, spacing: 1.1 });
  }
  /** Infoblock rechts wie in den Vorlagen: Zeilen mit feiner Linie darunter; gibt die Höhe der letzten Zeile zurück */
  infoRows(rows: [string, string][], top: number) {
    const x0 = 118 * MM, x1 = W - 20 * MM;
    let y = top;
    for (const [k, v] of rows) {
      this.text(k, x0, y, 8, this.f.r, SOFT);
      this.right(v, x1, y, 8.5, this.f.s);
      this.page.drawLine({ start: { x: x0, y: y - 2.3 * MM }, end: { x: x1, y: y - 2.3 * MM }, thickness: 0.4, color: LINE });
      y -= 6.3 * MM;
    }
    return y;
  }
  /** Titel mit kurzer Logo-Linie darunter */
  title(t: string, y: number) {
    this.text(t, 20 * MM, y, 21, this.f.b, BRAND);
    this.page.drawRectangle({ x: 20 * MM, y: y - 4.2 * MM, width: 13 * MM, height: 1.1 * MM, color: BLUE });
    this.page.drawRectangle({ x: 33 * MM, y: y - 4.2 * MM, width: 5 * MM, height: 1.1 * MM, color: RED });
  }
  /** Tabellenkopf: Nachtblau mit runden Ecken, Spaltennamen weiß und gesperrt */
  tableHead(cols: { t: string; x: number; right?: boolean }[]) {
    roundRect(this.page, 20 * MM, this.y - 2.7 * MM, W - 40 * MM, 8.2 * MM, 1.6 * MM, BRAND);
    for (const c of cols) {
      const t = c.t.toLocaleUpperCase("de-DE"), w = spacedWidth(this.f.s, t, 7, 0.6);
      drawSpaced(this.page, this.f.s, t, { x: c.right ? c.x - w : c.x, y: this.y, size: 7, color: WHITE, spacing: 0.6 });
    }
    this.y -= 9 * MM;
  }
  /** Summe im blauen Kasten (wie „Gesamtbetrag“ der Vorlagen) */
  totalBox(label: string, value: string, x0 = 112 * MM) {
    roundRect(this.page, x0, this.y - 3.6 * MM, W - 20 * MM - x0, 10.5 * MM, 1.8 * MM, BLUE);
    this.text(label, x0 + 4 * MM, this.y, 10.5, this.f.b, WHITE);
    this.right(value, W - 24 * MM, this.y - 0.3 * MM, 12, this.f.b, WHITE);
    this.y -= 14 * MM;
  }
  /** Hinweise-Kasten wie im Q-Design-Angebot: zarte Fläche, blaue Kante links */
  noteBox(heading: string, paras: string[]) {
    const width = W - 40 * MM - 10 * MM;
    const lines = paras.flatMap((p, i) => [...wrap(p, this.f.r, 8.5, width).map((l) => ({ l, gap: false })), ...(i < paras.length - 1 ? [{ l: "", gap: true }] : [])]);
    const h = 9 * MM + lines.reduce((s, x) => s + (x.gap ? 1.4 : 4.1) * MM, 0) + 2 * MM;
    this.ensure(h + 4 * MM);
    const top = this.y + 2 * MM;
    this.page.drawRectangle({ x: 20 * MM, y: top - h, width: W - 40 * MM, height: h, color: TINT });
    this.page.drawRectangle({ x: 20 * MM, y: top - h, width: 1.2 * MM, height: h, color: BLUE });
    let y = top - 6 * MM;
    this.text(heading, 26 * MM, y, 9.5, this.f.b, BRAND);
    y -= 5.6 * MM;
    for (const x of lines) { if (!x.gap) this.text(x.l, 26 * MM, y, 8.5, this.f.r, INK); y -= (x.gap ? 1.4 : 4.1) * MM; }
    this.y = top - h - 6 * MM;
  }
  /** Unterschriftenzeilen (z. B. Auftragserteilung im Angebot) */
  signLines(heading: string, left: string, rightText: string) {
    this.ensure(26 * MM);
    this.text(heading, 20 * MM, this.y, 9, this.f.b, BRAND);
    this.y -= 15 * MM;
    this.page.drawLine({ start: { x: 20 * MM, y: this.y }, end: { x: 98 * MM, y: this.y }, thickness: 0.6, color: SOFT });
    this.page.drawLine({ start: { x: 112 * MM, y: this.y }, end: { x: W - 20 * MM, y: this.y }, thickness: 0.6, color: SOFT });
    this.text(left, 20 * MM, this.y - 4 * MM, 7.5, this.f.r, SOFT);
    this.text(rightText, 112 * MM, this.y - 4 * MM, 7.5, this.f.r, SOFT);
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
  const h = Math.max(rows.length * 4.6 * MM + 13 * MM, payload ? 38 * MM : 0);
  w.ensure(h + 4 * MM);
  const top = w.y + 2 * MM;
  roundRect(w.page, 20 * MM, top - h, W - 40 * MM, h, 2 * MM, TINT);
  let y = top - 7 * MM;
  w.text("Zahlungsinformationen", 25 * MM, y, 10, w.f.b, BLUE);
  y -= 6.2 * MM;
  for (const [k, v] of rows) {
    w.text(k, 25 * MM, y, 8, w.f.r, SOFT);
    w.text(v, 58 * MM, y, 8.5, k === "IBAN" || k === "Betrag" || k === "Verwendungszweck" ? w.f.b : w.f.r);
    y -= 4.6 * MM;
  }
  if (payload) {
    const m = qrModules(payload), size = 27 * MM, unit = size / m.length;
    const qx = W - 25 * MM - size, qy = top - 4.5 * MM; // oben rechts im Kasten
    w.page.drawRectangle({ x: qx - 1.5 * MM, y: qy - size - 1.5 * MM, width: size + 3 * MM, height: size + 3 * MM, color: WHITE });
    w.page.drawSvgPath(modulesPath(m), { x: qx, y: qy, scale: unit, color: rgb(0, 0, 0) });
    const cap = "Scannen & bezahlen";
    w.text(cap, qx + size / 2 - w.f.r.widthOfTextAtSize(cap, 6.5) / 2, qy - size - 4.6 * MM, 6.5, w.f.r, SOFT);
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

const TITLES: Record<DocKind, string> = { invoice: "Rechnung", cancellation: "Stornorechnung", offer: "Angebot", delivery: "Ladeliste / Lieferschein" };

export async function renderPdf(d: DocData, opts: { xml?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${TITLES[d.kind]} ${d.number}`);
  doc.setLanguage("de-DE");
  const company = (await db.query.companySettings.findFirst()) ?? ({ name: "", street: "", zip: "", city: "", country: "DE", owner: "", email: "", phone: "", website: "", vatId: "", taxNumber: "", bankName: "", iban: "", bic: "", logoFileId: null, invoiceFooter: "", defaultPaymentDays: 14, offerValidityDays: 14, id: "company", updatedAt: new Date() } as typeof schema.companySettings.$inferSelect);
  doc.setAuthor(company.name);
  doc.setCreator("Star Style");
  const f = await fonts(doc, hasArabic(JSON.stringify(d) + JSON.stringify(company)));
  const w = new Writer(doc, f, company, await embedBandLogo(doc, company?.logoFileId ?? null),
    { label: TITLES[d.kind], number: d.kind === "delivery" && d.number === "ENTWURF" ? "" : d.number, date: formatDate(d.date) });
  w.newPage();
  const L = 20 * MM, R = W - 20 * MM;

  // Absenderzeile + Anschrift (Fensterumschlag), darüber „RECHNUNG AN“ wie in den Vorlagen
  const sender = [company.name, company.street, [company.zip, company.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  w.text(sender, L, H - 45 * MM, 7, f.r, SOFT);
  w.page.drawLine({ start: { x: L, y: H - 46 * MM }, end: { x: 105 * MM, y: H - 46 * MM }, thickness: 0.4, color: LINE });
  w.label(d.kind === "offer" ? "Angebot für" : d.kind === "delivery" ? "Lieferung an" : d.kind === "cancellation" ? "Storno für" : "Rechnung an", L, H - 51 * MM);
  const addr = [d.buyer.name, d.buyer.street, [d.buyer.zip, d.buyer.city].filter(Boolean).join(" "), countryName(d.buyer.country)].filter(Boolean);
  addr.forEach((l, i) => w.text(l, L, H - 56.5 * MM - i * 4.9 * MM, i === 0 ? 10.5 : 10, i === 0 ? f.s : f.r));

  // Infoblock rechts: Zeilen mit feiner Linie
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
  w.y = Math.min(H - 97 * MM, infoEnd - 8 * MM, H - 56.5 * MM - addr.length * 4.9 * MM - 12 * MM);
  w.title(`${TITLES[d.kind]} ${d.kind === "delivery" ? "" : d.number}`.trim(), w.y);
  w.y -= 12.5 * MM;
  const intro = d.kind === "offer" ? "vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:"
    : d.kind === "invoice" ? "vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Lieferung:"
    : d.kind === "cancellation" ? `hiermit stornieren wir die Rechnung ${d.refNumber ?? ""} vollständig.`
    : "Bitte beim Verladen jede Position prüfen und abhaken.";
  if (d.kind !== "delivery") { w.text("Sehr geehrte Damen und Herren,", L, w.y, 9.5); w.y -= 5 * MM; }
  for (const l of wrap(intro, f.r, 9.5, R - L)) { w.text(l, L, w.y, 9.5); w.y -= 5 * MM; }
  w.y -= 4.5 * MM;

  // Tabelle: Kopf Nachtblau, Zeilen mit feiner Linie, Kategorie klein über dem Artikel (wie im Q-Design-Angebot)
  const priced = d.kind !== "delivery";
  // Spalten (rechte Kanten): Menge, Einzelpreis, Rabatt, Gesamt – so breit, dass die gesperrten Überschriften nicht ineinanderlaufen
  const X = { pos: L + 2 * MM, desc: L + 11 * MM, qtyR: priced ? 124 * MM : 160 * MM, price: 147 * MM, disc: 160 * MM, total: R - 2.5 * MM };
  const descW = (priced ? 83 : 110) * MM;
  const head = () => w.tableHead(priced
    ? [{ t: "Pos.", x: X.pos }, { t: "Artikel", x: X.desc }, { t: "Menge", x: X.qtyR, right: true }, { t: d.pricesGross ? "Preis brutto" : "Einzelpreis", x: X.price, right: true }, { t: "Rabatt", x: X.disc, right: true }, { t: d.pricesGross ? "Gesamt brutto" : "Gesamt", x: X.total, right: true }]
    : [{ t: "Pos.", x: X.pos }, { t: "Art.-Nr. · Artikel", x: X.desc }, { t: "Menge", x: X.qtyR, right: true }, { t: "Geladen", x: X.total, right: true }]);
  head();
  // Angebot: Produktfoto je Position (Vorlage Q-Design); Rechnung bleibt ohne Bilder (Archiv klein, Standard)
  const thumbs = d.kind === "offer" ? await embedThumbs(doc, d.lines.map((l) => l.imageFileId)) : new Map<string, PDFImage>();
  const TH = 14 * MM; // Bildfeld; gibt es Fotos, rücken alle Zeilen ein (gleiche Textkante)
  d.lines.forEach((l) => {
    // Art.-Nr. = Barcode (Regel seit 03.11.2026): je Position genau eine Nummer – der Barcode der gelieferten Größe/Farbe
    // (beim Verladen scanbar), ohne Barcode die Art.-Nr.
    const no = l.ean || l.sku;
    const title = priced ? l.description : `${no ? no + " · " : ""}${l.description}`;
    // Ladeliste: Gewicht je Stück und zusammen (Versand)
    const sub = priced ? no : l.weightGrams ? `Gewicht: je ${formatWeight(l.weightGrams)} · zus. ${formatWeight(l.weightGrams * Math.abs(l.qty))}` : "";
    const cat = (l.category ?? "").trim();
    const img = l.imageFileId ? thumbs.get(l.imageFileId) : undefined;
    const tx = thumbs.size ? X.desc + TH + 3 * MM : X.desc, tw = thumbs.size ? descW - TH - 3 * MM : descW;
    const rows = wrap(title, f.s, 9, tw);
    const textH = (cat ? 3.9 : 0) * MM + rows.length * 4.4 * MM + (sub ? 3.8 : 0) * MM;
    const h = Math.max(textH, img ? TH + 1.5 * MM : 0) + 3.2 * MM;
    w.ensure(h, head);
    let y = w.y;
    if (img) {
      const sc = Math.min(TH / img.width, TH / img.height), iw = img.width * sc, ih = img.height * sc;
      w.page.drawRectangle({ x: X.desc, y: w.y + 3 * MM - TH - 0.5 * MM, width: TH, height: TH, color: TINT });
      w.page.drawImage(img, { x: X.desc + (TH - iw) / 2, y: w.y + 3 * MM - 0.5 * MM - TH + (TH - ih) / 2, width: iw, height: ih });
    }
    if (cat) { drawSpaced(w.page, f.s, cat.toLocaleUpperCase("de-DE"), { x: tx, y, size: 6, color: BLUE, spacing: 0.7 }); y -= 3.9 * MM; }
    const first = y;
    rows.forEach((r) => { w.text(r, tx, y, 9, f.s); y -= 4.4 * MM; });
    if (sub) { w.text(sub, tx, y + 0.5 * MM, 7.5, f.r, SOFT); y -= 3.8 * MM; }
    if (img) y = Math.min(y, w.y - TH + 1.4 * MM);
    w.text(String(l.position), X.pos, first, 9, f.r, SOFT);
    w.right(String(Math.abs(l.qty)), X.qtyR, first, 9);
    if (priced) {
      w.right(formatCents(l.unitPriceCents), X.price, first, 9);
      w.right(l.discountBp ? `${bpToPercent(l.discountBp)} %` : "", X.disc, first, 9, f.r, SOFT);
      w.right(formatCents(d.pricesGross ? l.netCents + (l.vatCents ?? 0) : l.netCents), X.total, first, 9, f.b);
    } else {
      w.page.drawRectangle({ x: X.total - 4 * MM, y: first - 1 * MM, width: 4 * MM, height: 4 * MM, borderColor: INK, borderWidth: 0.7 });
    }
    w.page.drawLine({ start: { x: L, y: y + 1.6 * MM }, end: { x: R, y: y + 1.6 * MM }, thickness: 0.4, color: LINE });
    w.y = y - 3.2 * MM + 1.6 * MM;
  });
  w.y -= 2 * MM;

  // Ladeliste: Gesamtmenge zum Gegenprüfen beim Verladen
  if (!priced) {
    const total = d.lines.reduce((sum, l) => sum + Math.abs(l.qty), 0);
    w.ensure(8 * MM);
    w.y -= 2.5 * MM;
    w.text(`Gesamtmenge (${d.lines.length} ${d.lines.length === 1 ? "Position" : "Positionen"})`, X.desc, w.y, 9, f.s);
    w.right(String(total), X.qtyR, w.y, 9.5, f.b);
    w.y -= 6 * MM;
    // Gesamtgewicht der Sendung (Positionen ohne Gewicht werden genannt)
    const sw = shipmentWeight(d.lines.map((l) => ({ qty: l.qty, weightGrams: l.weightGrams ?? null })));
    if (sw.grams > 0) {
      w.ensure(6 * MM);
      w.text(`Gesamtgewicht${sw.missing ? ` (ohne ${sw.missing} ${sw.missing === 1 ? "Position" : "Positionen"} ohne Gewicht)` : ""}`, X.desc, w.y, 9, f.s);
      w.right(`ca. ${formatWeight(sw.grams)}`, X.qtyR, w.y, 9.5, f.b);
      w.y -= 6 * MM;
    }
  }

  // Summen: Zeilen mit feiner Linie, Gesamtbetrag im blauen Kasten
  if (priced) {
    const rows: [string, string][] = [];
    if (d.discountCents) {
      rows.push(["Zwischensumme", formatCents(d.subtotalCents)]);
      rows.push([`Rabatt ${bpToPercent(d.discountBp)} %`, `- ${formatCents(Math.abs(d.discountCents))}`]);
    }
    rows.push(["Nettobetrag", formatCents(d.netCents)]);
    for (const g of d.vatBreakdown) rows.push([`USt. ${bpToPercent(g.rateBp)} % auf ${formatCents(g.netCents)}`, formatCents(g.vatCents)]);
    w.ensure(rows.length * 6 * MM + 18 * MM);
    w.y -= 2 * MM;
    for (const [k, v] of rows) {
      w.text(k, 114 * MM, w.y, 8.5, f.r, SOFT);
      w.right(v, R - 2.5 * MM, w.y, 9);
      w.page.drawLine({ start: { x: 112 * MM, y: w.y - 2.2 * MM }, end: { x: R, y: w.y - 2.2 * MM }, thickness: 0.4, color: LINE });
      w.y -= 6 * MM;
    }
    w.y -= 2.5 * MM;
    w.totalBox(d.kind === "offer" ? "Angebotssumme" : d.kind === "cancellation" ? "Stornobetrag" : "Gesamtbetrag", formatCents(d.grossCents));
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
  if (notes.length) w.noteBox("Hinweise", notes);

  // Zahlungsinformationen mit QR-Code (Banking-App: „Scannen & bezahlen“)
  if (d.kind === "invoice" && open > 0) paymentBox(w, { amountCents: open, reference: d.number });

  if (d.kind === "delivery") {
    w.ensure(30 * MM);
    w.y -= 10 * MM;
    const boxes = ["Verladen und geprüft von (Name, Unterschrift)", "Ware vollständig erhalten – Kunde / Fahrer"];
    boxes.forEach((b, i) => {
      const x = L + i * 92 * MM;
      w.page.drawLine({ start: { x, y: w.y }, end: { x: x + 78 * MM, y: w.y }, thickness: 0.6, color: INK });
      w.text(b, x, w.y - 4 * MM, 7.5, f.r, SOFT);
    });
    w.y -= 12 * MM;
    w.text("Datum: ____________________", L, w.y, 9);
  } else if (d.kind !== "cancellation") {
    w.ensure(12 * MM);
    w.y -= 2 * MM;
    w.text("Mit freundlichen Grüßen", L, w.y, 9.5); w.y -= 5 * MM;
    w.text(company.name, L, w.y, 9.5, f.s);
    // Angebot: Auftragserteilung durch den Kunden (wie im Q-Design-Angebot)
    if (d.kind === "offer") { w.y -= 12 * MM; w.signLines("Auftragserteilung", "Ort, Datum", "Unterschrift / Firmenstempel"); }
  }

  w.footer();

  if (opts.xml) {
    await doc.attach(Buffer.from(opts.xml, "utf8"), "factur-x.xml", {
      mimeType: "text/xml", description: "Factur-X/ZUGFeRD Rechnungsdaten (EN 16931)",
      creationDate: new Date(), modificationDate: new Date(), afRelationship: AFRelationship.Alternative,
    });
    setFacturXMetadata(doc, `${TITLES[d.kind]} ${d.number}`, company.name);
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

async function linesWithProducts(lines: { position: number; variantId: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; netCents?: number; vatRateBp: number; vatCents?: number }[]) {
  const out: Line[] = [];
  for (const l of lines.sort((a, b) => a.position - b.position)) {
    let sku = "", ean: string | null = null, weightGrams: number | null = null, category = "", imageFileId: string | null = null;
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

type Letter = {
  title: string; buyer: Party; info: [string, string][]; paragraphs: string[];
  /** Kopfband: Belegart, Nummer, Datum */
  head: BandHead;
  table?: { head: string[]; rows: string[][]; widths: number[] }; total?: [string, string]; afterTable?: string[]; signature?: boolean;
};

async function companyAndLogo(doc: PDFDocument) {
  const company = (await db.query.companySettings.findFirst()) as typeof schema.companySettings.$inferSelect;
  const logo = await embedBandLogo(doc, company?.logoFileId ?? null);
  return { company, logo };
}

export async function renderLetter(l: Letter): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(l.title); doc.setLanguage("de-DE"); doc.setCreator("Star Style");
  const { company, logo } = await companyAndLogo(doc);
  const f = await fonts(doc, hasArabic(JSON.stringify(l) + JSON.stringify(company)));
  const w = new Writer(doc, f, company, logo, l.head);
  w.newPage();
  const L = 20 * MM, R = W - 20 * MM;
  const sender = [company.name, company.street, [company.zip, company.city].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  w.text(sender, L, H - 45 * MM, 7, f.r, SOFT);
  w.page.drawLine({ start: { x: L, y: H - 46 * MM }, end: { x: 105 * MM, y: H - 46 * MM }, thickness: 0.4, color: LINE });
  w.label("An", L, H - 51 * MM);
  const addr = [l.buyer.name, l.buyer.street, [l.buyer.zip, l.buyer.city].filter(Boolean).join(" "), countryName(l.buyer.country)].filter(Boolean);
  addr.forEach((s, i) => w.text(s, L, H - 56.5 * MM - i * 4.9 * MM, i === 0 ? 10.5 : 10, i === 0 ? f.s : f.r));
  const infoEnd = w.infoRows(l.info, H - 48 * MM);
  w.y = Math.min(H - 97 * MM, infoEnd - 8 * MM, H - 56.5 * MM - addr.length * 4.9 * MM - 12 * MM);
  w.title(l.title, w.y); w.y -= 12.5 * MM;
  const para = (s: string, size = 9.5) => { for (const r of wrap(s, f.r, size, R - L)) { w.ensure(6 * MM); w.text(r, L, w.y, size); w.y -= 4.8 * MM; } w.y -= 2.5 * MM; };
  l.paragraphs.forEach((p) => para(p));
  if (l.table) {
    const { head, rows, widths } = l.table;
    const xs: number[] = []; let x = L; for (const wd of widths) { x += wd * MM; xs.push(x); }
    const drawHead = () => w.tableHead(head.map((h, i) => (i === 0 ? { t: h, x: L + 2 * MM } : { t: h, x: xs[i] - 2.5 * MM, right: true })));
    w.y -= 2 * MM; drawHead();
    rows.forEach((r) => {
      w.ensure(7 * MM, drawHead);
      r.forEach((cell, i) => (i === 0 ? w.text(cell, L + 2 * MM, w.y, 9) : w.right(cell, xs[i] - 2.5 * MM, w.y, 9, f.s)));
      w.page.drawLine({ start: { x: L, y: w.y - 2.4 * MM }, end: { x: R, y: w.y - 2.4 * MM }, thickness: 0.4, color: LINE });
      w.y -= 6.6 * MM;
    });
  }
  if (l.total) { w.ensure(16 * MM); w.y -= 3 * MM; w.totalBox(l.total[0], l.total[1]); }
  (l.afterTable ?? []).forEach((p) => para(p, 9));
  w.ensure(28 * MM); w.y -= 2 * MM;
  w.text("Mit freundlichen Grüßen", L, w.y, 9.5); w.y -= 5 * MM;
  w.text(company.name, L, w.y, 9.5, f.s);
  if (l.signature) {
    w.y -= 16 * MM;
    w.page.drawLine({ start: { x: L, y: w.y }, end: { x: 90 * MM, y: w.y }, thickness: 0.6, color: SOFT });
    w.text("Unterschrift Empfänger der Zahlung", L, w.y - 4 * MM, 7.5, f.r, SOFT);
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
  const { company, logo } = await companyAndLogo(doc);
  const f = await fonts(doc, hasArabic(JSON.stringify(r) + JSON.stringify(company)));
  const [label, ...rest] = r.title.split(" ");
  const w = new Writer(doc, f, company ?? ({ name: "" } as typeof schema.companySettings.$inferSelect), logo, { label, number: rest.join(" "), date: "" });
  w.newPage();
  const L = 20 * MM, R = W - 20 * MM;
  w.title(r.title, w.y); w.y -= 10 * MM;
  w.text(r.subtitle, L, w.y, 9, f.r, SOFT); w.y -= 10 * MM;
  for (const s of r.sections) {
    w.ensure(30 * MM);
    w.label(s.heading, L, w.y, BLUE, 7.5); w.y -= 6 * MM;
    const xs: number[] = []; let x = L; for (const wd of s.widths) { x += wd * MM; xs.push(x); }
    const head = () => w.tableHead(s.head.map((h, i) => (i === 0 ? { t: h, x: L + 2 * MM } : { t: h, x: xs[i] - 2.5 * MM, right: true })));
    head();
    if (!s.rows.length) { w.text("–", L + 2 * MM, w.y, 8.5, f.r, SOFT); w.y -= 5.5 * MM; }
    s.rows.forEach((row) => {
      w.ensure(6 * MM, head);
      row.forEach((cell, i) => (i === 0 ? w.text(cell, L + 2 * MM, w.y, 8.5) : w.right(cell, xs[i] - 2.5 * MM, w.y, 8.5)));
      w.page.drawLine({ start: { x: L, y: w.y - 2 * MM }, end: { x: R, y: w.y - 2 * MM }, thickness: 0.4, color: LINE });
      w.y -= 5.8 * MM;
    });
    if (s.total) { w.y -= 2 * MM; w.ensure(14 * MM); w.totalBox(s.total[0], s.total[1], 100 * MM); w.y += 4 * MM; }
    if (s.note) { w.text(s.note, L, w.y, 7.5, f.r, SOFT); w.y -= 5 * MM; }
    w.y -= 5 * MM;
  }
  for (const n of r.notes) for (const line of wrap(n, f.r, 7.5, R - L)) { w.ensure(5 * MM); w.text(line, L, w.y, 7.5, f.r, SOFT); w.y -= 3.8 * MM; }
  w.footer();
  return doc.save();
}
