/** Texte und Farben für den Stand einer Aktion (Liste, Seite, Startseite) – rein, auch im Browser */
import type { Dict } from "@/i18n/de";
import type { PhaseState } from "@/lib/promo-rules";
import { formatDate } from "@/lib/dates";

export type PromoT = Dict["promo"];
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** kurz (Abzeichen): „läuft bis 24.11.2026“ */
export function phaseLabel(T: PromoT, s: PhaseState, w: { from: string | null; until: string | null }, intl: string): string {
  if (s === "scheduled") return fill(T.state.scheduled, { d: formatDate(w.from, intl) });
  if (s === "active") return w.until ? fill(T.state.activeUntil, { d: formatDate(w.until, intl) }) : T.state.active;
  return T.state[s];
}

/** Satz (Karte „Rabatt“ / „Bild im Shop“) */
export function phaseSentence(texts: PromoT["priceState"], s: PhaseState, w: { from: string | null; until: string | null }, intl: string): string {
  if (s === "scheduled") return fill(texts.scheduled, { d: formatDate(w.from, intl) });
  if (s === "active") return w.until ? fill(texts.activeUntil, { d: formatDate(w.until, intl) }) : texts.active;
  if (s === "over") return fill(texts.over, { d: formatDate(w.until, intl) });
  return texts.off;
}

export const PHASE_TONE: Record<PhaseState, string> = {
  off: "bg-slate-100 text-slate-600",
  scheduled: "bg-amber-50 text-amber-800 ring-1 ring-amber-200",
  active: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  over: "bg-slate-100 text-slate-500",
};
