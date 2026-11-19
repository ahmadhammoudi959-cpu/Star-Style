import "server-only";
/**
 * Werbebild für Aktionen (Wunsch Inhaber 19.11.2026: „بكبسه زر انشئ لي صوره اعلانيه بخصم 20%“):
 * gezeichnet mit @napi-rs/canvas aus den ECHTEN Produktfotos, dem Rabatt und den Texten (Überschrift/Zeile/Kurznamen schreibt
 * die KI, siehe promo-copy.ts). Bewusst ohne Preise im Bild: Wiederverkäufer sehen im Shop andere Preise, und ein später
 * geänderter Preis machte das Bild falsch – „−20%“ passt immer zum Streichpreis und zum Abzeichen auf der Produktkarte.
 * Zwei Formate: wide 2400×800 (Computer, im Shop über/unter dem Hero), tall 1080×1350 (Handy, auch zum Teilen);
 * vier Shop-Sprachen (Arabisch von rechts); drei Stile. Die festen Wörter im Bild (AKTION, Jetzt entdecken …) stehen hier und
 * nicht in src/i18n: das sind die Sprachen der Shops (mit nl), nicht die der Oberfläche.
 */
import fs from "node:fs";
import path from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import sharp from "sharp";

export const BANNER_LANGS = ["de", "en", "ar", "nl"] as const;
export type BannerLang = (typeof BANNER_LANGS)[number];
export type BannerFormat = "wide" | "tall";
export const BANNER_FORMATS: BannerFormat[] = ["wide", "tall"];
export const BANNER_SIZE: Record<BannerFormat, { w: number; h: number }> = { wide: { w: 2400, h: 800 }, tall: { w: 1080, h: 1350 } };
export const BANNER_STYLES = 3;

export type BannerCopy = { headline: string; sub: string; names: string[] };
export type BannerInput = {
  lang: BannerLang;
  format: BannerFormat;
  discountBp: number;
  copy: BannerCopy;
  /** Fotos der Artikel in der Reihenfolge der Aktion (null = ohne Foto) – vorbereitet mit preparePhotos() */
  photos: (PreparedPhoto | null)[];
  /** letzter Tag des Rabatts (YYYY-MM-DD, Berliner Datum) – steht dann als „Nur bis …“ statt der Unterzeile im Bild */
  until: string | null;
  style: number;
};

const FIXED: Record<BannerLang, { kicker: string; cta: string; until: (d: string) => string; more: (n: number) => string }> = {
  de: { kicker: "AKTION", cta: "Jetzt entdecken", until: (d) => `Nur bis ${d}`, more: (n) => `+${n} weitere` },
  en: { kicker: "SALE", cta: "Shop now", until: (d) => `Only until ${d}`, more: (n) => `+${n} more` },
  ar: { kicker: "خصم", cta: "تسوّق الآن", until: (d) => `حتى ${d}`, more: (n) => `+${n} منتجات أخرى` },
  nl: { kicker: "ACTIE", cta: "Nu ontdekken", until: (d) => `Alleen t/m ${d}`, more: (n) => `+${n} meer` },
};

/** Rabatt in Basispunkten → ganze Prozent (Aktionen haben nur ganze Prozent) */
export const percentOf = (discountBp: number) => Math.round(discountBp / 100);
/** große Zahl: „−20%“; Arabisch „20%“ (darüber steht „خصم“) */
export function discountText(lang: BannerLang, discountBp: number): string {
  return lang === "ar" ? `${percentOf(discountBp)}%` : `−${percentOf(discountBp)}%`;
}
/** Abzeichen an jedem Artikel – genau wie auf der Produktkarte im Shop, in allen Sprachen „-20%“ */
export const badgeText = (discountBp: number) => `-${percentOf(discountBp)}%`;
/** „24.11.“ aus YYYY-MM-DD (Datum immer deutsch) */
export const shortDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

// ───────────────────────── Schriften, Farben ─────────────────────────

