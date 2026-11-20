import "server-only";
/**
 * Wiederverkäufer im Online-Shop (Wunsch Inhaber 12.11.2026, seit 13.11.2026 in beiden Shops): Kunden „جملة الجملة“ sehen nach dem Anmelden im Shop ihre Preise.
 * Shopify B2B (seit 04/2026 auch im Basic-Tarif): im Shop ein B2B-Markt für alle Unternehmensstandorte mit Katalog + Preisliste.
 * - Kunde: Häkchen am Kunden → Unternehmen im Shop (Firma, Standort mit Anschrift + USt-IdNr.), Kontakt = Shop-Kunde mit
 *   derselben E-Mail (nie über den Namen). Anmeldung im Shop mit dieser E-Mail (Code per E-Mail) → Preise der Preisliste.
 *   Häkchen weg / Gruppe „جملة“ / E-Mail geändert → Kontakt wird aus dem Unternehmen genommen (Unternehmen bleibt, nichts gelöscht).
 * - Preise: Festpreise der Preisliste = جملة الجملة-Preis (wholesale_price_cents) wie im Shop gezeigt; nur Abweichungen.
 * Rechte der App: read_customers + write_customers (Unternehmen, Kunden per E-Mail), read_markets (Markt finden), write_products (Preisliste).
 * Logik rein + getestet in ./b2b-map.ts.
 */
import { and, asc, eq, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, getShop, refreshTokenOnce, ShopifyError, type Shop, type ShopChannel } from "./client";
import { configured, withProductLock } from "./admin";
import { activeDiscounts } from "../promotions";
import { CHANNELS, logEvent } from "./sync";
import {
  ALL_PARTS, chunks, companyAddress, companyCreateInput, companyFingerprint, contactName, locationName, normEmail, partNote, pickResellerSetup, planResellerPrices,
  rejectedParts, shownInShop, taxSettingsUpdate, validEmail,
  type B2bCustomer, type CompanyParts, type FixedPrice, type MarketNode, type ResellerProblem, type ResellerSetup,
} from "./b2b-map";

export type ShopCompany = typeof schema.shopCompanies.$inferSelect;

/** fehlendes App-Recht (Shopify: „Access denied … Required access …“) */
const SCOPE_RE = /access denied|not approved|required access|access scope/i;
/** Tarif/Shop ohne B2B */
const NO_B2B_RE = /b2b|plan does not|not available for this shop|feature is not available/i;

export class B2bError extends Error {
  constructor(public code: string, message = code) { super(message); }
}
type UserError = { field?: string[] | null; message: string };
const check = (errs: UserError[] | undefined | null, what: string) => {
  if (errs?.length) throw new B2bError("userErrors", `${what}: ${errs.map((e) => e.message).join("; ")}`.slice(0, 400));
};

/** fehlendes Recht → einmal mit neuem Token (der zwischengespeicherte kann von vor der Freigabe stammen) */
async function call<T>(shop: Shop, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  try {
    return await gql<T>(shop, query, variables);
  } catch (e) {
    if (e instanceof ShopifyError && e.code === "graphql" && SCOPE_RE.test(e.message) && (await refreshTokenOnce(shop))) return gql<T>(shop, query, variables);
    throw e;
  }
}

// ───────────────────────── B2B-Markt + Preisliste finden ─────────────────────────

const MARKETS_Q = `{ shop { taxesIncluded } markets(first: 50) { nodes { id name status type
  priceInclusions { inclusiveTaxPricingStrategy }
  conditions { companyLocationsCondition { applicationLevel } }
  catalogs(first: 10) { nodes { id title status priceList { id name currency } } } } } }`;
// ohne Recht read_markets: Preisliste über den Namen finden
const PRICE_LISTS_Q = `{ shop { taxesIncluded } priceLists(first: 50) { nodes { id name currency catalog { title status } } } }`;
const NAME_RE = /wiederverk|reseller|جملة الجملة|جملة جملة/i;

export type SetupResult = ResellerSetup | { problem: ResellerProblem | "needScope" | "unreachable" | "error"; detail?: string };
const setupCache = new Map<string, { at: number; value: SetupResult }>();
const isTransient = (e: unknown) => e instanceof ShopifyError && (e.code === "network" || e.code === "throttled");
const isScope = (e: unknown) => e instanceof ShopifyError && e.code === "graphql" && SCOPE_RE.test(e.message);

/**
 * B2B-Markt mit Preisliste im Shop (10 min zwischengespeichert; fresh = neu nachsehen). Klappt die Abfrage der Märkte nicht
 * (Recht read_markets fehlt, andere API-Version …), wird die Preisliste über den Namen gesucht („جملة الجملة …“/„Wiederverkäufer“).
 * unreachable = Shop kurz weg (später noch einmal), sonst bleibt es so, bis jemand im Shop etwas ändert.
 */
