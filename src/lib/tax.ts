/**
 * Steuer- und Summenlogik. Reine Funktionen – keine Datenbank, vollständig getestet.
 * Geld in Cent, Prozent in Basispunkten.
 */
import { applyBp } from "./money";

export const EU_COUNTRIES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE",
  "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
] as const;

/**
 * Normalsätze der EU-Länder für OSS (Stand Okt. 2026, Basispunkte).
 * Vor Nutzung des OSS-Verfahrens vom Steuerberater bestätigen lassen.
 */
export const EU_STANDARD_RATES_BP: Record<string, number> = {
  AT: 2000, BE: 2100, BG: 2000, CY: 1900, CZ: 2100, DE: 1900, DK: 2500, EE: 2400, ES: 2100, FI: 2550, FR: 2000,
  GR: 2400, HR: 2500, HU: 2700, IE: 2300, IT: 2200, LT: 2100, LU: 1700, LV: 2100, MT: 1800, NL: 2100, PL: 2300,
  PT: 2300, RO: 2100, SE: 2500, SI: 2200, SK: 2300,
};

export const OSS_THRESHOLD_CENTS = 10_000_00;

export type TaxMode = "DOMESTIC" | "EU_REVERSE_CHARGE" | "EU_PENDING_VATID" | "EU_B2C" | "EXPORT";
export type VatIdStatus = "NONE" | "PENDING" | "VALID" | "INVALID";

export function isEu(country: string) {
  return (EU_COUNTRIES as readonly string[]).includes(country.toUpperCase());
}

/** Welche Steuerbehandlung gilt für diesen Kunden? */
export function determineTaxMode(c: { type: "COMPANY" | "PERSON"; country: string; vatIdStatus: VatIdStatus }): TaxMode {
  const country = c.country.toUpperCase();
  if (country === "DE") return "DOMESTIC";
  if (!isEu(country)) return "EXPORT";
  if (c.type === "COMPANY") {
    if (c.vatIdStatus === "VALID") return "EU_REVERSE_CHARGE";
    if (c.vatIdStatus === "PENDING") return "EU_PENDING_VATID";
  }
  return "EU_B2C";
}

/** Steuersatz einer Position je nach Steuerbehandlung. */
export function effectiveRateBp(mode: TaxMode, productRateBp: number, opts: { country: string; ossExceeded: boolean }): number {
  switch (mode) {
    case "EU_REVERSE_CHARGE":
    case "EXPORT":
      return 0;
    case "EU_B2C":
      return opts.ossExceeded ? EU_STANDARD_RATES_BP[opts.country.toUpperCase()] ?? productRateBp : productRateBp;
    default:
      return productRateBp;
  }
}

export type LineIn = { qty: number; unitPriceCents: number; discountBp: number; vatRateBp: number };
export type LineOut = LineIn & { grossLineCents: number; netCents: number; vatCents: number };
export type Totals = {
  lines: LineOut[];
  subtotalCents: number;    // Summe der Positionen nach Positionsrabatt, vor Gesamtrabatt
  discountCents: number;    // Gesamtrabatt in Cent
  netCents: number;
  vatByRate: { rateBp: number; netCents: number; vatCents: number }[];
  vatCents: number;
  grossCents: number;
};

/**
 * Summen nach deutscher Praxis:
 * Positionsbetrag = Menge × Preis − Positionsrabatt; Gesamtrabatt anteilig auf jede Position,
 * USt je Steuersatz auf die Nettosumme dieses Satzes (eine Rundung pro Satz).
 */
export function computeTotals(lines: LineIn[], documentDiscountBp = 0): Totals {
  const out: LineOut[] = lines.map((l) => {
    const raw = l.qty * l.unitPriceCents;
    const afterLine = raw - applyBp(raw, l.discountBp);
    const net = afterLine - applyBp(afterLine, documentDiscountBp);
    return { ...l, grossLineCents: afterLine, netCents: net, vatCents: 0 };
  });
  const subtotalCents = out.reduce((s, l) => s + l.grossLineCents, 0);
  const netCents = out.reduce((s, l) => s + l.netCents, 0);
  const groups = new Map<number, number>();
  for (const l of out) groups.set(l.vatRateBp, (groups.get(l.vatRateBp) ?? 0) + l.netCents);
  const vatByRate = [...groups.entries()].sort((a, b) => b[0] - a[0])
    .map(([rateBp, n]) => ({ rateBp, netCents: n, vatCents: applyBp(n, rateBp) }));
  // USt pro Position nur informativ (Summe je Satz ist maßgeblich); Rest der Rundung auf letzte Position des Satzes
  for (const g of vatByRate) {
    const ls = out.filter((l) => l.vatRateBp === g.rateBp);
    let rest = g.vatCents;
    ls.forEach((l, i) => {
      l.vatCents = i === ls.length - 1 ? rest : applyBp(l.netCents, l.vatRateBp);
      rest -= l.vatCents;
    });
  }
  const vatCents = vatByRate.reduce((s, g) => s + g.vatCents, 0);
  return { lines: out, subtotalCents, discountCents: subtotalCents - netCents, netCents, vatByRate, vatCents, grossCents: netCents + vatCents };
}

/** Betrag bei Zahlung innerhalb der Skontofrist */
export function skontoAmount(grossCents: number, skontoBp: number) {
  return grossCents - applyBp(grossCents, skontoBp);
}

/** Pflichthinweise auf der Rechnung je Steuerbehandlung (deutsch, rechtlich maßgeblich). */
export function legalNotes(mode: TaxMode, o: { ossCountry?: string | null; retentionOfTitle?: boolean }): string[] {
  const n: string[] = [];
  if (mode === "EU_REVERSE_CHARGE") n.push("Steuerfreie innergemeinschaftliche Lieferung gemäß § 4 Nr. 1b i. V. m. § 6a UStG.");
  if (mode === "EXPORT") n.push("Steuerfreie Ausfuhrlieferung gemäß § 4 Nr. 1a i. V. m. § 6 UStG.");
  if (mode === "EU_PENDING_VATID")
    n.push("Die USt-IdNr. des Leistungsempfängers liegt noch nicht vor; die Umsatzsteuer wird daher ausgewiesen. Nach Vorlage einer gültigen USt-IdNr. erfolgt eine Rechnungskorrektur.");
  if (mode === "EU_B2C" && o.ossCountry) n.push(`Umsatzsteuer des Bestimmungslandes ${o.ossCountry} (OSS-Verfahren).`);
  if (o.retentionOfTitle) n.push("Die Ware bleibt bis zur vollständigen Bezahlung unser Eigentum.");
  return n;
}
