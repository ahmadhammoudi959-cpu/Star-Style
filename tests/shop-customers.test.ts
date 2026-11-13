/**
 * Kunden aus den Shops ins System (Wunsch Inhaber 13.11.2026): Konto (state ENABLED) oder Bestellung (auch unbezahlt,
 * Nachnahme, Gast) → Kunde im System, per E-Mail verbunden, nie doppelt; was im System steht, gewinnt.
 * Rein (customer-map) + Datenbank mit simuliertem Shopify.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { belongsInSystem, customerFromShop, fillMissing, orderCount, placeholderName, type ShopCustomerNode } from "../src/lib/shopify/customer-map";

const node = (o: Partial<ShopCustomerNode> & { email?: string | null }): ShopCustomerNode => ({
  id: o.id ?? "gid://shopify/Customer/1", firstName: o.firstName ?? null, lastName: o.lastName ?? null, displayName: o.displayName ?? null,
  state: o.state ?? "ENABLED", numberOfOrders: o.numberOfOrders ?? "0", createdAt: o.createdAt ?? "2026-11-13T09:00:00Z", updatedAt: o.updatedAt ?? "2026-11-13T09:00:00Z",
  defaultEmailAddress: o.email === null ? null : { emailAddress: o.email ?? "Kaya@Example.com" }, defaultPhoneNumber: o.defaultPhoneNumber ?? null,
  defaultAddress: o.defaultAddress ?? null,
});
const addr = { company: null, address1: "Ringstr. 1", address2: "", zip: "45711", city: "Datteln", countryCodeV2: "DE", phone: "+49 2363 123" };

describe("Shop-Kunden (rein)", () => {
  it("Konto oder Bestellung gehört ins System; nur Newsletter/nie angemeldet nicht", () => {
    expect(belongsInSystem({ state: "ENABLED", numberOfOrders: "0" })).toBe(true);
    expect(belongsInSystem({ state: "DISABLED", numberOfOrders: "1" })).toBe(true); // Gast, z. B. Nachnahme
    expect(belongsInSystem({ state: "DISABLED", numberOfOrders: "0" })).toBe(false);
    expect(belongsInSystem({ state: "INVITED", numberOfOrders: null })).toBe(false);
    expect(orderCount({ numberOfOrders: "12" })).toBe(12);
    expect(orderCount({ numberOfOrders: "x" })).toBe(0);
  });

  it("Name: Firma > Person > E-Mail (Platzhalter); E-Mail klein; Anschrift + Telefon; Land sonst DE", () => {
    expect(customerFromShop(node({ firstName: "Ali", lastName: "Kaya", defaultAddress: addr }))).toEqual({
      type: "PERSON", name: "Ali Kaya", contact: "", email: "kaya@example.com", phone: "+49 2363 123", street: "Ringstr. 1", zip: "45711", city: "Datteln", country: "DE",
    });
    expect(customerFromShop(node({ firstName: "Ali", lastName: "Kaya", defaultAddress: { ...addr, company: "Salon Kaya", countryCodeV2: "nl" } }))).toMatchObject({
      type: "COMPANY", name: "Salon Kaya", contact: "Ali Kaya", country: "NL",
    });
    const bare = customerFromShop(node({ displayName: "kaya@example.com", defaultPhoneNumber: { phoneNumber: "+49 178 1" } }))!;
    expect(bare).toMatchObject({ name: "kaya@example.com", phone: "+49 178 1", street: "", country: "DE" });
    expect(placeholderName(bare)).toBe(true);
    expect(customerFromShop(node({ email: null }))).toBeNull();
    expect(customerFromShop(node({ email: "kein-at-zeichen" }))).toBeNull();
  });

  it("Ergänzen: nur Leeres bzw. Platzhalter-Name; Anschrift nur als Ganzes; was im System steht, bleibt", () => {
    const shop = customerFromShop(node({ firstName: "Ali", lastName: "Kaya", defaultAddress: addr }))!;
    const placeholder = { ...customerFromShop(node({}))!, phone: "" };
    expect(fillMissing(placeholder, shop)).toEqual({ name: "Ali Kaya", type: "PERSON", phone: "+49 2363 123", street: "Ringstr. 1", zip: "45711", city: "Datteln", country: "DE" });
    const owner = { type: "COMPANY" as const, name: "Friseur Kaya GmbH", contact: "", email: "kaya@example.com", phone: "0201 5", street: "", zip: "", city: "Essen", country: "DE" };
    expect(fillMissing(owner, shop)).toEqual({ contact: "Ali Kaya" }); // Name, Telefon, Ort (Teil der Anschrift) bleiben
    expect(fillMissing(shop, shop)).toEqual({});
  });
});

// ───────────── Datenbank + simuliertes Shopify ─────────────
const run = process.env.DATABASE_URL && process.env.SESSION_SECRET ? describe : describe.skip;
run("Shop-Kunden (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { encrypt } = await import("../src/lib/crypto");
  const sc = await import("../src/lib/shopify/customers");
  const { handleWebhook } = await import("../src/lib/shopify/webhooks");
  const stamp = Date.now();
  const mail = (n: string) => `${n}.${stamp}@example.com`;
  // je Shop eigene Shopify-Kunden
  const S: Record<string, ShopCustomerNode[]> = { "star-general.myshopify.com": [], "star-brand.myshopify.com": [] };
  const calls: string[] = [];
  function mock() {
    return vi.fn(async (url: string, init: { body: string }) => {
      const host = new URL(String(url)).host;
      const { query: q, variables: v } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
      calls.push(`${host} ${q.includes("customers(") ? "list" : q.includes("customer(") ? "one" : "?"}`);
      const list = S[host] ?? [];
      if (q.includes("customers(")) {
        const since = typeof v.q === "string" ? Date.parse(String(v.q).match(/'(.+)'/)?.[1] ?? "") : NaN;
        const nodes = list.filter((n) => Number.isNaN(since) || Date.parse(n.updatedAt) >= since).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
        return Response.json({ data: { customers: { nodes, pageInfo: { hasNextPage: false, endCursor: "" } } } });
      }
      if (q.includes("customer(")) return Response.json({ data: { customer: list.find((n) => n.id === v.id) ?? null } });
      return Response.json({ errors: [{ message: `unexpected ${q.slice(0, 60)}` }] });
    });
  }
  const shopsBefore: (typeof schema.shops.$inferSelect)[] = [];
  const customerByEmail = async (email: string) => (await db.select().from(schema.customers).where(sql`lower(email) = ${email}`));
  const links = async (customerId: string) => db.select().from(schema.shopCustomers).where(eq(schema.shopCustomers.customerId, customerId));

  beforeAll(async () => {
    shopsBefore.push(...await db.select().from(schema.shops));
    for (const [channel, domain] of [["GENERAL_SHOP", "star-general.myshopify.com"], ["BRAND_SHOP", "star-brand.myshopify.com"]] as const) {
      const set = { domain, staticTokenEnc: encrypt("shpat_test"), clientSecretEnc: encrypt("hook-secret"), customersSince: null, active: false };
      await db.insert(schema.shops).values({ channel, ...set }).onConflictDoUpdate({ target: schema.shops.channel, set });
    }
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => {
    for (const s of shopsBefore) await db.update(schema.shops).set({ domain: s.domain, staticTokenEnc: s.staticTokenEnc, clientSecretEnc: s.clientSecretEnc, customersSince: s.customersSince, active: s.active })
      .where(eq(schema.shops.channel, s.channel));
  });

  it("Konto → neuer Kunde (جملة/RETAIL) mit Verbindung, Protokoll; Gast mit Nachnahme-Bestellung auch; nur Newsletter nicht", async () => {
    vi.stubGlobal("fetch", mock());
    S["star-general.myshopify.com"].push(
      node({ id: `gid://shopify/Customer/${stamp}1`, email: mail("Dana").toUpperCase(), updatedAt: "2026-11-13T09:00:01Z" }),
      node({ id: `gid://shopify/Customer/${stamp}2`, email: mail("cod"), firstName: "Omar", lastName: "Haddad", state: "DISABLED", numberOfOrders: "1", defaultAddress: addr, updatedAt: "2026-11-13T09:00:02Z" }),
      node({ id: `gid://shopify/Customer/${stamp}3`, email: mail("news"), state: "DISABLED", numberOfOrders: "0", updatedAt: "2026-11-13T09:00:03Z" }),
    );
    const r = await sc.syncShopCustomers("GENERAL_SHOP");
    expect(r).toMatchObject({ created: 2, linked: 0 });
    const [dana] = await customerByEmail(mail("dana"));
    expect(dana).toMatchObject({ name: mail("dana"), priceGroup: "RETAIL", type: "PERSON" }); // Name kommt später
    expect(await links(dana.id)).toEqual([expect.objectContaining({ channel: "GENERAL_SHOP", state: "ENABLED", createdCustomer: true, email: mail("dana") })]);
    const [omar] = await customerByEmail(mail("cod"));
    expect(omar).toMatchObject({ name: "Omar Haddad", street: "Ringstr. 1", zip: "45711", city: "Datteln", phone: "+49 2363 123", priceGroup: "RETAIL" });
    expect(await customerByEmail(mail("news"))).toEqual([]);
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, dana.id));
    expect(audit.map((a) => a.action)).toContain("create");
    const ev = await db.select().from(schema.shopEvents).where(eq(schema.shopEvents.ref, mail("dana")));
    expect(ev.some((e) => e.message.startsWith("customerRegistered:"))).toBe(true);
    // Stand gemerkt → beim nächsten Mal nur Neueres
    const shop = (await db.query.shops.findFirst({ where: eq(schema.shops.channel, "GENERAL_SHOP") }))!;
    expect(shop.customersSince?.toISOString()).toBe("2026-11-13T09:00:03.000Z");
    expect(await sc.syncShopCustomers("GENERAL_SHOP")).toMatchObject({ created: 0, linked: 0 });
  }, 30_000);

  it("Gleiche E-Mail schon im System → verbinden, nichts überschreiben, nur Leeres ergänzen; zweiter Shop → derselbe Kunde", async () => {
    vi.stubGlobal("fetch", mock());
    const [own] = await db.insert(schema.customers).values({ name: "Salon Kaya GmbH", email: mail("kaya"), priceGroup: "WHOLESALE", city: "Essen" }).returning();
    S["star-general.myshopify.com"].push(node({ id: `gid://shopify/Customer/${stamp}4`, email: mail("kaya"), firstName: "Ali", lastName: "Kaya", defaultAddress: addr, defaultPhoneNumber: { phoneNumber: "+49 178 9" }, updatedAt: "2026-11-13T10:00:00Z" }));
    S["star-brand.myshopify.com"].push(node({ id: `gid://shopify/Customer/${stamp}5`, email: ` ${mail("kaya")} `, updatedAt: "2026-11-13T10:00:01Z" }));
    expect(await sc.syncShopCustomers("GENERAL_SHOP")).toMatchObject({ created: 0, linked: 1 });
    expect(await sc.syncShopCustomers("BRAND_SHOP")).toMatchObject({ created: 0, linked: 1 });
    const all = await customerByEmail(mail("kaya"));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "Salon Kaya GmbH", priceGroup: "WHOLESALE", city: "Essen", street: "", phone: "+49 178 9", contact: "Ali Kaya" });
    expect((await links(own.id)).map((l) => [l.channel, l.createdCustomer]).sort()).toEqual([["BRAND_SHOP", false], ["GENERAL_SHOP", false]]);
  }, 30_000);

  it("Nur mit E-Mail angemeldet, Name später im Profil → Platzhalter-Name wird ersetzt (Webhook-Weg, auch bei ausgeschaltetem Abgleich)", async () => {
    vi.stubGlobal("fetch", mock());
    const id = `gid://shopify/Customer/${stamp}6`;
    const list = S["star-brand.myshopify.com"];
    list.push(node({ id, email: mail("lina"), updatedAt: "2026-11-13T11:00:00Z" }));
    expect(await sc.syncShopCustomerById("BRAND_SHOP", id)).toBe("created");
    list[list.length - 1] = node({ id, email: mail("lina"), firstName: "Lina", lastName: "Saleh", updatedAt: "2026-11-13T11:05:00Z" });
    // Webhook customers/update (HMAC mit dem App-Geheimnis), Abgleich aus
    const raw = JSON.stringify({ id: Number(`${stamp}6`), admin_graphql_api_id: id });
    const hmac = createHmac("sha256", "hook-secret").update(raw, "utf8").digest("base64");
    const headers = new Headers({ "x-shopify-shop-domain": "star-brand.myshopify.com", "x-shopify-topic": "customers/update", "x-shopify-hmac-sha256": hmac });
    expect(await handleWebhook(raw, headers)).toBe(200);
    expect(await handleWebhook(raw, new Headers({ ...Object.fromEntries(headers), "x-shopify-hmac-sha256": "falsch" }))).toBe(401);
    for (let i = 0; i < 50 && (await customerByEmail(mail("lina")))[0]?.name !== "Lina Saleh"; i++) await new Promise((r) => setTimeout(r, 100));
    const [lina] = await customerByEmail(mail("lina"));
    expect(lina).toMatchObject({ name: "Lina Saleh", type: "PERSON" });
    expect(await sc.newShopCustomersCount(36500)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("Beide Shops gleichzeitig mit derselben E-Mail → genau EIN Kunde (Sperre je E-Mail)", async () => {
    vi.stubGlobal("fetch", mock());
    const a = node({ id: `gid://shopify/Customer/${stamp}7`, email: mail("twin"), updatedAt: "2026-11-13T12:00:00Z" });
    const b = node({ id: `gid://shopify/Customer/${stamp}8`, email: mail("twin"), updatedAt: "2026-11-13T12:00:00Z" });
    const r = await Promise.all([sc.upsertShopCustomer("GENERAL_SHOP", a), sc.upsertShopCustomer("BRAND_SHOP", b)]);
    expect(r.sort()).toEqual(["created", "linked"]);
    const all = await customerByEmail(mail("twin"));
    expect(all).toHaveLength(1);
    expect(await links(all[0].id)).toHaveLength(2);
  }, 30_000);
});