export async function resellerSetup(shop: Shop, fresh = false): Promise<SetupResult> {
  const hit = setupCache.get(shop.channel);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  let value: SetupResult;
  try {
    const d = await call<{ shop: { taxesIncluded: boolean }; markets: { nodes: MarketNode[] } }>(shop, MARKETS_Q);
    value = pickResellerSetup(d.markets.nodes, d.shop.taxesIncluded);
  } catch (e) {
    if (isTransient(e)) value = { problem: "unreachable", detail: (e as Error).message.slice(0, 200) };
    else {
      try {
        const d = await call<{ shop: { taxesIncluded: boolean }; priceLists: { nodes: { id: string; name: string; currency: string; catalog: { title: string; status: string } | null }[] } }>(shop, PRICE_LISTS_Q);
        const pl = d.priceLists.nodes.find((x) => NAME_RE.test(`${x.name} ${x.catalog?.title ?? ""}`));
        value = pl ? { priceListId: pl.id, currency: pl.currency, marketName: "", catalogTitle: pl.catalog?.title ?? pl.name, taxesIncluded: d.shop.taxesIncluded, allLocations: true }
          : isScope(e) ? { problem: "needScope" } : { problem: "error", detail: (e as Error).message.slice(0, 200) };
      } catch (e2) {
        value = isTransient(e2) ? { problem: "unreachable" } : { problem: isScope(e) || isScope(e2) ? "needScope" : "error", detail: (e2 as Error).message.slice(0, 200) };
      }
    }
  }
  setupCache.set(shop.channel, { at: Date.now(), value });
  return value;
}

// ───────────────────────── Preisliste füllen ─────────────────────────

const FIXED_Q = `query($id: ID!, $after: String) { priceList(id: $id) { id prices(first: 250, after: $after, originType: FIXED) {
  nodes { variant { id } price { amount } compareAtPrice { amount } } pageInfo { hasNextPage endCursor } } } }`;
const FIXED_M = `mutation($id: ID!, $add: [PriceListPriceInput!]!, $del: [ID!]!) {
  priceListFixedPricesUpdate(priceListId: $id, pricesToAdd: $add, variantIdsToDelete: $del) { deletedFixedPriceVariantIds userErrors { field message } } }`;

export type ResellerPush = { channel: ShopChannel; updated: number; removed: number; failed: number; unchanged: number; retry: boolean; problem?: string };
const transient = (e: unknown) => !(e instanceof ShopifyError) || e.code === "network" || e.code === "throttled";

/**
 * Festpreise der Wiederverkäufer-Preisliste abgleichen. productIds: nur diese Artikel (nach dem Speichern), sonst alle
 * verbundenen Varianten. Shops ohne B2B-Markt werden übersprungen (problem).
 */
