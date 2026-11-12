/**
 * Wiederverkäufer im Online-Shop (Wunsch Inhaber 12.11.2026) – rein, ohne Datenbank, getestet (tests/b2b.test.ts):
 * Kunde „جملة الجملة“ → Unternehmen im Shop (Shopify B2B: Firma, Standort mit Anschrift + USt-IdNr., Kontakt = Shop-Kunde mit
 * derselben E-Mail), Erkennen des B2B-Markts mit der Preisliste und Plan für die Festpreise der Preisliste.
 */
import { shopPriceCents } from "./product-push-map";

export type B2bCustomer = {
  number: number; type: "COMPANY" | "PERSON"; name: string; contact: string; email: string;
  street: string; zip: string; city: string; country: string; vatId: string;
};

import { normEmail } from "./b2b-email";
export { normEmail, validEmail } from "./b2b-email";

/** Vor- und Nachname des Kontakts: Ansprechpartner, sonst der Name des Kunden */
export function contactName(c: Pick<B2bCustomer, "name" | "contact">): { firstName: string; lastName: string } {
  const parts = (c.contact.trim() || c.name.trim()).replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (parts.length <= 1) return { firstName: "", lastName: (parts[0] ?? "").slice(0, 255) };
  return { firstName: parts.slice(0, -1).join(" ").slice(0, 255), lastName: parts[parts.length - 1].slice(0, 255) };
}

const vatOf = (c: B2bCustomer) => c.vatId.replace(/[\s.-]/g, "").toUpperCase();
const countryOf = (c: B2bCustomer) => (/^[A-Za-z]{2}$/.test(c.country.trim()) ? c.country.trim().toUpperCase() : "DE");

/** Anschrift des Standorts; ohne Straße oder Ort keine (der Kunde gibt sie dann im Checkout ein) */
export function companyAddress(c: B2bCustomer) {
  if (!c.street.trim() || !c.city.trim()) return null;
  return { address1: c.street.trim().slice(0, 255), city: c.city.trim().slice(0, 255), zip: c.zip.trim().slice(0, 20), countryCode: countryOf(c), recipient: c.name.trim().slice(0, 255) };
}

/** companyCreate: Firma + Standort (+ Kontakt, wenn es den Shop-Kunden mit der E-Mail noch nicht gibt) */
export function companyCreateInput(c: B2bCustomer, withContact: boolean) {
  const address = companyAddress(c);
  const vat = vatOf(c);
  return {
    company: { name: c.name.trim().slice(0, 255), externalId: `K${c.number}` },
    companyLocation: {
      name: (c.city.trim() ? `${c.name.trim()} – ${c.city.trim()}` : c.name.trim()).slice(0, 255),
      ...(address ? { shippingAddress: address, billingSameAsShipping: true } : {}),
      ...(vat ? { taxRegistrationId: vat } : {}),
      // Lieferadresse im Checkout änderbar, Bestellung direkt (kein Entwurf zur Prüfung)
      buyerExperienceConfiguration: { checkoutToDraft: false, editableShippingAddress: true },
    },
    ...(withContact ? { companyContact: { email: normEmail(c.email), ...contactName(c) } } : {}),
  };
}

/** Was im Shop zum Unternehmen steht – ändert sich das, wird es dort nachgezogen */
export function companyFingerprint(c: B2bCustomer) {
  return JSON.stringify([c.name.trim(), companyAddress(c), vatOf(c)]);
}

export const vatForShop = vatOf;

// ───────────────────────── B2B-Markt + Preisliste ─────────────────────────

export type MarketNode = {
  id: string; name: string; status?: string | null; type?: string | null;
  priceInclusions?: { inclusiveTaxPricingStrategy?: string | null } | null;
  conditions?: { companyLocationsCondition?: { applicationLevel?: string | null } | null } | null;
  catalogs?: { nodes: { id: string; title: string; status?: string | null; priceList: { id: string; name: string; currency: string } | null }[] } | null;
};

export type ResellerSetup = {
  priceListId: string; currency: string; marketName: string; catalogTitle: string;
  /** Preise der Preisliste inkl. MwSt. (wie der Shop) oder MwSt. erst im Checkout */
  taxesIncluded: boolean;
  /** Markt gilt für alle (auch künftige) Unternehmensstandorte – sonst muss jeder Standort im Shop dem Markt zugeordnet werden */
  allLocations: boolean;
};
export type ResellerProblem = "noMarket" | "noPriceList" | "marketInactive";

/**
 * B2B-Markt (Bedingung „Unternehmensstandorte“) mit Katalog + Preisliste finden. Aktive Märkte/Kataloge zuerst.
 * shopTaxesIncluded = Einstellung des Shops, falls der Markt nichts Eigenes sagt.
 */
export function pickResellerSetup(markets: MarketNode[], shopTaxesIncluded: boolean): ResellerSetup | { problem: ResellerProblem } {
  const b2b = markets.filter((m) => m.type === "COMPANY_LOCATION" || Boolean(m.conditions?.companyLocationsCondition));
  if (!b2b.length) return { problem: "noMarket" };
  const rank = (s?: string | null) => (s === "ACTIVE" ? 0 : 1);
  const sorted = [...b2b].sort((a, b) => rank(a.status) - rank(b.status));
  for (const m of sorted) {
    const cats = [...(m.catalogs?.nodes ?? [])].filter((c) => c.priceList).sort((a, b) => rank(a.status) - rank(b.status));
    if (!cats.length) continue;
    if (m.status && m.status !== "ACTIVE") return { problem: "marketInactive" };
    const c = cats[0];
    const strat = m.priceInclusions?.inclusiveTaxPricingStrategy;
    return {
      priceListId: c.priceList!.id, currency: c.priceList!.currency, marketName: m.name, catalogTitle: c.title,
      taxesIncluded: strat ? strat !== "ADD_TAXES_AT_CHECKOUT" : shopTaxesIncluded,
      allLocations: m.conditions?.companyLocationsCondition?.applicationLevel === "ALL",
    };
  }
  return { problem: "noPriceList" };
}

export type ResellerRow = { shopVariantId: string; netCents: number; vatRateBp: number };
export type FixedPrice = { variantId: string; amount: string };

/**
 * Festpreise der Preisliste = جملة الجملة-Preis (Wiederverkäufer, netto im System) wie im Shop gezeigt (brutto, wenn die Preise
 * inkl. MwSt. sind – derselbe runde Bruttopreis wie überall). Ohne Wiederverkäuferpreis → Festpreis weg (dann gilt der normale Preis).
 * Nur Abweichungen; Varianten, die nicht in rows stehen, bleiben unberührt.
 */
export function planResellerPrices(rows: ResellerRow[], current: FixedPrice[], taxesIncluded: boolean, currency: string) {
  const have = new Map(current.map((c) => [c.variantId, Math.round(Number(c.amount) * 100)]));
  const add: { variantId: string; price: { amount: string; currencyCode: string } }[] = [];
  const del: string[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.shopVariantId)) continue;
    seen.add(r.shopVariantId);
    const cur = have.get(r.shopVariantId);
    if (!(r.netCents > 0)) {
      if (cur != null) del.push(r.shopVariantId); else unchanged++;
      continue;
    }
    const want = shopPriceCents(r.netCents, r.vatRateBp, taxesIncluded);
    if (cur === want) { unchanged++; continue; }
    add.push({ variantId: r.shopVariantId, price: { amount: (want / 100).toFixed(2), currencyCode: currency } });
  }
  return { add, del, unchanged };
}

/** in Päckchen schicken (Shopify nimmt je Aufruf nur begrenzt viele) */
export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
