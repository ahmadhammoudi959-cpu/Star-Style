/**
 * Namen der Sprachen in Auswahlfeldern (Sprachwahl, Mitarbeiter, Bestell-Link …).
 * Arabisch steht in lateinischer Schrift „Arabic“ (Wunsch Inhaber 19.11.2026: „ما بدي الكلمه العربيه تكون بالعربي“ –
 * im System, auf dem Bestell-Link und in beiden Shops gleich); die anderen in ihrer eigenen Sprache.
 */
export const LANG_NAMES = { de: "Deutsch", ar: "Arabic", en: "English", ku: "Kurdî" } as const;
export type LangCode = keyof typeof LANG_NAMES;
/** Sprache des angezeigten Namens (für das lang-Attribut / Vorlesen): „Arabic“ ist Englisch */
export const LANG_NAME_TAG: Record<LangCode, string> = { de: "de", ar: "en", en: "en", ku: "ku" };
