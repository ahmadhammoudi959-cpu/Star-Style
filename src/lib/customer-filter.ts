/**
 * Kundenliste: Zeilen + Filter (Suche, Stadt, Steuer, Preisgruppe, Herkunft). Rein – dieselbe Logik für die Seite /customers
 * und die Excel-Liste /api/customers/export (Wunsch Inhaber 13.11.2026), damit die Datei genau das enthält, was man sieht.
 * Laden aus der Datenbank: ./customer-list.ts. Getestet in tests/customer-export.test.ts.
 */
import type { TaxMode } from "./tax";

export type PriceGroup = "WHOLESALE" | "RETAIL";
export type ShopCh = "GENERAL_SHOP" | "BRAND_SHOP";
/** „neu aus dem Shop“ = in den letzten 7 Tagen vom Shop angelegt (Startseite zeigt dieselbe Zahl) */
export const NEW_DAYS = 7;

export type CustomerRow = {
  id: string; number: number; type: "COMPANY" | "PERSON"; name: string; contact: string; email: string; phone: string;
  street: string; zip: string; city: string; country: string; vatId: string; group: PriceGroup; mode: TaxMode;
  /** Herkunft: null = im System angelegt, sonst der Shop, aus dem er kam (ändert sich nie) */
  fromShop: ShopCh | null;
  /** Shops, in denen er ein Konto hat oder bestellt hat (auch bei im System angelegten Kunden, z. B. Großhandel) */
  shops: ShopCh[]; isNew: boolean; createdDay: string;
};

export type CustomerFilter = { q?: string; city?: string; tax?: string; group?: string; src?: string };

/** Nur die bekannten Filter, jeweils höchstens 200 Zeichen (Adresszeile → Filter) */
export function readFilter(get: (k: string) => string | null | undefined): CustomerFilter {
  const v = (k: string) => String(get(k) ?? "").slice(0, 200);
  return { q: v("q"), city: v("city"), tax: v("tax"), group: v("group"), src: v("src") };
}

/** Name ist nur ein Platzhalter (bei Anmeldung im Shop nur mit E-Mail steht die E-Mail als Name da) */
export const nameIsEmail = (r: Pick<CustomerRow, "name" | "email">) => !r.name.trim() || (!!r.email && r.name.trim().toLowerCase() === r.email.trim().toLowerCase());

/**
 * Herkunft-Filter (Wunsch Inhaber 13.11.2026: System und Shops getrennt): system = im System angelegt, shops = aus einem der Shops,
 * GENERAL_SHOP/BRAND_SHOP = aus diesem Shop, new = in den letzten 7 Tagen aus einem Shop; shop (ältere Links) = mit Shop-Konto/-Bestellung
 */
export const ORIGIN_FILTERS = ["system", "shops", "GENERAL_SHOP", "BRAND_SHOP", "new"] as const;
function originOk(r: CustomerRow, src: string) {
  switch (src) {
    case "": return true;
    case "system": return r.fromShop === null;
    case "shops": return r.fromShop !== null;
    case "GENERAL_SHOP": case "BRAND_SHOP": return r.fromShop === src;
    case "new": return r.isNew;
    case "shop": return r.shops.length > 0;
    default: return true;
  }
}

/** Ohne Herkunft-Filter zeigt die Liste zwei Teile: im System angelegt, dann aus den Shops (je nach Name sortiert wie geladen) */
export function splitByOrigin(rows: CustomerRow[]) {
  return { system: rows.filter((r) => r.fromShop === null), shops: rows.filter((r) => r.fromShop !== null) };
}

export function filterCustomerRows(rows: CustomerRow[], f: CustomerFilter): CustomerRow[] {
  const s = (f.q ?? "").trim().toLowerCase();
  const { city = "", tax = "", group = "", src = "" } = f;
  const srcOk = (r: CustomerRow) => originOk(r, src);
  return rows.filter((r) => (!city || r.city === city) && (!tax || r.mode === tax) && (!group || r.group === group) && srcOk(r)
    && (!s || [r.name, r.city, r.vatId, r.email].some((x) => x.toLowerCase().includes(s)) || String(r.number) === s));
}

/** Adresszeile der Excel-Liste: nur gesetzte Filter */
export function filterQuery(f: CustomerFilter): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v && v.trim()) p.set(k, v);
  return p.toString();
}
