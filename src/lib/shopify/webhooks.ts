import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt } from "../crypto";
import { gql, normalizeDomain, type ShopChannel } from "./client";
import { fetchOrder, logEvent, processOrder } from "./sync";
import { syncShopCustomerById } from "./customers";
import { todayIso } from "../dates";

/** Kundenkonten sofort ins System (Wunsch Inhaber 13.11.2026); ohne Webhook holt der Worker sie alle 5 min (./customers.ts) */
export const CUSTOMER_TOPICS = ["CUSTOMERS_CREATE", "CUSTOMERS_UPDATE", "CUSTOMERS_ENABLE"] as const;
export const TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE", ...CUSTOMER_TOPICS] as const;

/** Echtheit prüfen: HMAC-SHA256 über den Rohtext mit dem App-Geheimnis (Base64) */
export function verifyHmac(raw: string, secret: string, header: string | null) {
  if (!header || !secret) return false;
  const digest = createHmac("sha256", secret).update(raw, "utf8").digest();
  const given = Buffer.from(header, "base64");
  return given.length === digest.length && timingSafeEqual(given, digest);
}

export const publicUrl = () => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

export async function registerWebhooks(channel: ShopChannel) {
  const shop = await db.query.shops.findFirst({ where: eq(schema.shops.channel, channel) });
  if (!shop) throw new Error("notConfigured");
  const base = publicUrl();
  if (!base.startsWith("https://")) throw new Error("noPublicUrl");
  const uri = `${base}/api/shopify/webhook`;
  const existing = await gql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri: string }[] } }>(shop, `{ webhookSubscriptions(first: 50) { nodes { id topic uri } } }`);
  let created = 0;
  for (const topic of TOPICS) {
    if (existing.webhookSubscriptions.nodes.some((w) => w.topic === topic && w.uri === uri)) continue;
    const r = await gql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(shop,
      `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } } }`,
      { topic, sub: { uri } });
    if (r.webhookSubscriptionCreate.userErrors.length) throw new Error(r.webhookSubscriptionCreate.userErrors.map((e) => e.message).join("; "));
    created++;
  }
  await db.update(schema.shops).set({ webhooksAt: new Date() }).where(eq(schema.shops.channel, channel));
  await logEvent(channel, "info", "webhook", `registered:${created}`);
  return created;
}

/**
 * Fehlende Kunden-Webhooks im Shop anlegen (Worker, höchstens alle 6 h je Shop) – die Bestell-Webhooks richtet weiter der
 * Knopf auf der Shop-Seite ein. Ohne öffentliche https-Adresse (lokal) oder ohne Recht: nichts, der 5-min-Abgleich reicht.
 */
const ensured = ((globalThis as { __ssCustomerHooks?: Map<string, number> }).__ssCustomerHooks ??= new Map());
export async function ensureCustomerWebhooks(channel: ShopChannel) {
  if (Date.now() - (ensured.get(channel) ?? 0) < 6 * 3600_000) return 0;
  ensured.set(channel, Date.now());
  const shop = await db.query.shops.findFirst({ where: eq(schema.shops.channel, channel) });
  const base = publicUrl();
  if (!shop?.domain || !(shop.clientSecretEnc || shop.staticTokenEnc) || !base.startsWith("https://")) return 0;
  const uri = `${base}/api/shopify/webhook`;
  let created = 0;
  try {
    const existing = await gql<{ webhookSubscriptions: { nodes: { topic: string; uri: string }[] } }>(shop, `{ webhookSubscriptions(first: 50) { nodes { topic uri } } }`);
    for (const topic of CUSTOMER_TOPICS) {
      if (existing.webhookSubscriptions.nodes.some((w) => w.topic === topic && w.uri === uri)) continue;
      const r = await gql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(shop,
        `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { userErrors { message } } }`,
        { topic, sub: { uri } });
      if (r.webhookSubscriptionCreate.userErrors.length) throw new Error(r.webhookSubscriptionCreate.userErrors.map((e) => e.message).join("; "));
      created++;
    }
    if (created) await logEvent(channel, "info", "webhook", `registered:${created}`);
  } catch (e) {
    const key = `daily:customerHooks:${channel}:${todayIso()}`;
    const first = await db.insert(schema.shopProcessed).values({ key }).onConflictDoNothing().returning({ key: schema.shopProcessed.key });
    if (first.length) await logEvent(channel, "warn", "webhook", `customerHooksFailed:${String((e as Error).message ?? e).slice(0, 200)}`);
  }
  return created;
}

/** Eingehender Webhook: prüfen, dann Bestellung bzw. Kunde im Hintergrund neu laden und verarbeiten. */
export async function handleWebhook(raw: string, headers: Headers): Promise<number> {
  const domain = headers.get("x-shopify-shop-domain") ?? "";
  const shop = (await db.select().from(schema.shops)).find((s) => s.domain && normalizeDomain(s.domain) === normalizeDomain(domain || "x"));
  if (!shop) return 404;
  if (!verifyHmac(raw, decrypt(shop.clientSecretEnc), headers.get("x-shopify-hmac-sha256"))) return 401;
  const topic = headers.get("x-shopify-topic") ?? "";
  // Kundenkonten kommen auch bei ausgeschaltetem Bestands-Abgleich ins System (Wunsch Inhaber 13.11.2026)
  if (topic.startsWith("customers/")) {
    let c: { admin_graphql_api_id?: string } = {};
    try { c = JSON.parse(raw); } catch { return 400; }
    const id = c.admin_graphql_api_id;
    if (id) void syncShopCustomerById(shop.channel as ShopChannel, id)
      .catch((e) => logEvent(shop.channel as ShopChannel, "error", "webhook", String(e).slice(0, 500), id).catch(() => {}));
    return 200;
  }
  if (!shop.active) return 200;
  let body: { admin_graphql_api_id?: string; order_id?: number } = {};
  try { body = JSON.parse(raw); } catch { return 400; }
  const orderGid = topic.startsWith("refunds/") ? (body.order_id ? `gid://shopify/Order/${body.order_id}` : null) : body.admin_graphql_api_id ?? null;
  if (orderGid) {
    void (async () => {
      try {
        const o = await fetchOrder(shop, orderGid);
        if (o) await processOrder(shop, o);
      } catch (e) { await logEvent(shop.channel as ShopChannel, "error", "webhook", String(e).slice(0, 500), orderGid); }
    })();
  }
  return 200;
}
