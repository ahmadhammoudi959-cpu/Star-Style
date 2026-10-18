/**
 * Kontenzuordnung für den DATEV-Export (SKR03 / SKR04).
 * Alle Konten können in den Einstellungen überschrieben werden (z. B. auf Wunsch des Steuerberaters).
 * Automatikkonten (AM/AV) rechnen die Steuer selbst heraus – dort darf KEIN Steuerschlüssel mitgegeben werden.
 */
export type Chart = "SKR03" | "SKR04";
export type ExpenseCategory =
  | "GOODS" | "MARKETING" | "ADVERTISING" | "STORE_SUPPLIES" | "SHIPPING" | "RENT" | "SHOP_FEES" | "SOFTWARE" | "OTHER"
  | "PACKAGING" | "VEHICLE" | "INSURANCE" | "PHONE_INTERNET" | "BANK_FEES" | "CONSULTING";
export type ExpenseTaxCase = "DOMESTIC" | "EU_SERVICE" | "NON_EU_SERVICE" | "EU_GOODS" | "NO_VAT";
export type PayMethod = "CASH" | "BANK" | "CARD" | "ONLINE";

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  "GOODS", "ADVERTISING", "MARKETING", "SHOP_FEES", "SHIPPING", "PACKAGING", "SOFTWARE", "PHONE_INTERNET",
  "RENT", "STORE_SUPPLIES", "VEHICLE", "INSURANCE", "BANK_FEES", "CONSULTING", "OTHER",
];

type Def = { label: string; SKR03: number; SKR04: number; auto?: boolean };

/** Standard-Konten. Schlüssel = interner Name, label = Bezeichnung für die Einstellungen. */
export const ACCOUNT_DEFS = {
  // Geld
  bank: { label: "Bank", SKR03: 1200, SKR04: 1800 },
  cash: { label: "Kasse", SKR03: 1000, SKR04: 1600 },
  transit: { label: "Geldtransit (Karte / Online)", SKR03: 1360, SKR04: 1460 },
  // Erlöse
  rev19: { label: "Erlöse 19 % USt", SKR03: 8400, SKR04: 4400, auto: true },
  rev7: { label: "Erlöse 7 % USt", SKR03: 8300, SKR04: 4300, auto: true },
  rev0: { label: "Erlöse ohne USt", SKR03: 8200, SKR04: 4200 },
  revIgl: { label: "Steuerfreie innergemeinschaftliche Lieferungen § 4 Nr. 1b UStG", SKR03: 8125, SKR04: 4125, auto: true },
  revExport: { label: "Steuerfreie Ausfuhrlieferungen § 4 Nr. 1a UStG", SKR03: 8120, SKR04: 4120, auto: true },
  revOss: { label: "Erlöse aus im anderen EU-Land steuerpflichtigen Lieferungen (OSS)", SKR03: 8320, SKR04: 4320, auto: true },
  // Wareneinkauf (Automatikkonten)
  goods19: { label: "Wareneingang 19 % Vorsteuer", SKR03: 3400, SKR04: 5400, auto: true },
  goods7: { label: "Wareneingang 7 % Vorsteuer", SKR03: 3300, SKR04: 5300, auto: true },
  goods0: { label: "Wareneingang ohne Vorsteuer", SKR03: 3200, SKR04: 5200 },
  goodsIge19: { label: "Innergemeinschaftlicher Erwerb 19 % VSt und 19 % USt", SKR03: 3425, SKR04: 5425, auto: true },
  goodsIge7: { label: "Innergemeinschaftlicher Erwerb 7 % VSt und 7 % USt", SKR03: 3420, SKR04: 5420, auto: true },
  // Kosten
  exp_ADVERTISING: { label: "Werbekosten (Anzeigen)", SKR03: 4600, SKR04: 6600 },
  exp_MARKETING: { label: "Werbekosten (Agentur)", SKR03: 4600, SKR04: 6600 },
  exp_SHOP_FEES: { label: "Nebenkosten des Geldverkehrs (Shop- und Zahlungsgebühren)", SKR03: 4970, SKR04: 6855 },
  exp_SHIPPING: { label: "Ausgangsfrachten", SKR03: 4730, SKR04: 6740 },
  exp_PACKAGING: { label: "Verpackungsmaterial", SKR03: 4710, SKR04: 6710 },
  exp_SOFTWARE: { label: "Wartungskosten für Hard- und Software", SKR03: 4806, SKR04: 6495 },
  exp_PHONE_INTERNET: { label: "Telefon / Internet", SKR03: 4920, SKR04: 6805 },
  exp_RENT: { label: "Miete", SKR03: 4210, SKR04: 6310 },
  exp_STORE_SUPPLIES: { label: "Bürobedarf", SKR03: 4930, SKR04: 6815 },
  exp_VEHICLE: { label: "Laufende Kfz-Betriebskosten", SKR03: 4530, SKR04: 6530 },
  exp_INSURANCE: { label: "Versicherungen", SKR03: 4360, SKR04: 6400 },
  exp_BANK_FEES: { label: "Nebenkosten des Geldverkehrs", SKR03: 4970, SKR04: 6855 },
  exp_CONSULTING: { label: "Rechts- und Beratungskosten", SKR03: 4950, SKR04: 6825 },
  exp_OTHER: { label: "Sonstige betriebliche Aufwendungen", SKR03: 4900, SKR04: 6300 },
  // Personenkonten (Startnummer, + Kunden- bzw. Lieferantennummer)
  debitorBase: { label: "Debitoren ab", SKR03: 10000, SKR04: 10000 },
  creditorBase: { label: "Kreditoren ab", SKR03: 70000, SKR04: 70000 },
} satisfies Record<string, Def>;

