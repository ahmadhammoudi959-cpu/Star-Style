import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt } from "../crypto";
import { gql, normalizeDomain, type ShopChannel } from "./client";
import { fetchOrder, logEvent, processOrder } from "./sync";

export const TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "REFUNDS_CREATE"] as const;

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

/** Eingehender Webhook: prüfen, dann Bestellung im Hintergrund neu laden und verarbeiten. */
export async function handleWebhook(raw: string, headers: Headers): Promise<number> {
  const domain = headers.get("x-shopify-shop-domain") ?? "";
  const shop = (await db.select().from(schema.shops)).find((s) => s.domain && normalizeDomain(s.domain) === normalizeDomain(domain || "x"));
  if (!shop) return 404;
  if (!verifyHmac(raw, decrypt(shop.clientSecretEnc), headers.get("x-shopify-hmac-sha256"))) return 401;
  if (!shop.active) return 200;
  const topic = headers.get("x-shopify-topic") ?? "";
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
