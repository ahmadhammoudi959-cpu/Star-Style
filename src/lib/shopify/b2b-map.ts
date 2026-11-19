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

/** Was beim Unternehmen im Shop mitgeschickt wird (Shopify lehnt z. B. eine ungültige PLZ ab → dann ohne Anschrift) */
export type CompanyParts = { address: boolean; tax: boolean };
export const ALL_PARTS: CompanyParts = { address: true, tax: true };

/**
 * companyCreate: Firma + Standort (+ Kontakt, wenn es den Shop-Kunden mit der E-Mail noch nicht gibt).
 * parts: Anschrift bzw. USt-IdNr. weglassen, wenn Shopify sie abgelehnt hat – die Preise gehen auch ohne.
 */
export function companyCreateInput(c: B2bCustomer, withContact: boolean, parts: CompanyParts = ALL_PARTS) {
  const address = parts.address ? companyAddress(c) : null;
  const vat = parts.tax ? vatOf(c) : "";
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

export type ShopUserError = { field?: string[] | null; message: string };

/**
 * Hat Shopify die Anschrift oder die USt-IdNr. abgelehnt? (Feldpfad oder Meldung, z. B. „Zip is invalid“ beim Anlegen am
 * 12.11.2026 mit PLZ „0000“). Andere Fehler (z. B. E-Mail schon vergeben) → beides false.
 */
export function rejectedParts(errs: ShopUserError[]): CompanyParts {
  let address = false, tax = false;
  for (const e of errs) {
    const f = (e.field ?? []).join(".").toLowerCase(), m = e.message.toLowerCase();
    const mail = /e-?mail|contact/.test(`${f} ${m}`); // „Email address …“ betrifft den Kontakt, nicht die Anschrift
    if (!mail && (/address|zip|postal|city|province|zone|country/.test(f) || /\bzip\b|postal|post ?code|postleitzahl|address|province|city|country code|street/.test(m))) address = true;
    if (/tax/.test(f) || /\btax\b|\bvat\b|tax ?id|tax registration|ust-?id/.test(m)) tax = true;
  }
  return { address, tax };
}

/** Der Kunde so, wie er im Shop steht (weggelassene Teile leer) – für den Fingerabdruck: beim nächsten Speichern wird es erneut versucht */
export function shownInShop(c: B2bCustomer, parts: CompanyParts): B2bCustomer {
  return { ...c, ...(parts.address ? {} : { street: "", zip: "", city: "" }), ...(parts.tax ? {} : { vatId: "" }) };
}

/** Hinweis für die Kundenseite: „noAddress:<Meldung>“ / „noTax:<Meldung>“ (nur die passenden Meldungen), mehrere mit „|“ getrennt */
export function partNote(kind: "noAddress" | "noTax", errs: ShopUserError[]) {
  const mine = errs.filter((e) => rejectedParts([e])[kind === "noAddress" ? "address" : "tax"]);
  return `${kind}:${(mine.length ? mine : errs).map((e) => e.message).join("; ").replace(/\|/g, "/")}`.slice(0, 200);
}

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

export type ResellerRow = { shopVariantId: string; netCents: number; vatRateBp: number; promoBp?: number };
export type FixedPrice = { variantId: string; amount: string; compareAt?: string | null };
type Money = { amount: string; currencyCode: string };

/**
 * Festpreise der Preisliste = جملة الجملة-Preis (Wiederverkäufer, netto im System) wie im Shop gezeigt (brutto, wenn die Preise
 * inkl. MwSt. sind – derselbe runde Bruttopreis wie überall). Ohne Wiederverkäuferpreis → Festpreis weg (dann gilt der normale Preis).
 * Nur Abweichungen; Varianten, die nicht in rows stehen, bleiben unberührt.
 * Aktion (19.11.2026): auch Wiederverkäufer sehen „-20%“ – Festpreis minus Rabatt, Streichpreis = ihr normaler Preis;
 * nach der Aktion wird der Streichpreis wieder entfernt (die Preisliste pflegt nur unser System).
 */
export function planResellerPrices(rows: ResellerRow[], current: FixedPrice[], taxesIncluded: boolean, currency: string) {
  const have = new Map(current.map((c) => [c.variantId, { price: Math.round(Number(c.amount) * 100), compare: c.compareAt == null || c.compareAt === "" ? null : Math.round(Number(c.compareAt) * 100) }]));
  const add: { variantId: string; price: Money; compareAtPrice?: Money | null }[] = [];
  const del: string[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  const m = (c: number): Money => ({ amount: (c / 100).toFixed(2), currencyCode: currency });
  for (const r of rows) {
    if (seen.has(r.shopVariantId)) continue;
    seen.add(r.shopVariantId);
    const cur = have.get(r.shopVariantId);
    if (!(r.netCents > 0)) {
      if (cur != null) del.push(r.shopVariantId); else unchanged++;
      continue;
    }
    const normal = shopPriceCents(r.netCents, r.vatRateBp, taxesIncluded);
    if ((r.promoBp ?? 0) > 0) {
      const want = Math.round((normal * (10000 - r.promoBp!)) / 10000);
      if (cur?.price === want && cur.compare === normal) { unchanged++; continue; }
      add.push({ variantId: r.shopVariantId, price: m(want), compareAtPrice: m(normal) });
      continue;
    }
    if (cur?.price === normal && cur.compare == null) { unchanged++; continue; }
    add.push(cur?.compare != null ? { variantId: r.shopVariantId, price: m(normal), compareAtPrice: null } : { variantId: r.shopVariantId, price: m(normal) });
  }
  return { add, del, unchanged };
}

/** in Päckchen schicken (Shopify nimmt je Aufruf nur begrenzt viele) */
export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
