/**
 * Aktionen – reine Regeln (getestet in tests/promotions.test.ts), ohne Datenbank, auch im Browser benutzbar.
 * Rabatt und Werbebild haben je ein Zeitfenster: an/aus + optional von/bis (Berliner Datum YYYY-MM-DD, beide Tage inklusive).
 */

/** Wo der Rabatt gilt (Wunsch Inhaber 19.11.2026: „بالاربع جهات“) */
export const PROMO_PLACES = ["SYSTEM", "DIRECT", "GENERAL_SHOP", "BRAND_SHOP"] as const;
export type PromoPlace = (typeof PROMO_PLACES)[number];
export const PROMO_SHOPS = ["GENERAL_SHOP", "BRAND_SHOP"] as const;
export type PromoShop = (typeof PROMO_SHOPS)[number];
export const BANNER_PLACES = ["top", "below"] as const;
export type BannerPlace = (typeof BANNER_PLACES)[number];
/** Rabatt in ganzen Prozent */
export const MIN_PERCENT = 1, MAX_PERCENT = 90;
/** höchstens so viele Artikel je Aktion (Bild zeigt 4, die Kollektion „Angebote“ alle) */
export const MAX_ITEMS = 200;

export const isPlace = (x: string): x is PromoPlace => (PROMO_PLACES as readonly string[]).includes(x);
export const isShop = (x: string): x is PromoShop => (PROMO_SHOPS as readonly string[]).includes(x);

export type Window = { on: boolean; from: string | null; until: string | null };
/** off = ausgeschaltet, scheduled = startet erst am „von“-Tag, active = läuft, over = „bis“-Tag vorbei */
export type PhaseState = "off" | "scheduled" | "active" | "over";

export function phaseState(w: Window, today: string, ended = false): PhaseState {
  if (ended || !w.on) return "off";
  if (w.until && w.until < today) return "over";
  if (w.from && w.from > today) return "scheduled";
  return "active";
}
export const isActive = (w: Window, today: string, ended = false) => phaseState(w, today, ended) === "active";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: string) => ISO.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`)) && new Date(`${s}T12:00:00Z`).toISOString().slice(0, 10) === s;

/** Zeitfenster prüfen: Datum gültig, „bis“ nicht vor „von“. Ein „bis“ in der Vergangenheit ist erlaubt (= schon vorbei). */
export function windowProblem(from: string | null, until: string | null): "date" | "order" | null {
  if ((from && !isIsoDate(from)) || (until && !isIsoDate(until))) return "date";
  if (from && until && until < from) return "order";
  return null;
}

/** Tage zu einem Datum addieren (YYYY-MM-DD, ohne Zeitzonen-Fallen) */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** „Verlängern um n Tage“: vom bisherigen Ende aus, oder von heute, wenn es schon vorbei ist bzw. keins hatte */
export function extendUntil(until: string | null, today: string, days: number): string {
  const base = until && until >= today ? until : today;
  return addDays(base, days);
}

/** Prozent → Basispunkte, nur ganze Prozent im erlaubten Bereich, sonst null */
export function percentToBp(input: string | number): number | null {
  const s = String(input).trim().replace(/%$/, "").trim().replace(",", ".");
  if (!/^\d{1,2}(\.0+)?$/.test(s)) return null;
  const v = Math.round(Number(s));
  return v >= MIN_PERCENT && v <= MAX_PERCENT ? v * 100 : null;
}
export const bpToWholePercent = (bp: number) => Math.round(bp / 100);

/** Preis nach Rabatt, kaufmännisch auf Cent gerundet */
export const discounted = (cents: number, bp: number) => Math.round((cents * (10000 - bp)) / 10000);

/** So rechnet das Theme das Abzeichen „-20%“ aus Streichpreis und Preis (Liquid: … | times: 100.0 | divided_by: … | round) */
export const percentOff = (compareCents: number, priceCents: number) =>
  compareCents > 0 ? Math.round(((compareCents - priceCents) * 100) / compareCents) : 0;

/** Mehrere Aktionen auf demselben Artikel: der höchste Rabatt gilt */
export function bestDiscounts(rows: { productId: string; bp: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) if (r.bp > (out.get(r.productId) ?? 0)) out.set(r.productId, r.bp);
  return out;
}

// ───────────────────────── Werbebild im Shop ─────────────────────────

export type BannerCandidate = { id: string; shops: string[]; place: BannerPlace; startedAt: number; active: boolean; ready: boolean };

/**
 * Welche Aktion zeigt ihr Bild wo in diesem Shop? Je Platz (über/unter dem Hero) genau eine: die zuletzt eingeschaltete
 * unter den laufenden mit fertigem Bild; die anderen warten, bis der Platz frei wird.
 */
export function bannerSlots(cands: BannerCandidate[], shop: string): Record<BannerPlace, string | null> {
  const out: Record<BannerPlace, string | null> = { top: null, below: null };
  for (const place of BANNER_PLACES) {
    const win = cands.filter((c) => c.active && c.ready && c.place === place && c.shops.includes(shop))
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))[0];
    out[place] = win?.id ?? null;
  }
  return out;
}

export const BANNER_LANGS = ["de", "en", "ar", "nl"] as const;
export type SlotData = {
  id: string; pct: number; until: string | null;
  /** Ziel beim Antippen: Kollektion „Angebote“ oder bei genau einem Artikel dessen Seite (Handle im Shop) */
  product: string | null;
  img: Record<string, { w: string; t: string }>;
  alt: Record<string, string>;
};

/**
 * Inhalt des Metafelds star_style.banner an der Kollektion „Angebote“ (liest das Theme, Abschnitt star-promo).
 * Feste Reihenfolge der Schlüssel → derselbe Stand ergibt genau denselben Text (geschrieben wird nur bei Änderung).
 */
export function bannerJson(slots: Partial<Record<BannerPlace, SlotData | null>>): string {
  const slot = (s: SlotData | null | undefined) => s ? {
    id: s.id, pct: s.pct, until: s.until ?? "", product: s.product ?? "",
    img: Object.fromEntries(BANNER_LANGS.filter((l) => s.img[l]).map((l) => [l, { w: s.img[l].w, t: s.img[l].t }])),
    alt: Object.fromEntries(BANNER_LANGS.filter((l) => s.alt[l]).map((l) => [l, s.alt[l]])),
  } : null;
  return JSON.stringify({ v: 1, top: slot(slots.top), below: slot(slots.below) });
}

/** Alt-Text des Bilds je Sprache (Barrierefreiheit; steht nicht im Bild selbst) */
export function bannerAlt(lang: string, pct: number, headline: string): string {
  const h = headline.trim();
  const base = lang === "ar" ? `خصم ${pct}%` : lang === "en" ? `${pct}% off` : lang === "nl" ? `${pct}% korting` : `${pct} % Rabatt`;
  return h ? `${base}: ${h}` : base;
}
