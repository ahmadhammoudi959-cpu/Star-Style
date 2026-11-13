/**
 * Kunden aus den Shops → unsere Kunden (Wunsch Inhaber 13.11.2026: „أي زبون يعمل اكونت على أي من المتجرين يطلع بالسيستم“;
 * auch wer zur Kasse geht, nicht online bezahlt und z. B. per Nachnahme bestellt). Rein, ohne Datenbank – getestet in
 * tests/shop-customers.test.ts. Abgleich mit Datenbank und Shopify: ./customers.ts.
 */

/** Felder, die wir vom Shop-Kunden lesen (Admin GraphQL 2026-07; `email`/`phone` sind dort veraltet) */
export type ShopCustomerNode = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  state: string;
  numberOfOrders: string | number | null;
  createdAt: string;
  updatedAt: string;
  defaultEmailAddress: { emailAddress: string | null } | null;
  defaultPhoneNumber: { phoneNumber: string | null } | null;
  defaultAddress: {
    company: string | null; address1: string | null; address2: string | null; zip: string | null; city: string | null;
    countryCodeV2: string | null; phone: string | null;
  } | null;
};

export type CustomerFields = {
  type: "COMPANY" | "PERSON"; name: string; contact: string; email: string; phone: string;
  street: string; zip: string; city: string; country: string;
};

const clean = (s: string | null | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
export const normEmail = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const EMAIL = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]{2,}$/;

/** Anzahl Bestellungen im Shop (Shopify liefert UnsignedInt64 als Text) */
export const orderCount = (n: Pick<ShopCustomerNode, "numberOfOrders">) => {
  const v = Number(n.numberOfOrders ?? 0);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
};

/**
 * Gehört dieser Shop-Kunde ins System? Ja, wenn er ein Konto hat (state ENABLED – seit 28.10.2026 nach der ersten Anmeldung)
 * oder schon bestellt hat (auch unbezahlt, z. B. Nachnahme, oder als Gast). Nur-Newsletter-Kontakte oder von uns für B2B
 * angelegte, noch nie angemeldete Kontakte nicht.
 */
export const belongsInSystem = (n: Pick<ShopCustomerNode, "state" | "numberOfOrders">) => n.state === "ENABLED" || orderCount(n) > 0;

/** Unser Kunde aus dem Shop-Kunden; null ohne gültige E-Mail (die E-Mail ist der Schlüssel, wie bei Bestellungen und B2B) */
export function customerFromShop(n: ShopCustomerNode): CustomerFields | null {
  const email = normEmail(n.defaultEmailAddress?.emailAddress);
  if (!EMAIL.test(email) || email.length > 200) return null;
  const a = n.defaultAddress;
  const person = clean([n.firstName, n.lastName].filter(Boolean).join(" "), 200) || (clean(n.displayName, 200) !== email ? clean(n.displayName, 200) : "");
  const company = clean(a?.company, 200);
  const street = clean([a?.address1, a?.address2].filter((x) => clean(x, 200)).join(", "), 200);
  const country = /^[A-Z]{2}$/.test(clean(a?.countryCodeV2, 2).toUpperCase()) ? clean(a?.countryCodeV2, 2).toUpperCase() : "DE";
  return {
    type: company ? "COMPANY" : "PERSON",
    // ohne Namen (Anmeldung nur mit E-Mail-Code) steht die E-Mail als Name da – wird ersetzt, sobald der Kunde seinen Namen einträgt
    name: company || person || email,
    contact: company ? person : "",
    email,
    phone: clean(n.defaultPhoneNumber?.phoneNumber || a?.phone, 60),
    street, zip: clean(a?.zip, 20), city: clean(a?.city, 100), country,
  };
}

/** Name ist nur ein Platzhalter (leer oder die E-Mail selbst) */
export const placeholderName = (c: Pick<CustomerFields, "name" | "email">) => !c.name.trim() || normEmail(c.name) === normEmail(c.email);

/**
 * Was am vorhandenen Kunden ergänzt werden darf: nur Leeres (bzw. der Platzhalter-Name). Was im System schon steht, gewinnt immer –
 * der Inhaber pflegt die Kunden im System, der Shop überschreibt nichts. Anschrift nur als Ganzes (Straße/PLZ/Ort/Land zusammen).
 */
export function fillMissing(current: CustomerFields, incoming: CustomerFields): Partial<CustomerFields> {
  const out: Partial<CustomerFields> = {};
  // die Person hinter dem Shop-Konto (bei Firmen der Ansprechpartner) – wird Ansprechpartner einer Firma im System
  const person = incoming.type === "COMPANY" ? incoming.contact : placeholderName(incoming) ? "" : incoming.name;
  if (placeholderName(current) && !placeholderName(incoming)) {
    out.name = incoming.name;
    out.type = incoming.type;
    if (!current.contact && incoming.contact) out.contact = incoming.contact;
  } else if (!current.contact && person && person !== current.name) out.contact = person;
  if (!current.phone && incoming.phone) out.phone = incoming.phone;
  const noAddress = !current.street && !current.zip && !current.city;
  if (noAddress && (incoming.street || incoming.zip || incoming.city)) {
    out.street = incoming.street; out.zip = incoming.zip; out.city = incoming.city; out.country = incoming.country;
  }
  return out;
}
