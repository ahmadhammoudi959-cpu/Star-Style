import "server-only";
/**
 * Kunden aus den Shops ins System (Wunsch Inhaber 13.11.2026: „أي زبون يعمل اكونت على أي من المتجرين يطلع بالسيستم“ und
 * „اي زبون … يتوجه لصفحة الدفع بس مدفعش وطلب مثلا كاش اون دليفري يظهر برضو“):
 * - wer im Shop ein Konto hat (state ENABLED) oder bestellt hat (auch unbezahlt/Nachnahme, auch als Gast) → Kunde im System
 * - Schlüssel ist die E-Mail (wie Bestellungen und B2B, nie der Name): gibt es sie schon → verbinden, nie doppelt anlegen;
 *   was im System steht, gewinnt – vom Shop wird nur Leeres ergänzt (Name, Telefon, Anschrift)
 * - neue Kunden bekommen die Preisgruppe „جملة“ (RETAIL = normaler Shop-Preis); „جملة الجملة“ setzt der Inhaber
 * - läuft unabhängig vom Bestands-Abgleich (auch im Testbetrieb): Worker alle 5 min + Webhooks customers/create|update|enable
 * Rein + getestet: ./customer-map.ts; Recht der App: read_customers.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, getShop, refreshTokenOnce, ShopifyError, type Shop, type ShopChannel } from "./client";
import { configured } from "./admin";
import { CHANNELS, logEvent } from "./sync";
import { belongsInSystem, customerFromShop, fillMissing, orderCount, type CustomerFields, type ShopCustomerNode } from "./customer-map";
import { todayIso } from "../dates";
import { withCustomerLock } from "./customer-lock";

const FIELDS = `id firstName lastName displayName state numberOfOrders createdAt updatedAt
  defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }
  defaultAddress { company address1 address2 zip city countryCodeV2 phone }`;
const LIST_Q = `query($q: String, $after: String) { customers(first: 100, after: $after, sortKey: UPDATED_AT, query: $q) {
  nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } } }`;
const ONE_Q = `query($id: ID!) { customer(id: $id) { ${FIELDS} } }`;

const SCOPE_RE = /access denied|not approved|required access|access scope|read_customers/i;
const isScope = (e: unknown) => e instanceof ShopifyError && (e.code === "graphql" || e.code === "auth") && SCOPE_RE.test(e.message);
const isTransient = (e: unknown) => e instanceof ShopifyError && (e.code === "network" || e.code === "throttled");

/** fehlendes Recht → einmal mit neuem Token (der zwischengespeicherte kann von vor der Freigabe stammen) */
async function call<T>(shop: Shop, query: string, variables: Record<string, unknown>): Promise<T> {
  try { return await gql<T>(shop, query, variables); }
  catch (e) {
    if (isScope(e) && (await refreshTokenOnce(shop))) return gql<T>(shop, query, variables);
    throw e;
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const fieldsOf = (c: typeof schema.customers.$inferSelect): CustomerFields => ({
  type: c.type, name: c.name, contact: c.contact, email: c.email, phone: c.phone, street: c.street, zip: c.zip, city: c.city, country: c.country,
});

/** Leeres am vorhandenen Kunden aus dem Shop ergänzen (Protokoll vorher/nachher); true = geändert */
async function fill(tx: Tx, customerId: string, incoming: CustomerFields, channel: ShopChannel) {
  const c = await tx.query.customers.findFirst({ where: eq(schema.customers.id, customerId) });
  if (!c) return false;
  const current = fieldsOf(c);
  const patch = fillMissing(current, incoming);
  const keys = Object.keys(patch) as (keyof CustomerFields)[];
  if (!keys.length) return false;
  await tx.update(schema.customers).set(patch).where(eq(schema.customers.id, customerId));
  await tx.insert(schema.auditLog).values({
    entity: "customer", entityId: customerId, action: "update",
    before: Object.fromEntries(keys.map((k) => [k, current[k]])), after: { ...patch, source: channel },
  });
  return true;
}

export type UpsertResult = "created" | "linked" | "updated" | "unchanged" | "ignored";

/**
 * Einen Shop-Kunden übernehmen (idempotent): schon verbunden → Stand merken + Leeres ergänzen; neu und gehört ins System →
 * mit Kunden gleicher E-Mail verbinden oder neuen Kunden anlegen (Preisgruppe „جملة“).
 */
export async function upsertShopCustomer(channel: ShopChannel, n: ShopCustomerNode): Promise<UpsertResult> {
  const fields = customerFromShop(n);
  return withCustomerLock(fields?.email || n.id, async () => {
    const res = await db.transaction(async (tx): Promise<{ r: UpsertResult; name?: string }> => {
      const link = await tx.query.shopCustomers.findFirst({ where: and(eq(schema.shopCustomers.channel, channel), eq(schema.shopCustomers.shopCustomerId, n.id)) });
      const meta = { state: n.state, orders: orderCount(n), registeredAt: new Date(n.createdAt), syncedAt: new Date() };
      if (link) {
        await tx.update(schema.shopCustomers).set({ ...meta, email: fields?.email || link.email, updatedAt: new Date() }).where(eq(schema.shopCustomers.id, link.id));
        if (!fields || !belongsInSystem(n)) return { r: "unchanged" };
        return { r: (await fill(tx, link.customerId, fields, channel)) ? "updated" : "unchanged" };
      }
      if (!fields || !belongsInSystem(n)) return { r: "ignored" };
      // gleiche E-Mail schon im System (von Hand, aus einer Bestellung, aus dem anderen Shop) → verbinden statt doppelt anlegen
      const ex = (await tx.execute<{ id: string; name: string }>(sql`
        select id, name from customers where lower(trim(email)) = ${fields.email} order by active desc, number asc limit 1`)).rows[0];
      let customerId: string, name: string, created = false;
      if (ex) {
        customerId = ex.id; name = ex.name;
        await fill(tx, customerId, fields, channel);
      } else {
        const values = { ...fields, priceGroup: "RETAIL" as const, fromShop: channel };
        const [row] = await tx.insert(schema.customers).values(values).returning({ id: schema.customers.id });
        customerId = row.id; name = fields.name; created = true;
        await tx.insert(schema.auditLog).values({ entity: "customer", entityId: row.id, action: "create", after: { ...values, source: channel, shopCustomerId: n.id } });
      }
      await tx.insert(schema.shopCustomers).values({ customerId, channel, shopCustomerId: n.id, email: fields.email, ...meta, createdCustomer: created });
      return { r: created ? "created" : "linked", name };
    });
    if (res.r === "created" || res.r === "linked")
      await logEvent(channel, "info", "customers", `${res.r === "created" ? "customerRegistered" : "customerLinked"}:${res.name ?? ""}`, fields?.email ?? "");
    return res.r;
  });
}

/** höchstens einmal am Tag ins Protokoll (z. B. fehlendes Recht) */
async function logDaily(channel: ShopChannel, message: string) {
  const r = await db.insert(schema.shopProcessed).values({ key: `daily:${message}:${channel}:${todayIso()}` }).onConflictDoNothing().returning({ key: schema.shopProcessed.key });
  if (r.length) await logEvent(channel, "warn", "customers", message);
}

export type CustomersSync = { seen: number; created: number; linked: number; updated: number; failed: number; problem?: "needScope" | "unreachable" | "error" };

/**
 * Alle seit dem letzten Mal geänderten Shop-Kunden übernehmen (erstes Mal: alle). Shopify liefert aufsteigend nach updatedAt,
 * 1 min Überlappung (doppelt schadet nicht). Shop nicht erreichbar → alter Stand, nächstes Mal noch einmal. Ein einzelner Kunde,
 * der nicht übernommen werden kann, hält die anderen nicht auf: Protokoll 1×/Tag, Stand bleibt vor ihm → er wird jedes Mal
 * wieder versucht (alle danach sind trotzdem schon da).
 */
export async function syncShopCustomers(channel: ShopChannel): Promise<CustomersSync | null> {
  const shop = await getShop(channel);
  if (!configured(shop)) return null;
  const since = shop.customersSince;
  const q = since ? `updated_at:>='${new Date(since.getTime() - 60_000).toISOString()}'` : null;
  const out: CustomersSync = { seen: 0, created: 0, linked: 0, updated: 0, failed: 0 };
  let after: string | null = null, max = since?.getTime() ?? 0;
  try {
    do {
      const d: { customers: { nodes: ShopCustomerNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await call(shop, LIST_Q, { q, after });
      for (const n of d.customers.nodes) {
        out.seen++;
        try {
          const r = await upsertShopCustomer(channel, n);
          if (r === "created") out.created++; else if (r === "linked") out.linked++; else if (r === "updated") out.updated++;
          if (!out.failed) max = Math.max(max, Date.parse(n.updatedAt) || 0);
        } catch (e) {
          out.failed++;
          console.error("shopify customer", channel, n.id, e);
          const who = n.defaultEmailAddress?.emailAddress || n.id;
          await logDaily(channel, `customersFailed:${who} – ${String((e as Error)?.message ?? e).slice(0, 160)}`);
        }
      }
      after = d.customers.pageInfo.hasNextPage ? d.customers.pageInfo.endCursor : null;
    } while (after);
  } catch (e) {
    if (isScope(e)) { await logDaily(channel, "needScopeCustomers"); return { ...out, problem: "needScope" }; }
    if (isTransient(e)) return { ...out, problem: "unreachable" };
    console.error("shopify customers", channel, e);
    await logDaily(channel, `customersFailed:${String((e as Error)?.message ?? e).slice(0, 200)}`);
    return { ...out, problem: "error" };
  }
  if (max && max !== since?.getTime()) await db.update(schema.shops).set({ customersSince: new Date(max) }).where(eq(schema.shops.channel, channel));
  return out;
}

/** beide Shops (Worker alle 5 min) */
export async function syncAllShopCustomers() {
  const out: Partial<Record<ShopChannel, CustomersSync | null>> = {};
  for (const ch of CHANNELS) out[ch] = await syncShopCustomers(ch).catch((e) => { console.error("shopify customers", ch, e); return null; });
  return out;
}

/** einen Shop-Kunden sofort übernehmen (Webhook customers/create|update|enable) */
export async function syncShopCustomerById(channel: ShopChannel, id: string): Promise<UpsertResult | null> {
  const shop = await getShop(channel);
  if (!configured(shop) || !/^gid:\/\/shopify\/Customer\/\d+$/.test(id)) return null;
  const d = await call<{ customer: ShopCustomerNode | null }>(shop, ONE_Q, { id });
  return d.customer ? upsertShopCustomer(channel, d.customer) : null;
}

/** Stand je Kunde für die Oberfläche */
export async function shopAccountsOf(customerId: string) {
  return db.query.shopCustomers.findMany({ where: eq(schema.shopCustomers.customerId, customerId) });
}

/**
 * Seit wann ein Kunde aus dem Shop „neu“ ist (gleiche Regel für Kundenliste und Startseite): Anmeldung im Shop (bzw. Anlage hier)
 * des Kontos, mit dem er angelegt wurde – sonst (aus einer Bestellung angelegt) die Anlage hier. Im System angelegte: nie neu.
 */
export const shopNewAtSql = sql`case when c.from_shop is not null then coalesce(
  (select min(coalesce(sc.registered_at, sc.created_at)) from shop_customers sc where sc.customer_id = c.id and sc.created_customer), c.created_at) end`;

/** Startseite: so viele Kunden kamen in den letzten 7 Tagen neu aus den Shops */
export async function newShopCustomersCount(days = 7) {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from customers c where c.active and ${shopNewAtSql} > now() - make_interval(days => ${days})`);
  return Number(r.rows[0]?.n ?? 0);
}
