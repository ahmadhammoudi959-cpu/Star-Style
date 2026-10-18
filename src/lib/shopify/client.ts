import "server-only";
/**
 * Shopify Admin GraphQL API.
 * Zugang: App im Dev Dashboard (Client-ID + Secret → Token per „client credentials“, 24 h gültig, wird automatisch erneuert)
 * oder ältere Custom App mit festem Token (shpat_…). Beide werden unterstützt.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt, encrypt } from "../crypto";

export const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";
export type ShopChannel = "BRAND_SHOP" | "GENERAL_SHOP";
export type Shop = typeof schema.shops.$inferSelect;

export class ShopifyError extends Error {
  constructor(public code: "notConfigured" | "auth" | "throttled" | "network" | "graphql" | "userErrors", message: string) { super(message); }
}

export const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.myshopify\.com$/, "") + ".myshopify.com";

export async function getShop(channel: ShopChannel): Promise<Shop | undefined> {
  return db.query.shops.findFirst({ where: eq(schema.shops.channel, channel) });
}

type FetchLike = typeof fetch;
/** Nur für Tests: alle Aufrufe an einen lokalen Nachbau von Shopify schicken */
const base = (shop: Shop) => process.env.SHOPIFY_MOCK_URL || `https://${shop.domain}`;

/** Zugriffstoken holen (fester Token oder per Client-Credentials, zwischengespeichert bis kurz vor Ablauf). */
export async function accessToken(shop: Shop, f: FetchLike = fetch): Promise<string> {
  if (shop.staticTokenEnc) return decrypt(shop.staticTokenEnc);
  if (!shop.domain || !shop.clientId || !shop.clientSecretEnc) throw new ShopifyError("notConfigured", "Zugangsdaten fehlen");
  if (shop.tokenEnc && shop.tokenExpiresAt && shop.tokenExpiresAt.getTime() - Date.now() > 10 * 60_000) return decrypt(shop.tokenEnc);
  const res = await f(`${base(shop)}/admin/oauth/access_token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: shop.clientId, client_secret: decrypt(shop.clientSecretEnc) }),
  }).catch((e) => { throw new ShopifyError("network", String(e)); });
  if (!res.ok) throw new ShopifyError("auth", `Token: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  const expires = new Date(Date.now() + (j.expires_in ?? 86399) * 1000);
  await db.update(schema.shops).set({ tokenEnc: encrypt(j.access_token), tokenExpiresAt: expires }).where(eq(schema.shops.channel, shop.channel));
  shop.tokenEnc = encrypt(j.access_token); shop.tokenExpiresAt = expires;
  return j.access_token;
}

/** GraphQL-Aufruf mit Wiederholung bei Drosselung (THROTTLED / 429 / 5xx). */
export async function gql<T>(shop: Shop, query: string, variables: Record<string, unknown> = {}, f: FetchLike = fetch): Promise<T> {
  let lastErr: ShopifyError = new ShopifyError("network", "unbekannt");
  for (let attempt = 0; attempt < 5; attempt++) {
    const token = await accessToken(shop, f);
    let res: Response;
    try {
      res = await f(`${base(shop)}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST", headers: { "content-type": "application/json", "x-shopify-access-token": token }, body: JSON.stringify({ query, variables }),
      });
    } catch (e) { lastErr = new ShopifyError("network", String(e)); await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 401 || res.status === 403) {
      // abgelaufener Token? einmal neu holen
      if (!shop.staticTokenEnc && attempt === 0) { shop.tokenExpiresAt = null; continue; }
      throw new ShopifyError("auth", `HTTP ${res.status}`);
    }
    if (res.status === 429 || res.status >= 500) { lastErr = new ShopifyError("throttled", `HTTP ${res.status}`); await sleep(1000 * 2 ** attempt); continue; }
    const j = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (j.errors?.length) {
      if (j.errors.some((e) => e.extensions?.code === "THROTTLED")) { lastErr = new ShopifyError("throttled", "THROTTLED"); await sleep(1000 * 2 ** attempt); continue; }
      throw new ShopifyError("graphql", j.errors.map((e) => e.message).join("; ").slice(0, 500));
    }
    return j.data as T;
  }
  throw lastErr;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
