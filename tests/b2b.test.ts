/**
 * Großhandelspreise (جملة الجملة) im Online-Shop über Shopify B2B (Wunsch Inhaber 12.11.2026):
 * rein (b2b-map) + Datenbank mit simuliertem Shopify (Unternehmen, Kontakte per E-Mail, Preisliste).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  ALL_PARTS, companyCreateInput, companyFingerprint, contactName, EU_REVERSE_CHARGE, locationName, normEmail, partNote, pickResellerSetup, planResellerPrices, rejectedParts,
  reverseCharge, shownInShop, taxSettingsUpdate, validEmail,
  type B2bCustomer, type MarketNode,
} from "../src/lib/shopify/b2b-map";

const ali: B2bCustomer = { number: 7, type: "COMPANY", name: "Ali Friseurbedarf", contact: "", email: " Ali@Example.com ", street: "Viktoriastraße 26-28", zip: "45468", city: "Mülheim an der Ruhr", country: "de", vatId: "de 462 925 434" };

describe("Großhandelspreise im Shop (rein)", () => {
  it("E-Mail: klein, ohne Leerzeichen; nur gültige", () => {
    expect(normEmail(ali.email)).toBe("ali@example.com");
    expect(validEmail("ali@example.com")).toBe(true);
    for (const bad of ["", "ali", "ali@", "ali@example", "a li@example.com", "ali@ex\"ample.com"]) expect(validEmail(bad)).toBe(false);
  });

  it("Kontaktname: Ansprechpartner, sonst Name; Nachname = letztes Wort", () => {
    expect(contactName({ name: "Ali Friseurbedarf", contact: "Ali Hassan Kaya" })).toEqual({ firstName: "Ali Hassan", lastName: "Kaya" });
    expect(contactName({ name: "علي", contact: "" })).toEqual({ firstName: "", lastName: "علي" });
  });

  it("Unternehmen: Name, Kd.-Nr., Standort mit Anschrift + USt-IdNr.; Kontakt nur, wenn es den Shop-Kunden noch nicht gibt", () => {
    const i = companyCreateInput(ali, true);
    expect(i.company).toEqual({ name: "Ali Friseurbedarf", externalId: "K7" });
    expect(i.companyLocation).toMatchObject({
      name: "Ali Friseurbedarf – Mülheim an der Ruhr", billingSameAsShipping: true, taxRegistrationId: "DE462925434",
      shippingAddress: { address1: "Viktoriastraße 26-28", zip: "45468", city: "Mülheim an der Ruhr", countryCode: "DE", recipient: "Ali Friseurbedarf" },
      buyerExperienceConfiguration: { checkoutToDraft: false, editableShippingAddress: true },
    });
    expect(i.companyContact).toEqual({ email: "ali@example.com", firstName: "Ali", lastName: "Friseurbedarf" });
    expect(companyCreateInput(ali, false)).not.toHaveProperty("companyContact");
    // ohne Straße/Ort keine Anschrift, ohne USt-IdNr. keine Steuernummer
    const bare = companyCreateInput({ ...ali, street: "", vatId: "" }, false).companyLocation;
    expect(bare).not.toHaveProperty("shippingAddress");
    expect(bare).not.toHaveProperty("taxRegistrationId");
    // Fingerabdruck ändert sich mit Name/Anschrift/USt-IdNr., nicht mit der E-Mail
    expect(companyFingerprint({ ...ali, email: "x@y.de" })).toBe(companyFingerprint(ali));
    expect(companyFingerprint({ ...ali, street: "Neue Str. 1" })).not.toBe(companyFingerprint(ali));
    // Standort „Name – Ort“, ohne Ort nur der Name; ein anderer Ort ändert ihn auch ohne Straße (keine Anschrift im Shop)
    expect(locationName({ name: " Salon Aya ", city: " Herne " })).toBe("Salon Aya – Herne");
    expect(locationName({ name: "Salon Aya", city: "" })).toBe("Salon Aya");
    expect(companyFingerprint({ ...ali, street: "", city: "Herne" })).not.toBe(companyFingerprint({ ...ali, street: "", city: "Datteln" }));
  });

  it("Shopify lehnt Anschrift/USt-IdNr. ab (PLZ „0000“, 12.11.2026) → erkennen, ohne diesen Teil anlegen, beim nächsten Speichern erneut", () => {
    expect(rejectedParts([{ field: ["input", "companyLocation", "shippingAddress", "zip"], message: "Zip is invalid" }])).toEqual({ address: true, tax: false });
    expect(rejectedParts([{ field: null, message: "Zip is invalid" }])).toEqual({ address: true, tax: false });
    expect(rejectedParts([{ field: ["input", "companyLocation", "taxRegistrationId"], message: "is invalid" }])).toEqual({ address: false, tax: true });
    expect(rejectedParts([{ field: ["input", "companyLocation", "shippingAddress", "zip"], message: "Zip is invalid" }, { field: null, message: "Tax ID is invalid" }]))
      .toEqual({ address: true, tax: true });
    // Fehler am Kontakt ist nichts davon (sonst würde die Anschrift umsonst weggelassen)
    expect(rejectedParts([{ field: ["companyContact", "email"], message: "Email address is invalid" }])).toEqual({ address: false, tax: false });
    expect(rejectedParts([{ field: ["companyContact", "email"], message: "Email has already been taken" }])).toEqual({ address: false, tax: false });
    expect(rejectedParts([{ field: ["input", "company", "name"], message: "Customer must have a name" }])).toEqual({ address: false, tax: false });
    const noAddress = companyCreateInput(ali, false, { address: false, tax: true }).companyLocation;
    expect(noAddress).not.toHaveProperty("shippingAddress");
    expect(noAddress).toHaveProperty("taxRegistrationId", "DE462925434");
    expect(companyCreateInput(ali, false, { address: true, tax: false }).companyLocation).not.toHaveProperty("taxRegistrationId");
    expect(companyFingerprint(shownInShop(ali, { address: false, tax: true }))).not.toBe(companyFingerprint(ali));
    expect(companyFingerprint(shownInShop(ali, ALL_PARTS))).toBe(companyFingerprint(ali));
    expect(partNote("noAddress", [{ message: "Zip is invalid" }, { message: "City a|b is invalid" }, { message: "Tax ID is invalid" }])).toBe("noAddress:Zip is invalid; City a/b is invalid");
    expect(partNote("noTax", [{ message: "Zip is invalid" }, { message: "Tax ID is invalid" }])).toBe("noTax:Tax ID is invalid");
  });

  it("Reverse Charge (20.11.2026): Firma aus anderem EU-Land mit geprüfter USt-IdNr. → Befreiung am Standort; Deutschland nie", () => {
    const nl: B2bCustomer = { number: 5, type: "COMPANY", name: "Barbershop Hozan", contact: "", email: "hozan@example.com", street: "Markt 1", zip: "7772 CD",
      city: "Hardenberg", country: "NL", vatId: "nl 0055.42463-b59", vatIdStatus: "VALID" };
    expect(reverseCharge(nl)).toBe(true);
    expect(companyCreateInput(nl, false).companyLocation).toMatchObject({ taxRegistrationId: "NL005542463B59", taxExemptions: [EU_REVERSE_CHARGE] });
    // Nummer nicht (oder noch nicht) als gültig geprüft → MwSt. wie ein Privatkunde
    for (const st of ["NONE", "PENDING", "INVALID", undefined] as const) {
      expect(reverseCharge({ ...nl, vatIdStatus: st })).toBe(false);
      expect(companyCreateInput({ ...nl, vatIdStatus: st }, false).companyLocation).not.toHaveProperty("taxExemptions");
    }
    // Deutschland zahlt immer 19 % – auch eine Firma mit gültiger Nummer
    expect(reverseCharge({ ...ali, vatIdStatus: "VALID" })).toBe(false);
    expect(companyCreateInput({ ...ali, vatIdStatus: "VALID" }, false).companyLocation).not.toHaveProperty("taxExemptions");
    expect(reverseCharge({ ...nl, vatId: "DE123456789" })).toBe(false); // deutsche Nummer, Anschrift NL
    expect(reverseCharge({ ...nl, type: "PERSON" })).toBe(false);
    expect(reverseCharge({ ...nl, vatId: "" })).toBe(false);
    expect(reverseCharge({ ...nl, country: "CH", vatId: "CHE123456789" })).toBe(false); // kein EU-Land
    expect(reverseCharge({ ...nl, country: "GR", vatId: "EL123456789" })).toBe(true);
    // Nummer vom Shop abgelehnt → ohne Nummer auch keine Befreiung
    expect(companyCreateInput(nl, false, { address: true, tax: false }).companyLocation).not.toHaveProperty("taxExemptions");
    // neue Prüfung (gültig ↔ ungültig) ändert den Fingerabdruck → der Shop wird nachgezogen
    expect(companyFingerprint({ ...nl, vatIdStatus: "INVALID" })).not.toBe(companyFingerprint(nl));
    expect(companyFingerprint({ ...ali, vatIdStatus: "VALID" })).toBe(companyFingerprint({ ...ali, vatIdStatus: "INVALID" }));
    expect(taxSettingsUpdate(nl)).toEqual({ tax: "NL005542463B59", add: [EU_REVERSE_CHARGE], remove: [] });
    expect(taxSettingsUpdate({ ...nl, vatIdStatus: "INVALID" })).toEqual({ tax: "NL005542463B59", add: [], remove: [EU_REVERSE_CHARGE] });
    expect(taxSettingsUpdate({ ...ali, vatId: "" })).toEqual({ tax: null, add: [], remove: [EU_REVERSE_CHARGE] });
  });

  it("B2B-Markt finden: Bedingung Unternehmensstandorte + Katalog mit Preisliste; Steuer aus dem Markt", () => {
    const region: MarketNode = { id: "M1", name: "Deutschland", status: "ACTIVE", type: "REGION", catalogs: { nodes: [] } };
    expect(pickResellerSetup([region], true)).toEqual({ problem: "noMarket" });
    const b2b: MarketNode = {
      id: "M2", name: "جملة الجملة", status: "ACTIVE", type: "COMPANY_LOCATION", priceInclusions: { inclusiveTaxPricingStrategy: "INCLUDES_TAXES_IN_PRICE" },
      conditions: { companyLocationsCondition: { applicationLevel: "ALL" } },
      catalogs: { nodes: [{ id: "C1", title: "Wiederverkäufer", status: "ACTIVE", priceList: { id: "PL1", name: "Wiederverkäufer", currency: "EUR" } }] },
    };
    expect(pickResellerSetup([region, b2b], false)).toEqual({ priceListId: "PL1", currency: "EUR", marketName: "جملة الجملة", catalogTitle: "Wiederverkäufer", taxesIncluded: true, allLocations: true });
    expect(pickResellerSetup([{ ...b2b, priceInclusions: { inclusiveTaxPricingStrategy: "ADD_TAXES_AT_CHECKOUT" }, conditions: { companyLocationsCondition: { applicationLevel: "SPECIFIC" } } }], true))
      .toMatchObject({ taxesIncluded: false, allLocations: false });
    expect(pickResellerSetup([{ ...b2b, catalogs: { nodes: [] } }], true)).toEqual({ problem: "noPriceList" });
    expect(pickResellerSetup([{ ...b2b, status: "DRAFT" }], true)).toEqual({ problem: "marketInactive" });
  });

  it("Preisliste: جملة الجملة-Preis brutto (runder Preis wie im Shop), ohne Preis → Festpreis weg, nur Abweichungen", () => {
    const rows = [
      { shopVariantId: "V1", netCents: 25_13, vatRateBp: 1900 }, // → 29,90 € (derselbe runde Bruttopreis wie überall)
      { shopVariantId: "V2", netCents: 10_00, vatRateBp: 1900 }, // → 11,90 €, schon richtig
      { shopVariantId: "V3", netCents: 0, vatRateBp: 1900 },     // kein Großhandelspreis → Festpreis entfernen
      { shopVariantId: "V4", netCents: 0, vatRateBp: 700 },      // kein Preis und kein Festpreis → nichts
      { shopVariantId: "V1", netCents: 25_13, vatRateBp: 1900 }, // doppelt → einmal
    ];
    const plan = planResellerPrices(rows, [{ variantId: "V2", amount: "11.9" }, { variantId: "V3", amount: "5.00" }, { variantId: "VX", amount: "1.00" }], true, "EUR");
    expect(plan.add).toEqual([{ variantId: "V1", price: { amount: "29.90", currencyCode: "EUR" } }]);
    expect(plan.del).toEqual(["V3"]);
    expect(plan.unchanged).toBe(2);
    // Markt ohne MwSt. im Preis → netto
    expect(planResellerPrices([{ shopVariantId: "V1", netCents: 25_13, vatRateBp: 1900 }], [], false, "EUR").add[0].price.amount).toBe("25.13");
  });
});

// ───────────── Datenbank + simuliertes Shopify ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Großhandelspreise im Shop (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { encrypt } = await import("../src/lib/crypto");
  const b2b = await import("../src/lib/shopify/b2b");
  const stamp = Date.now();
  const mail = (n: string) => `${n}.${stamp}@example.com`;

  // Shopify-Zustand
  type Contact = { id: string; customerId: string; roles: string[] };
  type Company = { id: string; name: string; externalId: string; mainContact: string | null; locations: { id: string; name: string; address: unknown; tax: string | null; exemptions: string[] }[]; contacts: Contact[] };
  const S = {
    customers: new Map<string, { id: string; email: string }>(), companies: new Map<string, Company>(), fixed: new Map<string, string>(),
    seq: 100, deny: false, b2bMarket: true, calls: [] as string[],
  };
  const gid = (t: string) => `gid://shopify/${t}/${++S.seq}`;
  const custById = (id: string) => [...S.customers.values()].find((c) => c.id === id)!;
  const companyNode = (c: Company) => ({
    id: c.id, mainContact: c.mainContact ? { id: c.mainContact, customer: { id: c.contacts.find((x) => x.id === c.mainContact)?.customerId } } : null, defaultRole: { id: "gid://shopify/CompanyContactRole/2" },
    contactRoles: { nodes: [{ id: "gid://shopify/CompanyContactRole/1", name: "Location admin" }, { id: "gid://shopify/CompanyContactRole/2", name: "Ordering only" }] },
    locations: { nodes: c.locations.map((l) => ({ id: l.id })) },
    contacts: { nodes: c.contacts.map((x) => ({ id: x.id, customer: { id: x.customerId, email: custById(x.customerId).email }, roleAssignments: { nodes: x.roles.map((r) => ({ companyLocation: { id: r } })) } })) },
  });
  const newCustomer = (email: string) => { const c = { id: gid("Customer"), email }; S.customers.set(email, c); return c; };
  // wie Shopify: deutsche PLZ 5 Ziffern („Zip is invalid“, am 12.11.2026 live mit „0000“), USt-IdNr. DE + 9 Ziffern
  const invalid = (address: { zip?: string; countryCode?: string } | null | undefined, tax: string | null | undefined, path: string[]) => [
    ...(address && address.countryCode === "DE" && !/^\d{5}$/.test(address.zip ?? "") ? [{ field: [...path, "shippingAddress", "zip"], message: "Zip is invalid" }] : []),
    ...(tax && tax.startsWith("DE") && !/^DE\d{9}$/.test(tax) ? [{ field: [...path, "taxRegistrationId"], message: "Tax registration ID is invalid" }] : []),
  ];
  const ok = (data: unknown) => Response.json({ data });
  function mock() {
    return vi.fn(async (_url: string, init: { body: string }) => {
      const { query: q, variables: v } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
      const op = (q.match(/(markets|customers|company|companyCreate|companyAssignCustomerAsContact|companyContactCreate|companyAssignMainContact|companyContactAssignRole|companyContactRemoveFromCompany|companyContactRevokeRoles|companyUpdate|companyLocationUpdate|companyLocationAssignAddress|companyLocationTaxSettingsUpdate|companyLocationCreate|priceListFixedPricesUpdate|priceList)\(/) ?? [])[1] ?? "?";
      S.calls.push(op);
      if (S.deny && op.startsWith("compan") || S.deny && op === "customers")
        return Response.json({ errors: [{ message: "Access denied for customers field. Required access: `read_customers` access scope.", extensions: { code: "ACCESS_DENIED" } }] });
      switch (op) {
        case "markets": return ok({ shop: { taxesIncluded: true }, markets: { nodes: S.b2bMarket ? [
          { id: "M1", name: "Deutschland", status: "ACTIVE", type: "REGION", priceInclusions: { inclusiveTaxPricingStrategy: "INCLUDES_TAXES_IN_PRICE" }, conditions: { companyLocationsCondition: null }, catalogs: { nodes: [] } },
          { id: "M2", name: "جملة الجملة", status: "ACTIVE", type: "COMPANY_LOCATION", priceInclusions: { inclusiveTaxPricingStrategy: "INCLUDES_TAXES_IN_PRICE" }, conditions: { companyLocationsCondition: { applicationLevel: "ALL" } },
            catalogs: { nodes: [{ id: "C1", title: "Wiederverkäufer", status: "ACTIVE", priceList: { id: "gid://shopify/PriceList/9", name: "Wiederverkäufer", currency: "EUR" } }] } },
        ] : [] } });
        case "customers": {
          const email = String(v.q).match(/email:"([^"]+)"/)![1];
          const c = S.customers.get(email);
          return ok({ customers: { nodes: c ? [{ ...c, companyContactProfiles: [...S.companies.values()].flatMap((co) => co.contacts.filter((x) => x.customerId === c.id).map((x) => ({ id: x.id, company: { id: co.id, locations: { nodes: co.locations.map((l) => ({ id: l.id })) } } }))) }] : [] } });
        }
        case "company": { const c = S.companies.get(v.id); return ok({ company: c ? companyNode(c) : null }); }
        case "companyCreate": {
          const i = v.input;
          const bad = invalid(i.companyLocation.shippingAddress, i.companyLocation.taxRegistrationId, ["input", "companyLocation"]);
          if (bad.length) return ok({ companyCreate: { company: null, userErrors: bad } });
          const co: Company = { id: gid("Company"), name: i.company.name, externalId: i.company.externalId, mainContact: null, contacts: [],
            locations: [{ id: gid("CompanyLocation"), name: i.companyLocation.name, address: i.companyLocation.shippingAddress ?? null, tax: i.companyLocation.taxRegistrationId ?? null, exemptions: i.companyLocation.taxExemptions ?? [] }] };
          if (i.companyContact) {
            if (S.customers.has(i.companyContact.email)) return ok({ companyCreate: { company: null, userErrors: [{ field: ["companyContact", "email"], message: "Email has already been taken" }] } });
            const cu = newCustomer(i.companyContact.email);
            const ct = { id: gid("CompanyContact"), customerId: cu.id, roles: [] };  // wie Shopify: Rolle am Standort kommt extra
            co.contacts.push(ct); co.mainContact = ct.id;
          }
          S.companies.set(co.id, co);
          return ok({ companyCreate: { company: { id: co.id, mainContact: co.mainContact ? { id: co.mainContact } : null, locations: { nodes: co.locations.map((l) => ({ id: l.id })) } }, userErrors: [] } });
        }
        case "companyAssignCustomerAsContact": {
          const co = S.companies.get(v.companyId)!; const ct = { id: gid("CompanyContact"), customerId: v.customerId, roles: [] };
          co.contacts.push(ct);
          return ok({ companyAssignCustomerAsContact: { companyContact: { id: ct.id }, userErrors: [] } });
        }
        case "companyContactCreate": {
          const co = S.companies.get(v.companyId)!; const cu = newCustomer(v.input.email); const ct = { id: gid("CompanyContact"), customerId: cu.id, roles: [] };
          co.contacts.push(ct);
          return ok({ companyContactCreate: { companyContact: { id: ct.id, customer: { id: cu.id } }, userErrors: [] } });
        }
        case "companyAssignMainContact": { S.companies.get(v.companyId)!.mainContact = v.contactId; return ok({ companyAssignMainContact: { company: { id: v.companyId }, userErrors: [] } }); }
        case "companyContactAssignRole": {
          const ct = [...S.companies.values()].flatMap((c) => c.contacts).find((x) => x.id === v.contactId)!; ct.roles.push(v.locationId);
          return ok({ companyContactAssignRole: { companyContactRoleAssignment: { id: gid("Role") }, userErrors: [] } });
        }
        case "companyContactRemoveFromCompany": {
          for (const co of S.companies.values()) { co.contacts = co.contacts.filter((x) => x.id !== v.id); if (co.mainContact === v.id) co.mainContact = null; }
          return ok({ companyContactRemoveFromCompany: { removedCompanyContactId: v.id, userErrors: [] } });
        }
        case "companyUpdate": { S.companies.get(v.id)!.name = v.input.name; return ok({ companyUpdate: { company: { id: v.id }, userErrors: [] } }); }
        case "companyLocationUpdate": {
          for (const co of S.companies.values()) for (const l of co.locations) if (l.id === v.id) l.name = v.input.name;
          return ok({ companyLocationUpdate: { companyLocation: { id: v.id }, userErrors: [] } });
        }
        case "companyLocationAssignAddress": {
          const bad = invalid(v.address, null, []);
          if (bad.length) return ok({ companyLocationAssignAddress: { addresses: null, userErrors: bad } });
          for (const co of S.companies.values()) for (const l of co.locations) if (l.id === v.id) l.address = v.address;
          return ok({ companyLocationAssignAddress: { addresses: [{ id: "A" }], userErrors: [] } });
        }
        case "companyLocationTaxSettingsUpdate": {
          const bad = invalid(null, v.tax, []);
          if (bad.length) return ok({ companyLocationTaxSettingsUpdate: { companyLocation: null, userErrors: bad } });
          for (const co of S.companies.values()) for (const l of co.locations) if (l.id === v.id) {
            l.tax = v.tax;
            l.exemptions = [...new Set([...l.exemptions.filter((x) => !(v.remove ?? []).includes(x)), ...(v.add ?? [])])];
          }
          return ok({ companyLocationTaxSettingsUpdate: { companyLocation: { id: v.id }, userErrors: [] } });
        }
        case "priceList": return ok({ priceList: { id: v.id, prices: { nodes: [...S.fixed.entries()].map(([id, amount]) => ({ variant: { id }, price: { amount } })), pageInfo: { hasNextPage: false, endCursor: "" } } } });
        case "priceListFixedPricesUpdate": {
          for (const a of v.add) S.fixed.set(a.variantId, a.price.amount);
          for (const d of v.del) S.fixed.delete(d);
          return ok({ priceListFixedPricesUpdate: { deletedFixedPriceVariantIds: v.del, userErrors: [] } });
        }
        default: return Response.json({ errors: [{ message: `unexpected ${q.slice(0, 80)}` }] });
      }
    });
  }

  let productId = "";
  const customer = async (name: string, email: string, extra: Partial<typeof schema.customers.$inferInsert> = {}) =>
    (await db.insert(schema.customers).values({ name, email, priceGroup: "WHOLESALE", street: "Ringstr. 1", zip: "45711", city: "Datteln", vatId: "DE123456789", ...extra }).returning())[0].id;
  const link = async (id: string) => (await db.query.shopCompanies.findFirst({ where: eq(schema.shopCompanies.customerId, id) }))!;

  beforeAll(async () => {
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", domain: "star-general.myshopify.com", staticTokenEnc: encrypt("shpat_test"), locationId: "gid://shopify/Location/1", active: false })
      .onConflictDoUpdate({ target: schema.shops.channel, set: { domain: "star-general.myshopify.com", staticTokenEnc: encrypt("shpat_test"), locationId: "gid://shopify/Location/1" } });
    const [p] = await db.insert(schema.products).values({ sku: `B2B-${stamp}`, nameDe: "Haarspray", vatRateBp: 1900, wholesalePriceCents: 25_13, retailPriceCents: 30_00 }).returning();
    productId = p.id;
    const [v1] = await db.insert(schema.variants).values({ productId: p.id, size: "300 ml" }).returning();
    const [v2] = await db.insert(schema.variants).values({ productId: p.id, size: "500 ml", wholesalePriceCents: 40_00 }).returning();
    await db.insert(schema.shopVariants).values([
      { channel: "GENERAL_SHOP", shopVariantId: `gid://shopify/ProductVariant/${stamp}1`, variantId: v1.id },
      { channel: "GENERAL_SHOP", shopVariantId: `gid://shopify/ProductVariant/${stamp}2`, variantId: v2.id },
    ]);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("Häkchen → Unternehmen mit Standort, Kontakt per E-Mail, Rolle am Standort; Gruppe „جملة“ → Kontakt raus", async () => {
    vi.stubGlobal("fetch", mock());
    const id = await customer("Ali Friseurbedarf", ` ${mail("Ali").toUpperCase()} `);
    expect(await b2b.setResellerWanted(id, true)).toBe(true);
    const r = await b2b.syncShopCompany(id);
    expect(r).toMatchObject({ status: "linked", error: "", email: mail("ali") });
    const co = S.companies.get(r!.companyId)!;
    expect(co).toMatchObject({ name: "Ali Friseurbedarf", locations: [{ name: "Ali Friseurbedarf – Datteln", tax: "DE123456789", address: { address1: "Ringstr. 1", zip: "45711", city: "Datteln", countryCode: "DE" } }] });
    expect(co.contacts).toHaveLength(1);
    expect(co.contacts[0].roles).toEqual([r!.locationId]); // darf für den Standort bestellen
    expect(custById(co.contacts[0].customerId).email).toBe(mail("ali"));
    // nochmal speichern ohne Änderung → nichts zu tun
    expect(await b2b.setResellerWanted(id, true)).toBe(false);
    // Anschrift geändert → im Shop nachgezogen
    await db.update(schema.customers).set({ street: "Neue Str. 5" }).where(eq(schema.customers.id, id));
    expect(await b2b.setResellerWanted(id, true)).toBe(true);
    expect(await b2b.syncShopCompany(id)).toMatchObject({ status: "linked" });
    expect(co.locations[0].address).toMatchObject({ address1: "Neue Str. 5" });
    // Name geändert (z. B. hatte der Kunde aus dem Shop bei der Anlage nur die E-Mail als Namen) → Unternehmen UND Standort heißen wie im System
    await db.update(schema.customers).set({ name: "Ali Friseurbedarf GmbH" }).where(eq(schema.customers.id, id));
    expect(await b2b.setResellerWanted(id, true)).toBe(true);
    expect(await b2b.syncShopCompany(id)).toMatchObject({ status: "linked" });
    expect(co).toMatchObject({ name: "Ali Friseurbedarf GmbH", locations: [{ name: "Ali Friseurbedarf GmbH – Datteln" }] });
    // E-Mail geändert → alter Kontakt raus, neuer rein
    await db.update(schema.customers).set({ email: mail("ali.neu") }).where(eq(schema.customers.id, id));
    expect(await b2b.setResellerWanted(id, true)).toBe(true);
    expect(await b2b.syncShopCompany(id)).toMatchObject({ status: "linked", email: mail("ali.neu") });
    expect(co.contacts.map((x) => custById(x.customerId).email)).toEqual([mail("ali.neu")]);
    expect(co.contacts[0].roles).toEqual([r!.locationId]);
    // Preisgruppe „جملة“ → Kontakt aus dem Unternehmen (sieht wieder normale Preise), Unternehmen bleibt
    await db.update(schema.customers).set({ priceGroup: "RETAIL" }).where(eq(schema.customers.id, id));
    expect(await b2b.setResellerWanted(id, false)).toBe(true);
    expect(await b2b.syncShopCompany(id)).toMatchObject({ status: "removed", contactId: "" });
    expect(co.contacts).toHaveLength(0);
    expect(S.companies.has(co.id)).toBe(true);
    // wieder „جملة الجملة“ + Häkchen → dasselbe Unternehmen, Kontakt wieder da
    await db.update(schema.customers).set({ priceGroup: "WHOLESALE" }).where(eq(schema.customers.id, id));
    expect(await b2b.setResellerWanted(id, true)).toBe(true);
    expect(await b2b.syncShopCompany(id)).toMatchObject({ status: "linked", companyId: co.id });
    expect(co.contacts).toHaveLength(1);
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(audit.filter((a) => a.action === "shop_reseller").length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("Shop-Kunde mit der E-Mail gibt es schon → wird Kontakt (kein Doppel); dieselbe E-Mail bei zweitem Kunden → Fehler", async () => {
    vi.stubGlobal("fetch", mock());
    const existing = newCustomer(mail("bob"));
    const id = await customer("Bob Salonbedarf", mail("bob"), { vatId: "" });
    await b2b.setResellerWanted(id, true);
    const r = await b2b.syncShopCompany(id);
    expect(r).toMatchObject({ status: "linked", shopCustomerId: existing.id });
    const co = S.companies.get(r!.companyId)!;
    expect(co.contacts.map((x) => x.customerId)).toEqual([existing.id]);
    expect(co.mainContact).toBe(co.contacts[0].id);
    expect(co.locations[0].tax).toBeNull();
    const twin = await customer("Bob zweiter Eintrag", mail("bob"));
    await b2b.setResellerWanted(twin, true);
    expect(await b2b.syncShopCompany(twin)).toMatchObject({ status: "failed", error: "emailUsed" });
  }, 30_000);

  it("PLZ „0000“ + kurze USt-IdNr. lehnt Shopify ab → trotzdem verbunden (Preise gehen), Hinweis; korrigiert → nachgetragen", async () => {
    vi.stubGlobal("fetch", mock());
    const id = await customer("محمود", mail("mahmoud"), { zip: "0000", street: "germany", city: "obour", vatId: "DE5977154" });
    await b2b.setResellerWanted(id, true);
    const r = await b2b.syncShopCompany(id);
    expect(r).toMatchObject({ status: "linked" });
    expect(r!.error.split("|").map((n) => n.split(":")[0]).sort()).toEqual(["noAddress", "noTax"]);
    const co = S.companies.get(r!.companyId)!;
    expect(co.locations[0]).toMatchObject({ address: null, tax: null });
    expect(co.contacts[0].roles).toEqual([r!.locationId]); // darf bestellen → sieht die Preise
    // nochmal speichern (immer noch falsch) → erneut versucht, Hinweis bleibt
    expect(await b2b.setResellerWanted(id, true)).toBe(true);
    expect((await b2b.syncShopCompany(id))!.error).toMatch(/noAddress:Zip is invalid/);
    // korrigiert → Anschrift + Nummer im Shop, Hinweis weg; danach nichts mehr zu tun
    await db.update(schema.customers).set({ zip: "45711", street: "Provinzialstraße 45", city: "Datteln", vatId: "DE123456789" }).where(eq(schema.customers.id, id));
    expect(await b2b.setResellerWanted(id, true)).toBe(true);
    expect(await b2b.syncShopCompany(id)).toMatchObject({ status: "linked", error: "" });
    expect(co.locations[0]).toMatchObject({ address: { zip: "45711", city: "Datteln" }, tax: "DE123456789" });
    expect(await b2b.setResellerWanted(id, true)).toBe(false);
    const ev = await db.select().from(schema.shopEvents).where(eq(schema.shopEvents.ref, mail("mahmoud")));
    expect(ev.some((e) => e.message.startsWith("resellerPartial:"))).toBe(true);
  }, 30_000);

  it("Niederlande mit gültiger USt-IdNr. → Reverse Charge am Standort; Prüfung ungültig → wieder MwSt.; DE nie (20.11.2026)", async () => {
    vi.stubGlobal("fetch", mock());
    const id = await customer("Barbershop Hozan", mail("hozan"), { street: "Markt 1", zip: "7772 CD", city: "Hardenberg", country: "NL", vatId: "NL005542463B59", vatIdStatus: "VALID" });
    await b2b.setResellerWanted(id, true);
    const r = await b2b.syncShopCompany(id);
    expect(r).toMatchObject({ status: "linked", error: "" });
    const co = S.companies.get(r!.companyId)!;
    expect(co.locations[0]).toMatchObject({ name: "Barbershop Hozan – Hardenberg", tax: "NL005542463B59", exemptions: [EU_REVERSE_CHARGE] });
    // Prüfung beim Amt jetzt ungültig (Knopf „Prüfen“, ohne Speichern) → Befreiung weg, Nummer bleibt
    await db.update(schema.customers).set({ vatIdStatus: "INVALID" }).where(eq(schema.customers.id, id));
    await b2b.refreshShopCompanies(id);
    expect(co.locations[0]).toMatchObject({ tax: "NL005542463B59", exemptions: [] });
    expect(await link(id)).toMatchObject({ status: "linked", error: "" });
    // wieder gültig, diesmal merkt es der Worker von selbst (alle 5 min)
    await db.update(schema.customers).set({ vatIdStatus: "VALID" }).where(eq(schema.customers.id, id));
    for (let i = 0; i < 10 && !co.locations[0].exemptions.length; i++) await b2b.retryShopCompanies();
    expect(co.locations[0].exemptions).toEqual([EU_REVERSE_CHARGE]);
    expect(await b2b.setResellerWanted(id, true)).toBe(false); // danach nichts mehr zu tun
    // Firma in Deutschland mit gültiger Nummer → keine Befreiung (19 %)
    const de = await customer("Salon Datteln", mail("datteln"), { vatId: "DE123456789", vatIdStatus: "VALID" });
    await b2b.setResellerWanted(de, true);
    const rd = await b2b.syncShopCompany(de);
    expect(S.companies.get(rd!.companyId)!.locations[0]).toMatchObject({ tax: "DE123456789", exemptions: [] });
  }, 60_000);

  it("Recht fehlt → bleibt vorgemerkt; nach Freigabe verbindet der Worker", async () => {
    vi.stubGlobal("fetch", mock());
    S.deny = true;
    const id = await customer("Carla Haarstudio", mail("carla"));
    await b2b.setResellerWanted(id, true);
    expect(await b2b.syncShopCompany(id)).toMatchObject({ status: "pending", error: "needScope" });
    S.deny = false;
    // der Worker nimmt höchstens 30 vorgemerkte je Durchlauf (in der Test-DB warten evtl. ältere, z. B. im Marken-Shop ohne Domain)
    expect(await b2b.retryShopCompanies()).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 10 && (await link(id)).status !== "linked"; i++) await b2b.retryShopCompanies();
    expect(await link(id)).toMatchObject({ status: "linked", error: "" });
  }, 60_000);

  it("Ein Häkchen gilt für beide Shops: Unternehmen im allgemeinen UND im Marken-Shop (13.11.2026)", async () => {
    const before = await db.query.shops.findFirst({ where: eq(schema.shops.channel, "BRAND_SHOP") });
    await db.insert(schema.shops).values({ channel: "BRAND_SHOP", domain: "star-brand.myshopify.com", staticTokenEnc: encrypt("shpat_brand"), locationId: "gid://shopify/Location/2", active: false })
      .onConflictDoUpdate({ target: schema.shops.channel, set: { domain: "star-brand.myshopify.com", staticTokenEnc: encrypt("shpat_brand"), locationId: "gid://shopify/Location/2" } });
    try {
      const f = mock();
      vi.stubGlobal("fetch", f);
      const id = await customer("Dana Barber", mail("dana"));
      for (const ch of b2b.RESELLER_CHANNELS) expect(await b2b.setResellerWanted(id, true, undefined, ch)).toBe(true);
      // der Nachbau teilt sich die Kunden zwischen den Shops → nacheinander (echt: jeder Shop hat eigene Kunden, dann parallel)
      const rows = [...await b2b.syncShopCompanyNow(id, 20_000, ["GENERAL_SHOP"]), ...await b2b.syncShopCompanyNow(id, 20_000, ["BRAND_SHOP"])];
      expect(rows.map((r) => r.channel).sort()).toEqual(["BRAND_SHOP", "GENERAL_SHOP"]);
      for (const r of rows) expect(r).toMatchObject({ status: "linked", email: mail("dana") });
      // beide Shops wurden gefragt
      const hosts = new Set(f.mock.calls.map(([u]) => new URL(String(u)).host));
      expect(hosts).toEqual(new Set(["star-general.myshopify.com", "star-brand.myshopify.com"]));
      // Kundenseite: Stand je Shop in fester Reihenfolge
      expect((await b2b.shopCompaniesOf(id)).map((x) => [x.channel, x.link?.status])).toEqual([["GENERAL_SHOP", "linked"], ["BRAND_SHOP", "linked"]]);
      // Häkchen weg → in beiden Shops getrennt
      for (const ch of b2b.RESELLER_CHANNELS) expect(await b2b.setResellerWanted(id, false, undefined, ch)).toBe(true);
      for (const r of await b2b.syncShopCompanyNow(id, 20_000)) expect(r).toMatchObject({ status: "removed", contactId: "" });
    } finally {
      await db.update(schema.shops).set({ domain: before?.domain ?? "", staticTokenEnc: before?.staticTokenEnc ?? "", locationId: before?.locationId ?? "" })
        .where(eq(schema.shops.channel, "BRAND_SHOP"));
    }
  }, 60_000);

  it("Preisliste: Großhandelspreise brutto, Variantenpreis vor Artikelpreis, ohne Preis → entfernt; kein B2B-Markt → nichts", async () => {
    vi.stubGlobal("fetch", mock());
    const sv1 = `gid://shopify/ProductVariant/${stamp}1`, sv2 = `gid://shopify/ProductVariant/${stamp}2`;
    const [r] = await b2b.pushResellerPrices(undefined, "GENERAL_SHOP");
    expect(r).toMatchObject({ removed: 0, failed: 0 });
    expect(r.updated).toBeGreaterThanOrEqual(2);
    expect(S.fixed.get(sv1)).toBe("29.90"); // 25,13 netto → 29,90 brutto
    expect(S.fixed.get(sv2)).toBe("47.60"); // eigener Variantenpreis 40,00 netto
    expect((await b2b.pushResellerPrices([productId]))[0]).toMatchObject({ updated: 0, unchanged: 2 });
    await db.update(schema.products).set({ wholesalePriceCents: 0 }).where(eq(schema.products.id, productId));
    expect((await b2b.pushResellerPrices([productId]))[0]).toMatchObject({ removed: 1, unchanged: 1 });
    expect(S.fixed.has(sv1)).toBe(false);
    expect(S.fixed.get(sv2)).toBe("47.60");
    S.b2bMarket = false;
    const shop = (await db.query.shops.findFirst({ where: eq(schema.shops.channel, "GENERAL_SHOP") }))!;
    expect(await b2b.resellerSetup(shop, true)).toEqual({ problem: "noMarket" });
    expect((await b2b.pushResellerPrices(undefined, "GENERAL_SHOP"))[0]).toMatchObject({ problem: "noMarket", retry: false });
    S.b2bMarket = true;
    await b2b.resellerSetup(shop, true);
    const events = await db.select().from(schema.shopEvents).where(eq(schema.shopEvents.channel, "GENERAL_SHOP"));
    expect(events.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^resellerPricesPushed:\d+\|0\|0/), expect.stringMatching(/^resellerLinked:/)]));
  }, 30_000);
});
