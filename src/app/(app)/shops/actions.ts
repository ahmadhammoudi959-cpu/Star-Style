"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { normalizeDomain, ShopifyError, type ShopChannel } from "@/lib/shopify/client";
import { linkVariant, processDirty, pushStock, syncOrders, syncProducts, testConnection, runCycle } from "@/lib/shopify/sync";
import { registerWebhooks } from "@/lib/shopify/webhooks";

export type ShopResult = { ok?: string; error?: string; detail?: string; locations?: { id: string; name: string }[] };
const CH = (v: unknown): ShopChannel => (v === "GENERAL_SHOP" ? "GENERAL_SHOP" : "BRAND_SHOP");
const fail = (e: unknown): ShopResult => {
  if (e instanceof ShopifyError) return { error: e.code, detail: e.message.slice(0, 200) };
  const m = e instanceof Error ? e.message : String(e);
  if (m === "noPublicUrl") return { error: "noPublicUrl" };
  console.error(e);
  return { error: "other", detail: m.slice(0, 200) };
};
const done = (channel: ShopChannel, ok = "saved"): ShopResult => { revalidatePath("/shops"); revalidatePath(`/shops/${channel}`); return { ok }; };

export async function saveShopAction(_: ShopResult | undefined, fd: FormData): Promise<ShopResult> {
  await requireSession();
  const channel = CH(fd.get("channel"));
  const domainRaw = String(fd.get("domain") ?? "").trim();
  if (!domainRaw) return { error: "notConfigured" };
  const legacy = fd.get("legacy") === "on";
  const secret = String(fd.get("clientSecret") ?? "").trim();
  const token = String(fd.get("staticToken") ?? "").trim();
  const ex = await db.query.shops.findFirst({ where: eq(schema.shops.channel, channel) });
  const values = {
    domain: normalizeDomain(domainRaw), clientId: String(fd.get("clientId") ?? "").trim(),
    stockBuffer: Math.max(0, Math.min(9999, Number(fd.get("stockBuffer")) || 0)), importTestOrders: fd.get("importTestOrders") === "on",
    ...(secret ? { clientSecretEnc: encrypt(secret) } : {}),
    ...(legacy ? (token ? { staticTokenEnc: encrypt(token) } : {}) : { staticTokenEnc: "" }),
    tokenEnc: "", tokenExpiresAt: null,
  };
  if (!ex?.clientSecretEnc && !secret) return { error: "notConfigured" };
  if (legacy && !ex?.staticTokenEnc && !token) return { error: "notConfigured" };
  if (!legacy && !values.clientId) return { error: "notConfigured" };
  await db.insert(schema.shops).values({ channel, ...values }).onConflictDoUpdate({ target: schema.shops.channel, set: values });
  return done(channel);
}

export async function testShopAction(channel: string): Promise<ShopResult> {
  await requireSession();
  try {
    const r = await testConnection(CH(channel));
    return { ok: r.name, locations: r.locations.map((l) => ({ id: l.id, name: l.name })) };
  } catch (e) { return fail(e); }
}

export async function setLocationAction(channel: string, locationId: string, name: string): Promise<ShopResult> {
  await requireSession();
  await db.update(schema.shops).set({ locationId, locationName: name, }).where(eq(schema.shops.channel, CH(channel)));
  await db.update(schema.shopVariants).set({ lastPushedQty: null }).where(eq(schema.shopVariants.channel, CH(channel)));
  return done(CH(channel));
}

export async function activateAction(channel: string, on: boolean): Promise<ShopResult> {
  await requireSession();
  const ch = CH(channel);
  const s = await db.query.shops.findFirst({ where: eq(schema.shops.channel, ch) });
  if (!s?.domain) return { error: "notConfigured" };
  if (on && !s.locationId) return { error: "noLocation" };
  await db.update(schema.shops).set({ active: on, ...(on && !s.ordersSince ? { ordersSince: new Date() } : {}) }).where(eq(schema.shops.channel, ch));
  if (on) void runCycle({ orders: true, reconcile: true }).catch(() => {});
  return done(ch, on ? "on" : "off");
}

export async function loadProductsAction(channel: string): Promise<ShopResult> {
  await requireSession();
  try { const r = await syncProducts(CH(channel)); return { ...done(CH(channel)), ok: `${r.total}|${r.matched}|${r.open}` }; } catch (e) { return fail(e); }
}

export async function webhooksAction(channel: string): Promise<ShopResult> {
  await requireSession();
  try { const n = await registerWebhooks(CH(channel)); return { ...done(CH(channel)), ok: String(n) }; } catch (e) { return fail(e); }
}

export async function syncNowAction(channel: string): Promise<ShopResult> {
  await requireSession();
  const ch = CH(channel);
  try {
    await processDirty();
    const o = await syncOrders(ch);
    const s = await pushStock(ch);
    return { ...done(ch), ok: `${o.processed}|${s.pushed}|${s.errors}` };
  } catch (e) { return fail(e); }
}

export async function pushAllAction(channel: string): Promise<ShopResult> {
  await requireSession();
  try { const s = await pushStock(CH(channel), { force: true }); return { ...done(CH(channel)), ok: `${s.pushed}|${s.errors}` }; } catch (e) { return fail(e); }
}

export async function linkAction(channel: string, rowId: string, variantId: string | null): Promise<ShopResult> {
  await requireSession();
  await linkVariant(CH(channel), rowId, variantId);
  revalidatePath(`/shops/${channel}/mapping`);
  return { ok: "saved" };
}