export type AccountKey = keyof typeof ACCOUNT_DEFS;
export type AccountMap = Record<AccountKey, number>;

export function accountMap(chart: Chart, overrides: Partial<Record<string, number>> = {}): AccountMap {
  const out = {} as AccountMap;
  for (const [k, d] of Object.entries(ACCOUNT_DEFS) as [AccountKey, Def][]) {
    const o = overrides[k];
    out[k] = typeof o === "number" && Number.isInteger(o) && o > 0 ? o : d[chart];
  }
  return out;
}

/** Steuerschlüssel (klassische DATEV-BU-Schlüssel) */
export const BU = { VST19: "9", VST7: "8", RC19: "94", RC7: "91", IGE19: "19", IGE7: "18" } as const;

export const moneyAccount = (m: AccountMap, method: PayMethod | null | undefined) =>
  method === "CASH" ? m.cash : method === "BANK" ? m.bank : m.transit;

/** Konto + Steuerschlüssel für eine Eingangsrechnung */
export function expenseAccount(m: AccountMap, category: ExpenseCategory, taxCase: ExpenseTaxCase, rateBp: number): { account: number; bu: string } {
  if (category === "GOODS") {
    if (taxCase === "DOMESTIC") return rateBp === 1900 ? { account: m.goods19, bu: "" } : rateBp === 700 ? { account: m.goods7, bu: "" } : { account: m.goods0, bu: "" };
    if (taxCase === "EU_GOODS") return { account: rateBp === 700 ? m.goodsIge7 : m.goodsIge19, bu: "" };
    return { account: m.goods0, bu: "" };
  }
  const account = m[`exp_${category}` as AccountKey];
  switch (taxCase) {
    case "DOMESTIC": return { account, bu: rateBp === 1900 ? BU.VST19 : rateBp === 700 ? BU.VST7 : "" };
    case "EU_SERVICE":
    case "NON_EU_SERVICE": return { account, bu: rateBp === 700 ? BU.RC7 : BU.RC19 };
    case "EU_GOODS": return { account, bu: rateBp === 700 ? BU.IGE7 : BU.IGE19 };
    default: return { account, bu: "" };
  }
}

export type InvoiceTaxMode = "DOMESTIC" | "EU_REVERSE_CHARGE" | "EU_PENDING_VATID" | "EU_B2C" | "EXPORT";

/** Erlöskonto für eine Steuersatz-Gruppe einer Ausgangsrechnung */
export function revenueAccount(m: AccountMap, taxMode: InvoiceTaxMode, rateBp: number, ossCountry: string | null): number {
  if (taxMode === "EU_REVERSE_CHARGE") return m.revIgl;
  if (taxMode === "EXPORT") return m.revExport;
  if (taxMode === "EU_B2C" && ossCountry) return m.revOss;
  return rateBp === 1900 ? m.rev19 : rateBp === 700 ? m.rev7 : m.rev0;
}

/** Ist der Steuerfall ein Reverse-Charge-/Erwerbsfall (Steuer schuldet der Empfänger, Vorsteuer gleich hoch)? */
export const isSelfAssessed = (c: ExpenseTaxCase) => c === "EU_SERVICE" || c === "NON_EU_SERVICE" || c === "EU_GOODS";

/** Beträge einer Eingangsrechnung aus der Eingabe berechnen (rein, getestet). */
export function expenseAmounts(taxCase: ExpenseTaxCase, amountCents: number, rateBp: number) {
  if (taxCase === "DOMESTIC") {
    const net = Math.round((amountCents * 10000) / (10000 + rateBp));
    return { netCents: net, vatCents: amountCents - net, grossCents: amountCents, selfAssessedVatCents: 0 };
  }
  const selfAssessed = isSelfAssessed(taxCase) ? Math.round((amountCents * rateBp) / 10000) : 0;
  return { netCents: amountCents, vatCents: 0, grossCents: amountCents, selfAssessedVatCents: selfAssessed };
}

/** Vorschlag für den Steuerfall nach Land und Kategorie */
export const EU_COUNTRIES = ["AT", "BE", "BG", "CY", "CZ", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];
export function suggestTaxCase(country: string, category: ExpenseCategory): ExpenseTaxCase {
  const c = country.toUpperCase();
  if (c === "DE") return category === "INSURANCE" || category === "BANK_FEES" ? "NO_VAT" : "DOMESTIC";
  if (EU_COUNTRIES.includes(c)) return category === "GOODS" || category === "PACKAGING" || category === "STORE_SUPPLIES" ? "EU_GOODS" : "EU_SERVICE";
  return category === "GOODS" ? "NO_VAT" : "NON_EU_SERVICE";
}
