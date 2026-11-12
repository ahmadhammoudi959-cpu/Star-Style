/**
 * Belegdesign (Wunsch Inhaber 12.11.2026: „die Rechnung, das Angebot … selbst gestalten – Farben, Schrift, Kopf und Fuß,
 * Texte oben, links und rechts, Dinge weglassen oder dazuschreiben“). Rein, auch im Browser benutzbar (Designer-Seite).
 *
 * Standardwerte = bisheriges Aussehen (Rahmen wie die Vorlagen Q-Design/Go Trend). Jeder Wert wird geprüft und begrenzt;
 * Unbekanntes oder Kaputtes fällt auf den Standard zurück (parseDesign wirft nie).
 * Pflichtangaben einer Rechnung (§ 14 UStG: Firma, Anschrift, USt-IdNr./St.-Nr., Rechnungsnummer, Datum, Lieferdatum,
 * Menge und Bezeichnung, Entgelt, Steuersatz und -betrag, Steuerhinweise) sind nicht abschaltbar – nur ihr Aussehen.
 */
export const TEXT_KINDS = ["invoice", "offer", "cancellation", "delivery"] as const;
export type TextKind = (typeof TEXT_KINDS)[number];
/** Belegarten in der Vorschau (Quittung/Mahnung haben feste Texte, folgen aber Farben, Kopf/Fuß und Schrift) */
export const PREVIEW_KINDS = ["invoice", "offer", "cancellation", "delivery", "receipt", "dunning"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];

export type KindTexts = { title: string; to: string; greeting: string; intro: string; closing: string; signoff: string; total: string };
export type DocDesign = {
  colors: { primary: string; accent: string; accent2: string; text: string };
  /** band = Fläche in der Hauptfarbe (bisher), light = weiß mit Logo-Linie, minimal = weiß ohne Linie */
  header: "band" | "light" | "minimal";
  /** band = Fläche in der Hauptfarbe, light = weiß mit feiner Linie; die Firmendaten stehen immer da (Pflichtangaben) */
  footer: "band" | "light";
  /** Logo-Linie (zweifarbig) unter dem Kopf, über dem Fuß und unter dem Titel */
  stripe: boolean;
  logoSize: "s" | "m" | "l";
  /** Schriftgröße des Inhalts in Prozent (85–125) */
  fontSize: number;
  /** Größe der Überschrift („Rechnung RE-…“) in Punkt (14–28) */
  titleSize: number;
  tableHead: "filled" | "line";
  totalBox: "filled" | "line";
  show: {
    senderLine: boolean; posColumn: boolean; category: boolean; itemCode: boolean; discountColumn: boolean;
    photos: boolean; paymentQr: boolean; pageNumbers: boolean; website: boolean; bank: boolean; signature: boolean;
  };
  texts: Record<TextKind, KindTexts>;
  common: {
    headerNote: string; thanks: string; footerNote: string; notesTitle: string;
    colItem: string; colQty: string; colPrice: string; colPriceGross: string; colDiscount: string; colTotal: string; colTotalGross: string;
  };
};

export const DEFAULT_DESIGN: DocDesign = {
  colors: { primary: "#111A33", accent: "#1752D6", accent2: "#E3191C", text: "#1D2433" },
  header: "band", footer: "band", stripe: true, logoSize: "m", fontSize: 100, titleSize: 21, tableHead: "filled", totalBox: "filled",
  show: {
    senderLine: true, posColumn: true, category: true, itemCode: true, discountColumn: true,
    photos: true, paymentQr: true, pageNumbers: true, website: true, bank: true, signature: true,
  },
  texts: {
    invoice: {
      title: "Rechnung", to: "Rechnung an", greeting: "Sehr geehrte Damen und Herren,",
      intro: "vielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Lieferung:", closing: "", signoff: "Mit freundlichen Grüßen", total: "Gesamtbetrag",
    },
    offer: {
      title: "Angebot", to: "Angebot für", greeting: "Sehr geehrte Damen und Herren,",
      intro: "vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:", closing: "", signoff: "Mit freundlichen Grüßen", total: "Angebotssumme",
    },
    cancellation: {
      title: "Stornorechnung", to: "Storno für", greeting: "Sehr geehrte Damen und Herren,",
      intro: "hiermit stornieren wir die Rechnung {ref} vollständig.", closing: "", signoff: "", total: "Stornobetrag",
    },
    delivery: {
      title: "Ladeliste / Lieferschein", to: "Lieferung an", greeting: "",
      intro: "Bitte beim Verladen jede Position prüfen und abhaken.", closing: "", signoff: "", total: "",
    },
  },
  common: {
    headerNote: "", thanks: "Vielen Dank für Ihr Vertrauen.", footerNote: "", notesTitle: "Hinweise",
    colItem: "Artikel", colQty: "Menge", colPrice: "Einzelpreis", colPriceGross: "Preis brutto", colDiscount: "Rabatt", colTotal: "Gesamt", colTotalGross: "Gesamt brutto",
  },
};