const FONT = { black: "SS Barlow Black", semi: "SS Barlow Semi", medium: "SS Barlow Medium", arBlack: "SS Tajawal Black", arBold: "SS Tajawal Bold", arMedium: "SS Tajawal Medium" };
let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const dir = path.join(process.cwd(), "assets", "fonts");
  GlobalFonts.registerFromPath(path.join(dir, "BarlowCondensed-Black.ttf"), FONT.black);
  GlobalFonts.registerFromPath(path.join(dir, "BarlowCondensed-SemiBold.ttf"), FONT.semi);
  GlobalFonts.registerFromPath(path.join(dir, "BarlowCondensed-Medium.ttf"), FONT.medium);
  GlobalFonts.registerFromPath(path.join(dir, "Tajawal-Black.ttf"), FONT.arBlack);
  GlobalFonts.registerFromPath(path.join(dir, "Tajawal-Bold.ttf"), FONT.arBold);
  GlobalFonts.registerFromPath(path.join(dir, "Tajawal-Medium.ttf"), FONT.arMedium);
  fontsReady = true;
}

const C = { navy: "#0B1222", navy2: "#16213D", blue: "#1752D6", red: "#E3191C", white: "#FFFFFF" };
type Palette = { bg: [string, string]; glow: string; text: string; muted: string; accent: string; kickerBg: string; kickerText: string; ctaBg: string; ctaText: string; moreBg: string; stripes: string[]; logo: "light" | "dark" };
export const STYLE_NAMES = ["navy", "red", "light"] as const;
const STYLES: Palette[] = [
  // 0 Nachtblau mit blauem Schein (Markenfarben wie Seitenleiste und Kopfband der Belege)
  { bg: [C.navy, C.navy2], glow: "rgba(23,82,214,0.55)", text: C.white, muted: "#AFC0E6", accent: C.red, kickerBg: C.red, kickerText: C.white, ctaBg: C.white, ctaText: C.navy, moreBg: "rgba(255,255,255,0.14)", stripes: [C.red, C.white, C.blue, C.white], logo: "light" },
  // 1 Rot – laut, für kurze Aktionen
  { bg: ["#E3191C", "#B3121A"], glow: "rgba(255,255,255,0.20)", text: C.white, muted: "#FFE1E1", accent: C.white, kickerBg: C.navy, kickerText: C.white, ctaBg: C.navy, ctaText: C.white, moreBg: "rgba(11,18,34,0.22)", stripes: [C.navy, C.white], logo: "light" },
  // 2 Hell – ruhig, Text Nachtblau, Rabatt rot
  { bg: ["#F6F8FC", "#E4EAF5"], glow: "rgba(23,82,214,0.16)", text: C.navy, muted: "#4D5A73", accent: C.red, kickerBg: C.blue, kickerText: C.white, ctaBg: C.navy, ctaText: C.white, moreBg: "rgba(11,18,34,0.08)", stripes: [C.red, C.white, C.blue, C.white], logo: "dark" },
];

// ───────────────────────── Fotos vorbereiten ─────────────────────────

export type PreparedPhoto = { img: Image; bg: string };

/** Hintergrundfarbe eines Fotos = Median der Randpixel (Produktteile am Rand stören den Median nicht); null = durchsichtig */
function borderColor(data: Buffer, w: number, h: number): { r: number; g: number; b: number } | null {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [], as: number[] = [];
  const step = Math.max(1, Math.floor((w + h) / 400));
  const take = (x: number, y: number) => { const i = (y * w + x) * 4; rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); as.push(data[i + 3]); };
  for (let x = 0; x < w; x += step) { take(x, 0); take(x, 1); take(x, h - 1); take(x, h - 2); }
  for (let y = 0; y < h; y += step) { take(0, y); take(1, y); take(w - 1, y); take(w - 2, y); }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  if (med(as) < 128) return null;
  return { r: med(rs), g: med(gs), b: med(bs) };
}

/**
 * Foto für das Werbebild: gedreht nach EXIF, höchstens 1000 px, leere Ränder in der Hintergrundfarbe abgeschnitten
 * (Produkte wirken größer), ringsum ein schmaler Rand derselben Farbe, der beim Zeichnen weich ausläuft – so sieht man
 * auf der Karte (gleiche Farbe) keine Fotokante. Unlesbare Datei → null (Karte ohne Foto).
 */