export async function pushResellerPrices(productIds?: string[], only?: ShopChannel): Promise<ResellerPush[]> {
  if (productIds && !productIds.length) return [];
  const out: ResellerPush[] = [];
  for (const channel of CHANNELS) {
    if (only && channel !== only) continue;
    const shop = await getShop(channel);
    if (!configured(shop)) continue;
    const setup = await resellerSetup(shop, !productIds);
    if ("problem" in setup) { out.push({ channel, updated: 0, removed: 0, failed: 0, unchanged: 0, retry: setup.problem === "unreachable", problem: setup.problem }); continue; }
    const promo = await activeDiscounts(channel, productIds); // Aktionen: Wiederverkäufer bekommen denselben Rabatt
    const rows = (await db.execute<{ shop_variant_id: string; product_id: string; net: number; vat: number }>(sql`
      select sv.shop_variant_id, p.id as product_id, coalesce(nullif(v.wholesale_price_cents, 0), p.wholesale_price_cents) as net, p.vat_rate_bp as vat
      from shop_variants sv join variants v on v.id = sv.variant_id join products p on p.id = v.product_id
      where sv.channel = ${channel} and v.active
        ${productIds ? sql`and p.id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`)).rows
      .map((r) => ({ shopVariantId: r.shop_variant_id, netCents: Number(r.net), vatRateBp: Number(r.vat), promoBp: promo.get(String(r.product_id)) ?? 0 }));
    if (!rows.length) continue;
    let updated = 0, removed = 0, failed = 0, unchanged = 0, retry = false, firstError = "";
    try {
      const current: FixedPrice[] = [];
      let after: string | null = null;
      do {
        const d: { priceList: { prices: { nodes: { variant: { id: string } | null; price: { amount: string }; compareAtPrice: { amount: string } | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } =
          await call(shop, FIXED_Q, { id: setup.priceListId, after });
        if (!d.priceList) throw new ShopifyError("graphql", "Preisliste nicht gefunden");
        for (const n of d.priceList.prices.nodes) if (n.variant) current.push({ variantId: n.variant.id, amount: n.price.amount, compareAt: n.compareAtPrice?.amount ?? null });
        after = d.priceList.prices.pageInfo.hasNextPage ? d.priceList.prices.pageInfo.endCursor : null;
      } while (after);
      const plan = planResellerPrices(rows, current, setup.taxesIncluded, setup.currency);
      unchanged = plan.unchanged;
      const batches = Math.max(Math.ceil(plan.add.length / 250), Math.ceil(plan.del.length / 250));
      for (let i = 0; i < batches; i++) {
        const add = plan.add.slice(i * 250, (i + 1) * 250), del = plan.del.slice(i * 250, (i + 1) * 250);
        try {
          const d = await call<{ priceListFixedPricesUpdate: { userErrors: UserError[] } }>(shop, FIXED_M, { id: setup.priceListId, add, del });
          const errs = d.priceListFixedPricesUpdate.userErrors;
          if (errs.length) { failed += add.length + del.length; firstError ||= errs[0].message; } else { updated += add.length; removed += del.length; }
        } catch (e) { failed += add.length + del.length; firstError ||= (e as Error).message; retry ||= transient(e); }
      }
    } catch (e) {
      failed = rows.length; firstError = (e as Error).message; retry = transient(e);
      setupCache.delete(channel); // vielleicht Preisliste gelöscht/neu → beim nächsten Mal neu suchen
    }
    if (updated || removed || failed || !productIds)
      await logEvent(channel, failed ? "warn" : "info", "products", `resellerPricesPushed:${updated}|${removed}|${failed}${firstError ? `|${firstError.slice(0, 200)}` : ""}`);
    out.push({ channel, updated, removed, failed, unchanged, retry });
  }
  return out;
}

// ───────────────────────── Kunde ↔ Unternehmen ─────────────────────────

const CUSTOMER_Q = `query($q: String!) { customers(first: 10, query: $q) { nodes { id email
  companyContactProfiles { id company { id locations(first: 5) { nodes { id } } } } } } }`;
const COMPANY_Q = `query($id: ID!) { company(id: $id) { id mainContact { id } defaultRole { id }
  contactRoles(first: 10) { nodes { id name } } locations(first: 10) { nodes { id } }
  contacts(first: 100) { nodes { id customer { id email } roleAssignments(first: 20) { nodes { companyLocation { id } } } } } } }`;
const COMPANY_CREATE_M = `mutation($input: CompanyCreateInput!) { companyCreate(input: $input) {
  company { id mainContact { id customer { id } } locations(first: 1) { nodes { id } } } userErrors { field message } } }`;
const LOCATION_CREATE_M = `mutation($id: ID!, $input: CompanyLocationInput!) { companyLocationCreate(companyId: $id, input: $input) { companyLocation { id } userErrors { field message } } }`;
const ASSIGN_CUSTOMER_M = `mutation($companyId: ID!, $customerId: ID!) { companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
  companyContact { id } userErrors { field message } } }`;
const CONTACT_CREATE_M = `mutation($companyId: ID!, $input: CompanyContactInput!) { companyContactCreate(companyId: $companyId, input: $input) {
  companyContact { id customer { id } } userErrors { field message } } }`;
const MAIN_CONTACT_M = `mutation($companyId: ID!, $contactId: ID!) { companyAssignMainContact(companyId: $companyId, companyContactId: $contactId) { company { id } userErrors { field message } } }`;
const ASSIGN_ROLE_M = `mutation($contactId: ID!, $roleId: ID!, $locationId: ID!) {
  companyContactAssignRole(companyContactId: $contactId, companyContactRoleId: $roleId, companyLocationId: $locationId) { companyContactRoleAssignment { id } userErrors { field message } } }`;
const CONTACT_REMOVE_M = `mutation($id: ID!) { companyContactRemoveFromCompany(companyContactId: $id) { removedCompanyContactId userErrors { field message } } }`;
const REVOKE_M = `mutation($id: ID!) { companyContactRevokeRoles(companyContactId: $id, revokeAll: true) { revokedRoleAssignmentIds userErrors { field message } } }`;
const COMPANY_UPDATE_M = `mutation($id: ID!, $input: CompanyInput!) { companyUpdate(companyId: $id, input: $input) { company { id } userErrors { field message } } }`;
const LOCATION_UPDATE_M = `mutation($id: ID!, $input: CompanyLocationUpdateInput!) { companyLocationUpdate(companyLocationId: $id, input: $input) {
  companyLocation { id } userErrors { field message } } }`;
const ADDRESS_M = `mutation($id: ID!, $address: CompanyAddressInput!) { companyLocationAssignAddress(locationId: $id, address: $address, addressTypes: [BILLING, SHIPPING]) {
  addresses { id } userErrors { field message } } }`;
// USt-IdNr. + Reverse Charge (EU_REVERSE_CHARGE_EXEMPTION_RULE) an bzw. aus – siehe reverseCharge() in b2b-map.ts
const TAX_M = `mutation($id: ID!, $tax: String, $add: [TaxExemption!], $remove: [TaxExemption!]) {
  companyLocationTaxSettingsUpdate(companyLocationId: $id, taxRegistrationId: $tax, exemptionsToAssign: $add, exemptionsToRemove: $remove) { companyLocation { id } userErrors { field message } } }`;

type CompanyState = {
  id: string; mainContact: { id: string } | null; defaultRole: { id: string } | null; contactRoles: { nodes: { id: string; name: string }[] };
  locations: { nodes: { id: string }[] };
  contacts: { nodes: { id: string; customer: { id: string; email: string | null } | null; roleAssignments: { nodes: { companyLocation: { id: string } | null }[] } }[] };
};
const companyState = async (shop: Shop, id: string) => (await call<{ company: CompanyState | null }>(shop, COMPANY_Q, { id })).company;

/** Shop-Kunde mit genau dieser E-Mail (Shopify sucht unscharf → genau vergleichen) */
async function shopCustomer(shop: Shop, email: string) {
  const d = await call<{ customers: { nodes: { id: string; email: string | null; companyContactProfiles: { id: string; company: { id: string; locations: { nodes: { id: string }[] } } }[] }[] } }>(
    shop, CUSTOMER_Q, { q: `email:"${email}"` });
  return d.customers.nodes.find((c) => normEmail(c.email ?? "") === email) ?? null;
}

const toB2b = (c: typeof schema.customers.$inferSelect): B2bCustomer => ({
  number: c.number, type: c.type, name: c.name, contact: c.contact, email: c.email, street: c.street, zip: c.zip, city: c.city, country: c.country, vatId: c.vatId,
  vatIdStatus: c.vatIdStatus,
});

/** Soll dieser Kunde im Shop die Wiederverkäuferpreise sehen? (Häkchen + Gruppe „جملة الجملة“ + gültige E-Mail + aktiv) */
export const resellerWanted = (row: Pick<ShopCompany, "wanted">, c: Pick<typeof schema.customers.$inferSelect, "active" | "priceGroup" | "email"> | undefined | null) =>
  Boolean(row.wanted && c && c.active && c.priceGroup === "WHOLESALE" && validEmail(c.email));

/**
 * Häkchen am Kunden speichern (Kundenformular). Ohne Zeile und ohne Häkchen passiert nichts.
 * Rückgabe: true = im Shop ist etwas zu tun (gleich abgleichen).
 */
export async function setResellerWanted(customerId: string, wanted: boolean, userId?: string, channel: ShopChannel = "GENERAL_SHOP"): Promise<boolean> {
  return db.transaction(async (tx) => {
    const row = await tx.query.shopCompanies.findFirst({ where: and(eq(schema.shopCompanies.customerId, customerId), eq(schema.shopCompanies.channel, channel)) });
    const c = await tx.query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
    if (!row) {
      if (!wanted) return false;
      await tx.insert(schema.shopCompanies).values({ customerId, channel, wanted: true, status: "pending" });
      await tx.insert(schema.auditLog).values({ entity: "customer", entityId: customerId, action: "shop_reseller", after: { channel, wanted: true }, userId });
      return true;
    }
    const now = resellerWanted({ wanted }, c);
    // nichts geändert und im Shop schon so → nichts zu tun
    const same = row.wanted === wanted && (now
      ? row.status === "linked" && row.email === normEmail(c!.email) && row.fingerprint === companyFingerprint(toB2b(c!))
      : row.status === "removed" || (!row.contactId && row.status !== "failed"));
    if (row.wanted !== wanted) {
      await tx.update(schema.shopCompanies).set({ wanted, updatedAt: new Date() }).where(eq(schema.shopCompanies.id, row.id));
      await tx.insert(schema.auditLog).values({ entity: "customer", entityId: customerId, action: "shop_reseller", before: { wanted: row.wanted }, after: { channel, wanted }, userId });
    }
    if (same) return false;
    await tx.update(schema.shopCompanies).set({ status: "pending", error: "", tries: 0, updatedAt: new Date() }).where(eq(schema.shopCompanies.id, row.id));
    return true;
  });
}

/**
 * Verbindung im Shop herstellen bzw. lösen (unter einer Sperre je Kunde). Shop nicht erreichbar → bleibt „pending“, der Worker
 * versucht es alle 5 min wieder; Recht fehlt → „pending“ + needScope; Shopify lehnt ab → „failed“ mit Meldung.
 */
export async function syncShopCompany(customerId: string, channel: ShopChannel = "GENERAL_SHOP"): Promise<ShopCompany | null> {
  return withProductLock(`company:${channel}:${customerId}`, async () => {
    const row = await db.query.shopCompanies.findFirst({ where: and(eq(schema.shopCompanies.customerId, customerId), eq(schema.shopCompanies.channel, channel)) });
    if (!row) return null;
    const set = (v: Partial<ShopCompany>) => db.update(schema.shopCompanies).set({ ...v, updatedAt: new Date() }).where(eq(schema.shopCompanies.id, row.id));
    const reload = async () => (await db.query.shopCompanies.findFirst({ where: eq(schema.shopCompanies.id, row.id) })) ?? null;
    const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
    const shop = await getShop(channel);
    if (!configured(shop)) { await set({ error: "notConfigured", tries: row.tries + 1 }); return reload(); }
    try {
      if (!resellerWanted(row, c)) {
        // Kontakt aus dem Unternehmen nehmen → sieht wieder die normalen Preise (Unternehmen bleibt im Shop)
        if (row.contactId) await removeContact(shop, row.contactId);
        await set({ status: "removed", contactId: "", error: "", tries: 0, syncedAt: new Date() });
        if (row.contactId) await logEvent(channel, "info", "customers", `resellerRemoved:${c?.name ?? ""}`, row.email);
        return reload();
      }
      const cust = c!;
      const email = normEmail(cust.email);
      // dieselbe E-Mail darf nur bei einem Kunden verbunden sein
      const dup = await db.select({ id: schema.shopCompanies.id }).from(schema.shopCompanies)
        .innerJoin(schema.customers, eq(schema.customers.id, schema.shopCompanies.customerId))
        .where(and(eq(schema.shopCompanies.channel, channel), eq(schema.shopCompanies.wanted, true), ne(schema.shopCompanies.customerId, customerId),
          eq(schema.customers.priceGroup, "WHOLESALE"), sql`lower(trim(${schema.customers.email})) = ${email}`));
      if (dup.length) { await set({ status: "failed", error: "emailUsed", tries: row.tries + 1 }); return reload(); }

      const b2b = toB2b(cust);
      const sc = await shopCustomer(shop, email);
      let companyId = row.companyId, locationId = row.locationId, contactId = row.contactId;
      let state = companyId ? await companyState(shop, companyId) : null;
      if (companyId && !state) companyId = locationId = contactId = ""; // im Shop gelöscht → neu
      let created = false;
      // Anschrift/USt-IdNr., die Shopify ablehnt (z. B. PLZ „0000“, 12.11.2026), lassen wir weg – die Preise gehen auch ohne;
      // die Kundenseite zeigt den Hinweis, nach dem Korrigieren + Speichern wird es nachgetragen (Fingerabdruck ohne diese Teile)
      const parts: CompanyParts = { ...ALL_PARTS };
      const notes: string[] = [];
      if (!companyId) {
        const prof = sc?.companyContactProfiles[0];
        if (prof) {
          // diese E-Mail ist im Shop schon Kontakt eines Unternehmens (z. B. von Hand oder vor dem Zurücksetzen angelegt) → das nehmen
          companyId = prof.company.id; contactId = prof.id; locationId = prof.company.locations.nodes[0]?.id ?? "";
        } else {
          for (;;) {
            const d = await call<{ companyCreate: { company: { id: string; mainContact: { id: string } | null; locations: { nodes: { id: string }[] } } | null; userErrors: UserError[] } }>(
              shop, COMPANY_CREATE_M, { input: companyCreateInput(b2b, !sc, parts) });
            const errs = d.companyCreate.userErrors ?? [];
            if (errs.length) {
              const bad = rejectedParts(errs);
              const dropAddress = parts.address && bad.address, dropTax = parts.tax && bad.tax;
              if (!dropAddress && !dropTax) check(errs, "companyCreate"); // nichts mehr wegzulassen → Fehler
              if (dropAddress) { parts.address = false; notes.push(partNote("noAddress", errs)); }
              if (dropTax) { parts.tax = false; notes.push(partNote("noTax", errs)); }
              continue;
            }
            companyId = d.companyCreate.company!.id;
            locationId = d.companyCreate.company!.locations.nodes[0]?.id ?? "";
            contactId = d.companyCreate.company!.mainContact?.id ?? "";
            created = true;
            break;
          }
        }
        state = await companyState(shop, companyId);
        if (!state) throw new B2bError("userErrors", "company not found after create");
      }
      if (!locationId) locationId = state!.locations.nodes[0]?.id ?? "";
      while (!locationId) {
        const d = await call<{ companyLocationCreate: { companyLocation: { id: string } | null; userErrors: UserError[] } }>(shop, LOCATION_CREATE_M,
          { id: companyId, input: companyCreateInput(b2b, false, parts).companyLocation });
        const errs = d.companyLocationCreate.userErrors ?? [];
        if (errs.length) {
          const bad = rejectedParts(errs);
          const dropAddress = parts.address && bad.address, dropTax = parts.tax && bad.tax;
          if (!dropAddress && !dropTax) check(errs, "companyLocationCreate");
          if (dropAddress) { parts.address = false; notes.push(partNote("noAddress", errs)); }
          if (dropTax) { parts.tax = false; notes.push(partNote("noTax", errs)); }
          continue;
        }
        locationId = d.companyLocationCreate.companyLocation!.id;
        state = await companyState(shop, companyId);
      }
      // Kontakt = Shop-Kunde mit der aktuellen E-Mail
      const contacts = state!.contacts.nodes;
      let mine = contacts.find((x) => normEmail(x.customer?.email ?? "") === email);
      if (!mine) {
        if (sc) {
          const d = await call<{ companyAssignCustomerAsContact: { companyContact: { id: string } | null; userErrors: UserError[] } }>(shop, ASSIGN_CUSTOMER_M, { companyId, customerId: sc.id });
          check(d.companyAssignCustomerAsContact.userErrors, "companyAssignCustomerAsContact");
          contactId = d.companyAssignCustomerAsContact.companyContact!.id;
        } else {
          const d = await call<{ companyContactCreate: { companyContact: { id: string } | null; userErrors: UserError[] } }>(shop, CONTACT_CREATE_M,
            { companyId, input: { email, ...contactName(b2b) } });
          check(d.companyContactCreate.userErrors, "companyContactCreate");
          contactId = d.companyContactCreate.companyContact!.id;
        }
        mine = { id: contactId, customer: null, roleAssignments: { nodes: [] } };
      } else contactId = mine.id;
      // frühere E-Mail (geändert) → deren Kontakt kommt erst ganz am Ende raus, damit das Unternehmen nie ohne Hauptkontakt ist
      const oldId = row.contactId && row.contactId !== contactId && contacts.some((x) => x.id === row.contactId) ? row.contactId : "";
      if (!state!.mainContact || (oldId && state!.mainContact.id === oldId)) {
        const d = await call<{ companyAssignMainContact: { userErrors: UserError[] } }>(shop, MAIN_CONTACT_M, { companyId, contactId });
        check(d.companyAssignMainContact.userErrors, "companyAssignMainContact");
      }
      // darf für den Standort bestellen (sonst sieht er die Preise nicht)
      if (!mine.roleAssignments.nodes.some((r) => r.companyLocation?.id === locationId)) {
        const roles = state!.contactRoles.nodes;
        const roleId = roles.find((r) => /order|bestell/i.test(r.name))?.id ?? state!.defaultRole?.id ?? roles[0]?.id;
        if (!roleId) throw new B2bError("userErrors", "no company contact role");
        const d = await call<{ companyContactAssignRole: { userErrors: UserError[] } }>(shop, ASSIGN_ROLE_M, { contactId, roleId, locationId });
        check(d.companyContactAssignRole.userErrors, "companyContactAssignRole");
      }
      // Name, Anschrift, USt-IdNr., Reverse Charge geändert → im Shop nachziehen (beim Neuanlegen schon richtig; ein vorhandenes
      // Unternehmen, das wir übernommen haben, bekommt die Daten aus dem System). Lehnt Shopify Anschrift bzw. USt-IdNr. ab →
      // bleibt verbunden, mit Hinweis (Fingerabdruck ohne den Teil → beim nächsten Speichern neuer Versuch)
      const fp = companyFingerprint(b2b);
      if (!created && row.fingerprint !== fp) {
        const u = await call<{ companyUpdate: { userErrors: UserError[] } }>(shop, COMPANY_UPDATE_M, { id: companyId, input: { name: b2b.name.trim().slice(0, 255) } });
        check(u.companyUpdate.userErrors, "companyUpdate");
        // Standort ebenso („Name – Ort“, sieht der Kunde im Checkout) – vorher blieb dort der Name von der Anlage stehen
        const ln = await call<{ companyLocationUpdate: { userErrors: UserError[] } }>(shop, LOCATION_UPDATE_M, { id: locationId, input: { name: locationName(b2b) } });
        check(ln.companyLocationUpdate.userErrors, "companyLocationUpdate");
        const address = companyAddress(b2b);
        if (address) {
          const a = await call<{ companyLocationAssignAddress: { userErrors: UserError[] } }>(shop, ADDRESS_M, { id: locationId, address });
          const errs = a.companyLocationAssignAddress.userErrors ?? [];
          if (errs.length && rejectedParts(errs).address) { parts.address = false; notes.push(partNote("noAddress", errs)); }
          else check(errs, "companyLocationAssignAddress");
        }
        const t = await call<{ companyLocationTaxSettingsUpdate: { userErrors: UserError[] } }>(shop, TAX_M, { id: locationId, ...taxSettingsUpdate(b2b) });
        const terrs = t.companyLocationTaxSettingsUpdate.userErrors ?? [];
        if (terrs.length && rejectedParts(terrs).tax) { parts.tax = false; notes.push(partNote("noTax", terrs)); }
        else check(terrs, "companyLocationTaxSettingsUpdate");
      }
      if (oldId) await removeContact(shop, oldId);
      const first = row.status !== "linked" || row.email !== email;
      const skipped = !parts.address || !parts.tax;
      await set({
        status: "linked", error: notes.join("|"), email, companyId, locationId, contactId, shopCustomerId: sc?.id ?? row.shopCustomerId,
        fingerprint: skipped ? companyFingerprint(shownInShop(b2b, parts)) : fp, tries: 0, syncedAt: new Date(),
      });
      if (first) await logEvent(channel, "info", "customers", `resellerLinked:${cust.name}`, email);
      if (skipped) await logEvent(channel, "warn", "customers", `resellerPartial:${cust.name}|${notes.join(" / ")}`, email);
      return reload();
    } catch (e) {
      const tries = row.tries + 1;
      if (e instanceof ShopifyError && ["network", "throttled", "auth", "notConfigured"].includes(e.code)) await set({ error: e.code, tries });
      else if (e instanceof ShopifyError && e.code === "graphql" && SCOPE_RE.test(e.message)) {
        await set({ error: "needScope", tries }); // bleibt vorgemerkt, geht raus, sobald das Recht freigegeben ist
      } else if (e instanceof ShopifyError && e.code === "graphql" && NO_B2B_RE.test(e.message)) {
        await set({ status: "failed", error: `noB2b:${e.message.slice(0, 200)}`, tries });
      } else {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        await set({ status: "failed", error: msg, tries });
        await logEvent(channel, "error", "customers", `resellerFailed:${c?.name ?? ""}|${msg}`, row.email);
      }
      return reload();
    }
  });
}

async function removeContact(shop: Shop, contactId: string) {
  const d = await call<{ companyContactRemoveFromCompany: { userErrors: UserError[] } }>(shop, CONTACT_REMOVE_M, { id: contactId });
  // schon weg → Ziel erreicht
  const errs = (d.companyContactRemoveFromCompany.userErrors ?? []).filter((e) => !/not found|does not exist|existiert nicht/i.test(e.message));
  if (!errs.length) return;
  // Shopify lässt ihn nicht aus dem Unternehmen (z. B. einziger Hauptkontakt) → alle Rollen entziehen: kauft nicht mehr für das Unternehmen
  const r = await call<{ companyContactRevokeRoles: { userErrors: UserError[] } }>(shop, REVOKE_M, { id: contactId });
  check(r.companyContactRevokeRoles.userErrors, `companyContactRemoveFromCompany: ${errs[0].message} / companyContactRevokeRoles`);
}

/** Großhandelspreise in beiden Shops (Wunsch Inhaber 13.11.2026: „كل شي بمتجر البراند زي المتجر العام“) – ein Häkchen am Kunden gilt für beide */
export const RESELLER_CHANNELS: readonly ShopChannel[] = ["GENERAL_SHOP", "BRAND_SHOP"]; // Reihenfolge = Anzeige (allgemeiner Shop zuerst)

/**
 * Gleich abgleichen (alle Shops parallel, nur wo es eine Zeile gibt) und höchstens timeoutMs warten (Kundenformular);
 * länger → läuft im Hintergrund weiter, der Worker versucht vorgemerkte alle 5 min wieder.
 */
export async function syncShopCompanyNow(customerId: string, timeoutMs = 8000, channels: readonly ShopChannel[] = RESELLER_CHANNELS): Promise<ShopCompany[]> {
  const work = Promise.all(channels.map((ch) => syncShopCompany(customerId, ch).catch((e) => { console.error("shopify b2b", ch, e); return null; })))
    .then((rows) => rows.filter((r): r is ShopCompany => r != null));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ShopCompany[]>((resolve) => { timer = setTimeout(() => resolve([]), timeoutMs); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

/**
 * Verbundene Unternehmen, deren Daten sich im System geändert haben, ohne dass der Kunde gespeichert wurde – z. B. USt-IdNr. inzwischen
 * als gültig geprüft (→ Reverse Charge im Shop, Wunsch Inhaber 20.11.2026) – zum Nachziehen vormerken. Nicht bei abgelehnter
 * Anschrift/USt-IdNr. („noAddress:“/„noTax:“): das versucht erst das nächste Speichern (sonst alle 5 min dieselbe Ablehnung).
 */
async function markStaleShopCompanies(customerId?: string): Promise<ShopChannel[]> {
  const rows = await db.select({ id: schema.shopCompanies.id, channel: schema.shopCompanies.channel, fingerprint: schema.shopCompanies.fingerprint, error: schema.shopCompanies.error, c: schema.customers })
    .from(schema.shopCompanies).innerJoin(schema.customers, eq(schema.customers.id, schema.shopCompanies.customerId))
    .where(and(eq(schema.shopCompanies.status, "linked"), eq(schema.shopCompanies.wanted, true), customerId ? eq(schema.shopCompanies.customerId, customerId) : undefined));
  const stale = rows.filter((r) => !/^no(Address|Tax):/.test(r.error) && r.fingerprint !== companyFingerprint(toB2b(r.c)));
  for (const r of stale) await db.update(schema.shopCompanies).set({ status: "pending", tries: 0, updatedAt: new Date() }).where(and(eq(schema.shopCompanies.id, r.id), eq(schema.shopCompanies.status, "linked")));
  return stale.map((r) => r.channel as ShopChannel);
}

/** Nach der USt-Prüfung am Kunden: Reverse Charge im Shop gleich an bzw. aus (höchstens timeoutMs warten, sonst Worker) */
export async function refreshShopCompanies(customerId: string, timeoutMs = 8000): Promise<ShopCompany[]> {
  const channels = await markStaleShopCompanies(customerId);
  return channels.length ? syncShopCompanyNow(customerId, timeoutMs, channels) : [];
}

/** Worker (alle 5 min): vorgemerkte Verbindungen (Shop war weg, Recht fehlte) + geänderte Daten ohne Speichern */
export async function retryShopCompanies() {
  await markStaleShopCompanies().catch((e) => console.error("shopify b2b stale", e));
  const rows = await db.select({ customerId: schema.shopCompanies.customerId, channel: schema.shopCompanies.channel }).from(schema.shopCompanies)
    .where(and(eq(schema.shopCompanies.status, "pending"), lt(schema.shopCompanies.tries, 2000))).orderBy(asc(schema.shopCompanies.updatedAt)).limit(30);
  for (const r of rows) await syncShopCompany(r.customerId, r.channel as ShopChannel).catch((e) => console.error("shopify b2b retry", e));
  return rows.length;
}

let lastFullPush = 0;
/** Worker: höchstens alle 30 min alle Wiederverkäuferpreise vergleichen (füllt die Preisliste auch ohne Knopfdruck) */
export async function pushResellerPricesPeriodically() {
  if (Date.now() - lastFullPush < 30 * 60_000) return;
  lastFullPush = Date.now();
  await pushResellerPrices();
}

/** Stand für die Oberfläche (Kunde) */
export async function shopCompanyOf(customerId: string, channel: ShopChannel = "GENERAL_SHOP") {
  return (await db.query.shopCompanies.findFirst({ where: and(eq(schema.shopCompanies.customerId, customerId), eq(schema.shopCompanies.channel, channel)) })) ?? null;
}

/** Stand je Shop (Kundenseite), in der Reihenfolge von RESELLER_CHANNELS; ohne Zeile = null */
export async function shopCompaniesOf(customerId: string): Promise<{ channel: ShopChannel; link: ShopCompany | null }[]> {
  const rows = await db.query.shopCompanies.findMany({ where: eq(schema.shopCompanies.customerId, customerId) });
  return RESELLER_CHANNELS.map((channel) => ({ channel, link: rows.find((r) => r.channel === channel) ?? null }));
}

/** Zahlen für die Shop-Seite */
export async function resellerSummary(channel: ShopChannel) {
  const rows = (await db.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from shop_companies where channel = ${channel} and wanted group by status`)).rows;
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
  return { linked: by.linked ?? 0, pending: by.pending ?? 0, failed: by.failed ?? 0 };
}
