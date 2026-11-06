import { EU_COUNTRIES } from "./accounts";

/** Länder im Ausgaben-Formular: Deutschland, EU, häufige Drittländer. */
export const EXPENSE_COUNTRIES = ["DE", ...EU_COUNTRIES, "CH", "GB", "US", "TR", "CN", "AE", "NO"];

/**
 * Ländernamen in der Sprache der Oberfläche – nur auf dem Server berechnen und als Liste weitergeben.
 * Node hat alle Sprachdaten (z. B. Kurdisch „Almanya“), Chrome nicht (dort „Deutschland“): im Browser
 * berechnet stünden im Server-HTML andere Namen als nach dem Laden (React-Fehler #418). Fehlt eine
 * Sprache, gelten die deutschen Namen.
 */
export function regionOptions(locale: string, codes: readonly string[] = EXPENSE_COUNTRIES) {
  let dn: Intl.DisplayNames | null = null;
  try { dn = new Intl.DisplayNames([locale, "de"], { type: "region" }); } catch { /* unbekannte Sprache */ }
  return codes.map((code) => ({ code, name: dn?.of(code) ?? code }));
}
export type RegionOption = ReturnType<typeof regionOptions>[number];
