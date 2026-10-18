import "server-only";
import { cookies } from "next/headers";
import de, { type Dict } from "./de";
import ar from "./ar";
import en from "./en";

export const LOCALES = ["de", "ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_COOKIE = "ss_lang";
const DICTS: Record<Locale, Dict> = { de, ar, en };

// Zahlen, Beträge und Datumsangaben überall im deutschen Format (Euro-Firma in Deutschland, lateinische Ziffern)
export const INTL_LOCALE: Record<Locale, string> = { de: "de-DE", ar: "de-DE", en: "de-DE" };

export async function getLocale(): Promise<Locale> {
  const c = await cookies();
  const v = c.get(LOCALE_COOKIE)?.value as Locale | undefined;
  return v && LOCALES.includes(v) ? v : "de";
}

export async function getI18n() {
  const locale = await getLocale();
  return { locale, t: DICTS[locale], dir: locale === "ar" ? ("rtl" as const) : ("ltr" as const), intl: INTL_LOCALE[locale] };
}

export function fill(s: string, vars: Record<string, string | number>) {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}
export type { Dict };
