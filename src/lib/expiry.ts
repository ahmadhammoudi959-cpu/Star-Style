import { addDaysIso, daysBetween } from "./dates";

/**
 * Haltbarkeit (MHD) – überall gleich (Startseite, Lagerliste, Chargen, Filter; Wunsch Inhaber 12.11.2026):
 * - „abgelaufen“ = MHD vor heute (am MHD selbst ist die Ware noch gut)
 * - „läuft bald ab“ = MHD heute bis in EXPIRY_SOON_DAYS Tagen
 * Gezählt werden nur Chargen mit Restmenge (qty_left > 0). „Heute“ ist immer das Datum in Europe/Berlin (todayIso),
 * auch in SQL – nie current_date (die Datenbank läuft in UTC).
 */
export const EXPIRY_SOON_DAYS = 60;

export type ExpiryState = "expired" | "soon" | "ok";
export type ExpiryFilter = "soon" | "expired";

export function expiryState(today: string, expiry: string): ExpiryState {
  const d = daysBetween(today, expiry);
  return d < 0 ? "expired" : d <= EXPIRY_SOON_DAYS ? "soon" : "ok";
}

/** letzter Tag, der noch als „läuft bald ab“ zählt */
export function soonUntil(today: string): string {
  return addDaysIso(today, EXPIRY_SOON_DAYS);
}

/** Wert aus der Adresse (?exp=) → Filter, alles andere = kein Filter */
export function parseExpiryFilter(v: string | undefined | null): ExpiryFilter | null {
  return v === "soon" || v === "expired" ? v : null;
}

/** Farbe des MHD-Abzeichens: rot = abgelaufen, orange = läuft bald ab, blau = noch lange gut */
export const EXPIRY_BADGE: Record<ExpiryState, string> = {
  expired: "bg-red-100 text-red-800",
  soon: "bg-orange-100 text-orange-800",
  ok: "bg-brand-50 text-brand-700",
};
