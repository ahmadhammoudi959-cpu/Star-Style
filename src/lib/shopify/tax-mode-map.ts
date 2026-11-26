/**
 * Preise im Shop mit oder ohne MwSt. – reine Regeln (getestet), Ablauf in ./tax-mode.ts.
 */
export type TaxModeAction = "store" | "repush" | "none";

/** null = noch nie gesehen → nur merken (beim ersten Lauf nichts umrechnen); anders als gemerkt → alle Preise neu */
export function taxModeAction(stored: boolean | null | undefined, current: boolean): TaxModeAction {
  if (stored == null) return "store";
  return stored === current ? "none" : "repush";
}

export const shopConfigured = (s: { domain: string; clientSecretEnc: string; staticTokenEnc: string } | undefined) =>
  Boolean(s?.domain && (s.clientSecretEnc || s.staticTokenEnc));

/** Zeigen die Shops Nettopreise (MwSt. erst an der Kasse)? Für die Hinweise im Artikel-Formular. */
export function shopsShowNet(shops: { taxesIncluded: boolean | null; domain: string; clientSecretEnc: string; staticTokenEnc: string }[]): boolean {
  return shops.some((s) => shopConfigured(s) && s.taxesIncluded === false);
}
