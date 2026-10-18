/** ISO-Datum (YYYY-MM-DD) in Europe/Berlin */
export function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
}
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function formatDate(iso: string | null | undefined, locale = "de-DE"): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso);
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" }).format(d);
}
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(toIso + "T12:00:00Z").getTime() - new Date(fromIso + "T12:00:00Z").getTime()) / 86400000);
}