/** Pflichtteile, die im Designer mit Schloss angezeigt werden (nur Anzeige – im PDF gibt es dafür keinen Schalter) */
export const LOCKED_PARTS = ["company", "taxId", "numberDate", "buyer", "quantities", "vat", "legalNotes"] as const;

/** Farbvorlagen für einen schnellen Wechsel (Hauptfarbe, Akzent, zweiter Akzent, Text); mit header/footer stellen sie auch Kopf/Fuß um, sonst bleiben die */
export const PRESETS: { key: string; colors: DocDesign["colors"]; header?: DocDesign["header"]; footer?: DocDesign["footer"] }[] = [
  { key: "original", colors: DEFAULT_DESIGN.colors, header: "band", footer: "band" },
  { key: "classic", colors: { primary: "#1F2937", accent: "#374151", accent2: "#9CA3AF", text: "#111827" }, header: "light", footer: "light" },
  { key: "ocean", colors: { primary: "#0B3B5C", accent: "#0E7490", accent2: "#F59E0B", text: "#1E293B" } },
  { key: "forest", colors: { primary: "#14352A", accent: "#15803D", accent2: "#CA8A04", text: "#1C2B24" } },
  { key: "wine", colors: { primary: "#3B0A1E", accent: "#9F1239", accent2: "#D4A017", text: "#2A1520" } },
];

export const LIMITS = {
  fontSize: { min: 85, max: 125, step: 5 }, titleSize: { min: 14, max: 28, step: 1 },
  short: 60, line: 160, para: 600,
} as const;
/** Spaltennamen der Tabelle: höchstens so lang, sonst laufen die gesperrten Überschriften ineinander */
export const COL_LIMITS = { colItem: 30, colQty: 16, colPrice: 18, colPriceGross: 18, colDiscount: 12, colTotal: 18, colTotalGross: 18 } as const;

// ───────────────────────── Prüfen und begrenzen ─────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v.trim()) ? v.trim().toUpperCase() : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, lo: number, hi: number, step = 1) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, Math.round(n / step) * step));
};
/** Text: Steuerzeichen weg (Zeilenumbrüche bleiben bei Absätzen), gekürzt; fehlt er → Standard; leer = absichtlich leer */
const text = (v: unknown, d: string, max: number, multiline = false) => {
  if (typeof v !== "string") return d;
  const clean = v.replace(/\r\n?/g, "\n").replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, multiline ? "" : " ");
  return clean.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
};
/** Pflichtfelder dürfen nicht leer werden (z. B. Belegtitel) → leer = Standard */
const required = (v: unknown, d: string, max: number) => text(v, d, max) || d;