export async function preparePhoto(buf: Buffer): Promise<PreparedPhoto | null> {
  try {
    const base = await sharp(buf).rotate().resize(1000, 1000, { fit: "inside", withoutEnlargement: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = base.info;
    const col = borderColor(base.data, w, h);
    const bgHex = col ? `#${[col.r, col.g, col.b].map((v) => v.toString(16).padStart(2, "0")).join("")}` : "#ffffff";
    const raw = sharp(base.data, { raw: { width: w, height: h, channels: 4 } });
    let trimmed: Buffer;
    try {
      trimmed = await raw.clone().trim(col ? { background: bgHex, threshold: 26 } : { threshold: 10 }).png().toBuffer();
    } catch {
      trimmed = await raw.clone().png().toBuffer();
    }
    const meta = await sharp(trimmed).metadata();
    const m = Math.round(Math.max(meta.width ?? 1, meta.height ?? 1) * 0.06) + 4;
    const padded = await sharp(trimmed)
      .extend({ top: m, bottom: m, left: m, right: m, background: col ? { ...col, alpha: 1 } : { r: 255, g: 255, b: 255, alpha: 0 } })
      .png().toBuffer();
    return { img: await loadImage(padded), bg: col ? `rgb(${col.r},${col.g},${col.b})` : C.white };
  } catch {
    return null;
  }
}
export const preparePhotos = (bufs: (Buffer | null)[]) => Promise.all(bufs.map((b) => (b ? preparePhoto(b) : Promise.resolve(null))));

// ───────────────────────── Hilfen ─────────────────────────

type Ctx = SKRSContext2D;
function rr(x: Ctx, l: number, t: number, w: number, h: number, r: number) {
  const k = Math.min(r, w / 2, h / 2);
  x.beginPath();
  x.moveTo(l + k, t); x.arcTo(l + w, t, l + w, t + h, k); x.arcTo(l + w, t + h, l, t + h, k); x.arcTo(l, t + h, l, t, k); x.arcTo(l, t, l + w, t, k);
  x.closePath();
}
const font = (size: number, family: string) => `${Math.round(size)}px "${family}"`;
/** größte Schrift ≤ max, bei der der Text in die Breite passt */
function fit(x: Ctx, text: string, family: string, max: number, min: number, width: number): number {
  let s = max;
  for (; s > min; s -= 2) { x.font = font(s, family); if (x.measureText(text).width <= width) break; }
  return s;
}
/** Zeilen umbrechen (Wörter), höchstens maxLines, sonst „…“ */
function wrap(x: Ctx, text: string, width: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "", used = 0;
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (x.measureText(next).width <= width || !cur) { cur = next; used++; continue; }
    lines.push(cur);
    if (lines.length === maxLines) { cur = ""; break; }
    cur = w; used++;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  let last = lines[lines.length - 1] ?? "";
  if (used < words.length || x.measureText(last).width > width) {
    while (last && x.measureText(`${last}…`).width > width) last = last.slice(0, -1).trimEnd();
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

/** Diagonale Streifen wie am Barber-Pole (Zeichen der Branche), in ein Vieleck geschnitten */
function stripeBand(x: Ctx, pts: [number, number][], colors: string[], stripe: number) {
  x.save();
  x.beginPath();
  x.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) x.lineTo(p[0], p[1]);
  x.closePath();
  x.clip();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minY = Math.min(...ys), maxY = Math.max(...ys), span = maxY - minY;
  let i = 0;
  for (let sx = Math.min(...xs) - span - stripe; sx < Math.max(...xs) + stripe; sx += stripe, i++) {
    x.fillStyle = colors[i % colors.length];
    x.beginPath();
    x.moveTo(sx, maxY); x.lineTo(sx + stripe, maxY); x.lineTo(sx + stripe + span, minY); x.lineTo(sx + span, minY);
    x.closePath();
    x.fill();
  }
  x.restore();
}

type Fonts = { big: string; head: string; body: string; label: string };
const fontsFor = (lang: BannerLang): Fonts => lang === "ar"
  ? { big: FONT.black, head: FONT.arBlack, body: FONT.arMedium, label: FONT.arBold }
  : { big: FONT.black, head: FONT.semi, body: FONT.medium, label: FONT.semi };

/** Text ab „Anfang“ (LTR links, RTL rechts) */
function textAt(x: Ctx, s: string, startX: number, y: number, rtl: boolean) {
  x.direction = rtl ? "rtl" : "ltr";
  x.textAlign = rtl ? "right" : "left";
  x.fillText(s, startX, y);
}

/** Pille mit Text (Kicker, Knopf, „+2 weitere“); startX = Anfang in Leserichtung; gibt die Breite zurück */
function pill(x: Ctx, s: string, startX: number, top: number, h: number, family: string, size: number, bg: string, fg: string, rtl: boolean, chevron = false): number {
  x.font = font(size, family);
  x.direction = rtl ? "rtl" : "ltr";
  const padX = h * 0.4, chev = chevron ? h * 0.36 : 0;
  const w = x.measureText(s).width + padX * 2 + chev;
  const left = rtl ? startX - w : startX;
  x.fillStyle = bg;
  rr(x, left, top, w, h, h / 2);
  x.fill();
  x.fillStyle = fg;
  x.textBaseline = "middle";
  textAt(x, s, rtl ? left + w - padX : left + padX, top + h / 2 + (family.includes("Tajawal") ? size * 0.08 : size * 0.04), rtl);
  x.textBaseline = "alphabetic";
  if (chevron) {
    const cx = rtl ? left + padX * 0.95 : left + w - padX * 0.95, cy = top + h / 2, k = h * 0.12;
    x.strokeStyle = fg; x.lineWidth = Math.max(3, h * 0.065); x.lineCap = "round"; x.lineJoin = "round";
    x.beginPath();
    if (rtl) { x.moveTo(cx + k * 0.55, cy - k); x.lineTo(cx - k * 0.45, cy); x.lineTo(cx + k * 0.55, cy + k); }
    else { x.moveTo(cx - k * 0.55, cy - k); x.lineTo(cx + k * 0.45, cy); x.lineTo(cx - k * 0.55, cy + k); }
    x.stroke();
  }
  return w;
}

/** Foto mit weich auslaufendem Rand (der Rand ist Hintergrundfarbe, siehe preparePhoto) */
function feathered(img: Image, w: number, h: number): Canvas {
  const c = createCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0, c.width, c.height);
  const f = Math.max(2, Math.min(c.width, c.height) * 0.05);
  x.globalCompositeOperation = "destination-out";
  const side = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = x.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g; x.fillRect(rx, ry, rw, rh);
  };
  side(0, 0, f, 0, 0, 0, f, c.height);
  side(c.width, 0, c.width - f, 0, c.width - f, 0, f, c.height);
  side(0, 0, 0, f, 0, 0, c.width, f);
  side(0, c.height, 0, c.height - f, 0, c.height - f, c.width, f);
  return c;
}

/** Artikelkarte: Foto (eingepasst), Name darunter, rotes Abzeichen „-20%“ in der oberen Ecke (Ende der Leserichtung) */
function productCard(x: Ctx, o: { left: number; top: number; w: number; h: number; photo: PreparedPhoto | null; name: string; badge: string; f: Fonts; rtl: boolean; nameSize: number }) {
  const { left, top, w, h, photo, name, f, rtl, nameSize } = o;
  const radius = Math.min(36, w * 0.08);
  x.save();
  x.shadowColor = "rgba(0,0,0,0.26)"; x.shadowBlur = 36; x.shadowOffsetY = 14;
  x.fillStyle = photo?.bg ?? C.white;
  rr(x, left, top, w, h, radius);
  x.fill();
  x.restore();
  const pad = Math.max(14, Math.min(30, w * 0.06));
  const nameH = name ? nameSize * 2.5 : 0;
  const boxW = w - pad * 2, boxH = h - pad * 2 - nameH;
  if (photo && boxH > 20) {
    const s = Math.min(boxW / photo.img.width, boxH / photo.img.height);
    const iw = photo.img.width * s, ih = photo.img.height * s;
    x.save();
    rr(x, left, top, w, h, radius);
    x.clip();
    x.drawImage(feathered(photo.img, iw, ih), left + (w - iw) / 2, top + pad + (boxH - ih) / 2);
    x.restore();
  }
  if (name) {
    x.fillStyle = C.navy;
    x.font = font(nameSize, f.label);
    x.direction = rtl ? "rtl" : "ltr";
    x.textAlign = "center";
    const lines = wrap(x, name, w - pad * 2, 2);
    const lh = nameSize * 1.12;
    const baseY = top + h - pad - (lines.length - 1) * lh - nameSize * 0.12;
    lines.forEach((l, i) => x.fillText(l, left + w / 2, baseY + i * lh));
  }
  const r = Math.max(28, Math.min(56, w * 0.105));
  const cx = rtl ? left + r + pad * 0.5 : left + w - r - pad * 0.5, cy = top + r + pad * 0.5;
  x.fillStyle = C.red;
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
  x.fillStyle = C.white;
  x.direction = "ltr";
  x.font = font(fit(x, o.badge, FONT.black, r * 0.8, 14, r * 1.55), FONT.black);
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(o.badge, cx, cy + r * 0.05);
  x.textBaseline = "alphabetic";
}

/** große Rabattzahl, „%“ in der Akzentfarbe; y = Oberkante; gibt die Höhe (Versalhöhe) zurück */
function bigDiscount(x: Ctx, s: string, size: number, startX: number, top: number, rtl: boolean, pal: Palette): number {
  x.font = font(size, FONT.black);
  x.direction = "ltr";
  x.textAlign = "left";
  const m = x.measureText(s);
  const cap = m.actualBoundingBoxAscent;
  const left = rtl ? startX - m.width : startX;
  const i = s.lastIndexOf("%");
  const before = s.slice(0, i);
  x.fillStyle = pal.text;
  x.fillText(before, left, top + cap);
  x.fillStyle = pal.accent;
  x.fillText(s.slice(i), left + x.measureText(before).width, top + cap);
  return cap;
}

async function loadLogo(kind: "light" | "dark"): Promise<Image | null> {
  const p = path.join(process.cwd(), "public", "brand", kind === "light" ? "logo-light.png" : "logo.png");
  return fs.existsSync(p) ? loadImage(fs.readFileSync(p)) : null;
}

/** Karten nebeneinander zentriert in einem Bereich; Karten nicht höher als nötig (Foto ≈ quadratisch + Name) */
function cardRow(x: Ctx, o: { l: number; r: number; top: number; bottom: number; photos: (PreparedPhoto | null)[]; names: string[]; badge: string; f: Fonts; rtl: boolean; maxW: number; gap: number }) {
  const n = o.photos.length;
  if (!n) return;
  const areaW = o.r - o.l, areaH = o.bottom - o.top;
  const cw = Math.min(o.maxW, (areaW - o.gap * (n - 1)) / n);
  const nameSize = cw > 420 ? 40 : cw > 320 ? 34 : cw > 240 ? 30 : 26;
  const ch = Math.min(areaH, (cw - 2 * Math.min(30, cw * 0.06)) * 1.08 + nameSize * 2.5 + 2 * Math.min(30, cw * 0.06));
  const total = cw * n + o.gap * (n - 1);
  const start = o.l + (areaW - total) / 2, top = o.top + (areaH - ch) / 2;
  for (let i = 0; i < n; i++) {
    const k = o.rtl ? n - 1 - i : i; // erster Artikel steht am Anfang der Leserichtung
    productCard(x, { left: start + k * (cw + o.gap), top, w: cw, h: ch, photo: o.photos[i], name: o.names[i] ?? "", badge: o.badge, f: o.f, rtl: o.rtl, nameSize });
  }
  return { top, bottom: top + ch };
}

// ───────────────────────── Zeichnen ─────────────────────────

/** Werbebild als WebP */
export async function renderBanner(input: BannerInput): Promise<Buffer> {
  ensureFonts();
  const { w: W, h: H } = BANNER_SIZE[input.format];
  const pal = STYLES[((input.style % BANNER_STYLES) + BANNER_STYLES) % BANNER_STYLES];
  const rtl = input.lang === "ar";
  const fx = FIXED[input.lang];
  const f = fontsFor(input.lang);
  const c = createCanvas(W, H);
  const x = c.getContext("2d");
  const wide = input.format === "wide";
  const logo = wide ? null : await loadLogo(pal.logo); // im Shop steht das Logo schon im Kopf; im Hochformat (zum Teilen) ja

  // Hintergrund: Verlauf + weicher Schein hinter den Artikeln
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, pal.bg[0]); g.addColorStop(1, pal.bg[1]);
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const glowX = wide ? (rtl ? W * 0.3 : W * 0.7) : W / 2, glowY = wide ? H / 2 : H * 0.7;
  const rg = x.createRadialGradient(glowX, glowY, 0, glowX, glowY, wide ? W * 0.4 : H * 0.55);
  rg.addColorStop(0, pal.glow); rg.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = rg; x.fillRect(0, 0, W, H);

  const all = input.photos.length;
  const maxShown = 4;
  const shown = Math.min(all, maxShown);
  const rest = all - shown;
  const photos = input.photos.slice(0, shown);
  const names = input.copy.names.slice(0, shown);
  const badge = badgeText(input.discountBp);
  const big = discountText(input.lang, input.discountBp);
  const sub = input.until ? fx.until(shortDate(input.until)) : input.copy.sub.trim();

  if (wide) {
    const padX = 110, padY = 86;
    const textW = 880;
    const sx = rtl ? W - padX : padX;
    // schräges Streifenband zwischen Text und Artikeln; die schräge Seite läuft nie in den Text
    const bw = 34, slant = 120, gapText = 40;
    const bandX = rtl ? W - padX - textW - gapText - slant : padX + textW + gapText + slant;
    stripeBand(x, rtl
      ? [[bandX - bw, 0], [bandX, 0], [bandX + slant, H], [bandX + slant - bw, H]]
      : [[bandX, 0], [bandX + bw, 0], [bandX + bw - slant, H], [bandX - slant, H]], pal.stripes, 22);

    // Textblock senkrecht mittig: Kicker, Rabatt, Überschrift (≤ 2 Zeilen), Unterzeile, Knopf
    const subSize = 46, kickerH = 64, ctaH = 86;
    x.direction = rtl ? "rtl" : "ltr";
    // Überschrift lieber etwas kleiner in einer Zeile als groß in zwei
    let headSize = 70;
    x.font = font(headSize, f.head);
    if (x.measureText(input.copy.headline.trim()).width > textW) {
      const one = fit(x, input.copy.headline.trim(), f.head, 70, 58, textW);
      x.font = font(one, f.head);
      if (x.measureText(input.copy.headline.trim()).width <= textW) headSize = one;
    }
    x.font = font(headSize, f.head);
    const head = input.copy.headline.trim() ? wrap(x, input.copy.headline, textW, 2) : [];
    const fixedH = kickerH + 30 + 40 + head.length * headSize * 1.1 + (sub ? 20 + subSize : 0) + 44 + ctaH;
    let bigSize = fit(x, big, FONT.black, 330, 150, textW);
    while (bigSize > 150 && fixedH + bigSize * 0.72 > H - padY * 2) bigSize -= 6;
    const block = fixedH + bigSize * 0.72;
    let y = Math.round((H - block) / 2);
    pill(x, fx.kicker, sx, y, kickerH, f.label, 38, pal.kickerBg, pal.kickerText, rtl);
    y += kickerH + 30;
    y += bigDiscount(x, big, bigSize, sx, y, rtl, pal) + 40;
    x.fillStyle = pal.text;
    x.font = font(headSize, f.head);
    for (const l of head) { y += headSize * 1.02; textAt(x, l, sx, y, rtl); y += headSize * 0.08; }
    if (sub) {
      y += 20 + subSize * 0.86;
      x.fillStyle = pal.muted;
      x.font = font(subSize, f.body);
      textAt(x, wrap(x, sub, textW, 1)[0], sx, y, rtl);
      y += subSize * 0.14;
    }
    y += 44;
    pill(x, fx.cta, sx, y, ctaH, f.label, 40, pal.ctaBg, pal.ctaText, rtl, true);

    // Artikel
    const l = rtl ? 80 : bandX + bw + 40, r = rtl ? bandX - bw - 40 : W - 80;
    const moreH = rest > 0 ? 64 : 0;
    const row = cardRow(x, { l, r, top: 64, bottom: H - 64 - (moreH ? moreH + 22 : 0), photos, names, badge, f, rtl, maxW: shown === 1 ? 600 : 500, gap: 32 });
    if (row && rest > 0) {
      const label = fx.more(rest);
      x.font = font(34, f.label);
      const pw = x.measureText(label).width + 64 * 0.8;
      pill(x, label, rtl ? (l + r) / 2 + pw / 2 : (l + r) / 2 - pw / 2, row.bottom + 22, moreH, f.label, 34, pal.ctaBg, pal.ctaText, rtl);
    }
  } else {
    const pad = 76;
    const sx = rtl ? W - pad : pad;
    const ex = rtl ? pad : W - pad; // Ende der Zeile
    // Streifen in der oberen Ecke am Ende der Leserichtung
    const bx = rtl ? 0 : W - 340;
    stripeBand(x, rtl ? [[0, 0], [270, 0], [330, 40], [60, 40]] : [[bx + 70, 0], [bx + 340, 0], [bx + 280, 40], [bx, 40]], pal.stripes, 18);
    // Kopfzeile: Logo am Anfang, Kicker am Ende
    let y = 74;
    const kickerH = 58;
    if (logo) {
      const lh = 62, lw = (logo.width / logo.height) * lh;
      x.drawImage(logo, rtl ? sx - lw : sx, y + (kickerH - lh) / 2, lw, lh);
      x.font = font(34, f.label);
      pill(x, fx.kicker, rtl ? ex + x.measureText(fx.kicker).width + kickerH * 0.8 : ex - x.measureText(fx.kicker).width - kickerH * 0.8, y, kickerH, f.label, 34, pal.kickerBg, pal.kickerText, rtl);
    } else {
      pill(x, fx.kicker, sx, y, kickerH, f.label, 34, pal.kickerBg, pal.kickerText, rtl);
    }
    y += kickerH + 40;
    const bigSize = Math.min(250, fit(x, big, FONT.black, 250, 140, W - pad * 2));
    y += bigDiscount(x, big, bigSize, sx, y, rtl, pal) + 34;
    const headSize = 58;
    x.fillStyle = pal.text;
    x.font = font(headSize, f.head);
    const head = input.copy.headline.trim() ? wrap(x, input.copy.headline, W - pad * 2, 2) : [];
    for (const l of head) { y += headSize * 1.02; textAt(x, l, sx, y, rtl); y += headSize * 0.08; }
    if (sub) {
      y += 14 + 40 * 0.86;
      x.fillStyle = pal.muted;
      x.font = font(40, f.body);
      textAt(x, wrap(x, sub, W - pad * 2, 1)[0], sx, y, rtl);
    }
    // Knopf unten, daneben „+n weitere“
    const ctaH = 82, ctaTop = H - pad - ctaH;
    const ctaW = pill(x, fx.cta, sx, ctaTop, ctaH, f.label, 38, pal.ctaBg, pal.ctaText, rtl, true);
    if (rest > 0) pill(x, fx.more(rest), rtl ? sx - ctaW - 18 : sx + ctaW + 18, ctaTop + 9, ctaH - 18, f.label, 32, pal.moreBg, pal.text, rtl);
    // Artikel zwischen Text und Knopf
    const top = y + 44, bottom = ctaTop - 36, gap = 24;
    if (shown === 3) {
      // erster Artikel groß oben, zwei darunter
      const h1 = (bottom - top - gap) * 0.56;
      productCard(x, { left: pad, top, w: W - pad * 2, h: h1, photo: photos[0], name: names[0] ?? "", badge, f, rtl, nameSize: 36 });
      const cw = (W - pad * 2 - gap) / 2;
      for (const i of [1, 2]) {
        const k = rtl ? 2 - i : i - 1;
        productCard(x, { left: pad + k * (cw + gap), top: top + h1 + gap, w: cw, h: bottom - top - h1 - gap, photo: photos[i], name: names[i] ?? "", badge, f, rtl, nameSize: 30 });
      }
    } else if (shown === 4) {
      const cw = (W - pad * 2 - gap) / 2, ch = (bottom - top - gap) / 2;
      for (let i = 0; i < 4; i++) {
        const col = rtl ? 1 - (i % 2) : i % 2, row = Math.floor(i / 2);
        productCard(x, { left: pad + col * (cw + gap), top: top + row * (ch + gap), w: cw, h: ch, photo: photos[i], name: names[i] ?? "", badge, f, rtl, nameSize: 30 });
      }
    } else {
      cardRow(x, { l: pad, r: W - pad, top, bottom, photos, names, badge, f, rtl, maxW: W, gap });
    }
  }
  // feine Markenlinie unten (Blau/Rot wie im Logo; RTL gespiegelt)
  const lh = wide ? 12 : 10;
  x.fillStyle = rtl ? C.red : C.blue; x.fillRect(0, H - lh, W / 2, lh);
  x.fillStyle = rtl ? C.blue : C.red; x.fillRect(W / 2, H - lh, W / 2, lh);

  return sharp(c.toBuffer("image/png")).webp({ quality: 88 }).toBuffer();
}
