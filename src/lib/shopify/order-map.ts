/**
 * Shopify-Bestellung → Rechnung. Rein und getestet.
 * Grundsatz: Die Rechnung muss genau dem entsprechen, was der Kunde im Shop bezahlt hat
 * (Bruttopreise, Steuersätze wie vom Shop berechnet). Unklare Fälle werden NICHT automatisch gebucht.
 */
import { computeTotals, EU_COUNTRIES, type TaxMode } from "../tax";
import type { LineInput } from "../sales";

type Money = { shopMoney: { amount: string } };
type Address = { firstName?: string | null; lastName?: string | null; company?: string | null; address1?: string | null; address2?: string | null; zip?: string | null; city?: string | null; countryCodeV2?: string | null; phone?: string | null } | null;

export type ShopOrder = {
  id: string; name: string; createdAt: string; updatedAt: string; processedAt?: string | null; cancelledAt: string | null; test: boolean;
  email: string | null; currencyCode: string; taxesIncluded: boolean; displayFinancialStatus: string | null; paymentGatewayNames: string[];
  billingAddress: Address; shippingAddress: Address;
  totalPriceSet: Money; currentTotalPriceSet: Money; totalOutstandingSet?: Money; totalRefundedSet?: Money;
  lineItems: { nodes: { id: string; sku: string | null; title: string; variantTitle: string | null; quantity: number; variant: { id: string } | null; discountedUnitPriceAfterAllDiscountsSet: Money; taxLines: { rate: number | null }[] }[] };
  shippingLines: { nodes: { title: string; discountedPriceSet: Money; taxLines: { rate: number | null }[] }[] };
  refunds: { id: string; createdAt: string; totalRefundedSet: Money; refundLineItems: { nodes: { quantity: number; restockType: string; lineItem: { id: string } }[] } }[];
};

export type MappedOrder = {
  ref: string; externalId: string; date: string;
  customer: { name: string; email: string; type: "COMPANY" | "PERSON"; street: string; zip: string; city: string; country: string; phone: string; contact: string };
  lines: LineInput[]; pricesGross: boolean; taxMode: TaxMode; ossCountry: string | null;
  totalCents: number; computedCents: number; paid: boolean; unmapped: string[]; warnings: string[];
  skip: null | "currency" | "noTaxEu" | "noLines";
};

export const cents = (m: Money | undefined | null) => Math.round(Number(m?.shopMoney.amount ?? 0) * 100);
const rateBp = (tl: { rate: number | null }[]) => Math.round(tl.reduce((s, t) => s + (t.rate ?? 0), 0) * 10000);
export const berlinDate = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(iso));
export const PAID = ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"];

export function mapOrder(o: ShopOrder, links: Map<string, string>): MappedOrder {
  const warnings: string[] = [];
  const addr = o.shippingAddress ?? o.billingAddress;
  const bill = o.billingAddress ?? o.shippingAddress;
  const country = (addr?.countryCodeV2 ?? "DE").toUpperCase();
  const person = [bill?.firstName, bill?.lastName].filter(Boolean).join(" ").trim();
  const company = (bill?.company ?? "").trim();
  const unmapped: string[] = [];

  const lines: LineInput[] = o.lineItems.nodes.filter((l) => l.quantity > 0).map((l) => {
    const variantId = l.variant ? links.get(l.variant.id) ?? null : null;
    if (!variantId) unmapped.push(`${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}${l.sku ? ` · ${l.sku}` : ""}`);
    return {
      variantId, description: `${l.title}${l.variantTitle && l.variantTitle !== "Default Title" ? ` – ${l.variantTitle}` : ""}`.slice(0, 200),
      qty: l.quantity, unitPriceCents: cents(l.discountedUnitPriceAfterAllDiscountsSet), discountBp: 0, vatRateBp: rateBp(l.taxLines), externalLineId: l.id,
    };
  });
  for (const s of o.shippingLines.nodes) {
    const p = cents(s.discountedPriceSet);
    if (p > 0) lines.push({ variantId: null, description: `Versand: ${s.title}`.slice(0, 200), qty: 1, unitPriceCents: p, discountBp: 0, vatRateBp: rateBp(s.taxLines), externalLineId: "shipping" });
  }

  // Steuerbehandlung aus dem, was der Shop tatsächlich berechnet hat
  const rates = new Set(lines.map((l) => l.vatRateBp).filter((r) => r > 0));
  let taxMode: TaxMode = "DOMESTIC", ossCountry: string | null = null;
  let skip: MappedOrder["skip"] = null;
  if (country !== "DE" && EU_COUNTRIES.includes(country as never)) {
    if (!rates.size) skip = "noTaxEu"; // steuerfrei an EU-Firma: USt-IdNr. muss geprüft werden → von Hand
    else {
      taxMode = "EU_B2C";
      ossCountry = [...rates].every((r) => r === 1900 || r === 700) ? null : country;
    }
  } else if (country !== "DE") {
    if (rates.size) warnings.push("taxedExport");
    else taxMode = "EXPORT";
  }
  if (o.currencyCode !== "EUR") skip = "currency";
  if (!lines.length) skip = "noLines";

  const totalCents = cents(o.totalPriceSet);
  const computedCents = lines.length ? computeTotals(lines, 0, { gross: o.taxesIncluded }).grossCents : 0;
  if (!skip && Math.abs(totalCents - computedCents) > 2) warnings.push(`totalMismatch:${computedCents - totalCents}`);
  if (unmapped.length) warnings.push("unmapped");

  return {
    ref: o.name, externalId: o.id, date: berlinDate(o.createdAt),
    customer: {
      name: (company || person || o.email || o.name).slice(0, 120), email: (o.email ?? "").toLowerCase(), type: company ? "COMPANY" : "PERSON",
      street: [addr?.address1, addr?.address2].filter(Boolean).join(", "), zip: addr?.zip ?? "", city: addr?.city ?? "", country,
      phone: addr?.phone ?? "", contact: company ? person : "",
    },
    lines, pricesGross: o.taxesIncluded, taxMode, ossCountry, totalCents, computedCents,
    paid: PAID.includes(o.displayFinancialStatus ?? ""), unmapped, warnings, skip,
  };
}

/** Restmengen je Shop-Position nach einer Erstattung */
export function quantitiesAfterRefund(current: { externalLineId: string | null; qty: number }[], refund: ShopOrder["refunds"][number]) {
  const minus = new Map<string, number>();
  for (const r of refund.refundLineItems.nodes) minus.set(r.lineItem.id, (minus.get(r.lineItem.id) ?? 0) + r.quantity);
  return current.map((l) => ({ ...l, qty: l.externalLineId && minus.has(l.externalLineId) ? Math.max(0, l.qty - minus.get(l.externalLineId)!) : l.qty }));
}