/** Gespeichertes oder geschicktes Design → vollständiges, gültiges Design (nie ein Fehler) */
export function parseDesign(input: unknown): DocDesign {
  const D = DEFAULT_DESIGN;
  const i = isObj(input) ? input : {};
  const c = isObj(i.colors) ? i.colors : {};
  const s = isObj(i.show) ? i.show : {};
  const t = isObj(i.texts) ? i.texts : {};
  const m = isObj(i.common) ? i.common : {};
  const texts = Object.fromEntries(TEXT_KINDS.map((k) => {
    const x = isObj(t[k]) ? t[k] : {};
    const d = D.texts[k];
    return [k, {
      title: required(x.title, d.title, LIMITS.short), to: text(x.to, d.to, LIMITS.short),
      greeting: text(x.greeting, d.greeting, LIMITS.line), intro: text(x.intro, d.intro, LIMITS.para, true),
      closing: text(x.closing, d.closing, LIMITS.para, true), signoff: text(x.signoff, d.signoff, LIMITS.line),
      total: k === "delivery" ? "" : required(x.total, d.total, LIMITS.short),
    }];
  })) as Record<TextKind, KindTexts>;
  return {
    colors: { primary: color(c.primary, D.colors.primary), accent: color(c.accent, D.colors.accent), accent2: color(c.accent2, D.colors.accent2), text: color(c.text, D.colors.text) },
    header: oneOf(i.header, ["band", "light", "minimal"] as const, D.header),
    footer: oneOf(i.footer, ["band", "light"] as const, D.footer),
    stripe: bool(i.stripe, D.stripe),
    logoSize: oneOf(i.logoSize, ["s", "m", "l"] as const, D.logoSize),
    fontSize: num(i.fontSize, D.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max, LIMITS.fontSize.step),
    titleSize: num(i.titleSize, D.titleSize, LIMITS.titleSize.min, LIMITS.titleSize.max, LIMITS.titleSize.step),
    tableHead: oneOf(i.tableHead, ["filled", "line"] as const, D.tableHead),
    totalBox: oneOf(i.totalBox, ["filled", "line"] as const, D.totalBox),
    show: Object.fromEntries(Object.entries(D.show).map(([k, d]) => [k, bool(s[k], d)])) as DocDesign["show"],
    texts,
    common: {
      headerNote: text(m.headerNote, D.common.headerNote, LIMITS.line), thanks: text(m.thanks, D.common.thanks, LIMITS.line),
      footerNote: text(m.footerNote, D.common.footerNote, LIMITS.line), notesTitle: required(m.notesTitle, D.common.notesTitle, LIMITS.short),
      colItem: required(m.colItem, D.common.colItem, COL_LIMITS.colItem), colQty: required(m.colQty, D.common.colQty, COL_LIMITS.colQty),
      colPrice: required(m.colPrice, D.common.colPrice, COL_LIMITS.colPrice), colPriceGross: required(m.colPriceGross, D.common.colPriceGross, COL_LIMITS.colPriceGross),
      colDiscount: required(m.colDiscount, D.common.colDiscount, COL_LIMITS.colDiscount), colTotal: required(m.colTotal, D.common.colTotal, COL_LIMITS.colTotal),
      colTotalGross: required(m.colTotalGross, D.common.colTotalGross, COL_LIMITS.colTotalGross),
    },
  };
}

/** Nur die Abweichungen vom Standard (so bleibt das Gespeicherte klein und neue Standardwerte wirken später mit) */
export function designDiff(d: DocDesign): Record<string, unknown> {
  const diff = (a: unknown, b: unknown): unknown => {
    if (isObj(a) && isObj(b)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(a)) { const v = diff(a[k], b[k]); if (v !== undefined) out[k] = v; }
      return Object.keys(out).length ? out : undefined;
    }
    return a === b ? undefined : a;
  };
  return (diff(d, DEFAULT_DESIGN) as Record<string, unknown>) ?? {};
}

export const isDefaultDesign = (d: DocDesign) => Object.keys(designDiff(d)).length === 0;

/** Platzhalter in Texten: {number} {date} {customer} {ref} {valid} */
export function fillPlaceholders(s: string, v: { number?: string; date?: string; customer?: string; ref?: string; valid?: string }) {
  return s.replace(/\{(number|date|customer|ref|valid)\}/g, (_, k: keyof typeof v) => v[k] ?? "");
}

// ───────────────────────── Farben ─────────────────────────

export type Rgb = [number, number, number];
export const hexToRgb = (h: string): Rgb => {
  const x = HEX.test(h) ? h : "#000000";
  return [parseInt(x.slice(1, 3), 16) / 255, parseInt(x.slice(3, 5), 16) / 255, parseInt(x.slice(5, 7), 16) / 255];
};
/** Mischung a → b (t = 0 … 1) */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** relative Leuchtdichte (WCAG) */
export function luminance([r, g, b]: Rgb) {
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** Ist die Fläche dunkel genug für weiße Schrift? (sonst dunkle Schrift) */
export const isDark = (c: Rgb) => contrast(c, [1, 1, 1]) >= contrast(c, [0, 0, 0]);
