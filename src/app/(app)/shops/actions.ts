"use server";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { encrypt } from "@/lib/crypto";
import { getShop, normalizeDomain, ShopifyError, type ShopChannel } from "@/lib/shopify/client";
import {
  bulkPushStatus, getStoreTypes, pushProductToShop, setCategoryMapping, startBulkPush, unlistProduct, type BulkState, type PushResult,
} from "@/lib/shopify/product-push";
import { pushWeights } from "@/lib/shopify/weights";
import { linkVariant, processDirty, pushStock, syncOrders, syncProducts, testConnection, runCycle } from "@/lib/shopify/sync";
import { registerWebhooks } from "@/lib/shopify/webhooks";
import { importProducts } from "@/lib/shopify/import";

export type ShopResult = { ok?: string; error?: string; detail?: string; locations?: { id: string; name: string }[] };
const CH = (v: unknown): ShopChannel => (v === "GENERAL_SHOP" ? "GENERAL_SHOP" : "BRAND_SHOP");
const fail = (e: unknown): ShopResult => {
  if (e instanceof ShopifyError) return { error: e.code, detail: e.message.slice(0, 200) };
  const m = e instanceof Error ? e.message : String(e);
  if (m === "noPublicUrl") return { error: "noPublicUrl" };
  if (m === "noLocation") return { error: "noLocation" };
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

/** Fehlende Produkte aus dem Shop als Artikel anlegen (Bestand 0) und gleich zuordnen */
export async function importProductsAction(channel: string): Promise<ShopResult> {
  const session = await requireSession();
  const ch = CH(channel);
  try {
    const r = await importProducts(ch, { userId: session.uid });
    revalidatePath("/", "layout"); // Artikel, Lager, „Erste Schritte“ im Menü
    return { ...done(ch), ok: [r.created, r.variants, r.existing, r.matched, r.open, r.images, r.failed].join("|") };
  } catch (e) {
    const m = e instanceof Error ? e.message : "";
    if (m === "busy" || m === "currency") return { error: m };
    return fail(e);
  }
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

// ───────────── Artikel hochladen (Liste „Noch nicht im Shop“) ─────────────

const refreshPending = (channel: ShopChannel) => { revalidatePath(`/shops/${channel}`); revalidatePath("/"); revalidatePath("/products"); };

/** „Alle bereiten hochladen“: läuft im Hintergrund, Stand über bulkStatusAction */
export async function startBulkPushAction(channel: string): Promise<ShopResult & { bulk?: BulkState }> {
  const session = await requireSession();
  try { return { ok: "started", bulk: await startBulkPush(CH(channel), session.uid) }; } catch (e) { return fail(e); }
}

export async function bulkStatusAction(channel: string): Promise<BulkState | null> {
  await requireSession();
  const st = bulkPushStatus(CH(channel));
  if (st && !st.running) refreshPending(CH(channel));
  return st;
}

/** Einen Artikel hochladen; Ergebnis wie nach dem Speichern im Artikel */
export async function pushOneAction(channel: string, productId: string): Promise<{ result: PushResult | null }> {
  const session = await requireSession();
  const result = await pushProductToShop(CH(channel), productId, session.uid);
  refreshPending(CH(channel));
  return { result };
}

/** „Nicht für diesen Shop“ – nur das Häkchen entfernen */
export async function unlistAction(channel: string, productId: string): Promise<ShopResult> {
  const session = await requireSession();
  await unlistProduct(CH(channel), productId, session.uid);
  refreshPending(CH(channel));
  return { ok: "saved" };
}

/** Unsere Kategorie → Kategorie des Shops (leer = Zuordnung entfernen) */
export async function mapCategoryAction(channel: string, category: string, type: string): Promise<ShopResult> {
  const session = await requireSession();
  const ok = await setCategoryMapping(CH(channel), category, type || null, session.uid);
  refreshPending(CH(channel));
  return ok ? { ok: "saved" } : { error: "other", detail: "category" };
}

export async function refreshCategoriesAction(channel: string): Promise<ShopResult> {
  await requireSession();
  const shop = await getShop(CH(channel));
  if (!shop?.domain) return { error: "notConfigured" };
  try { const types = await getStoreTypes(shop, 0, true); refreshPending(CH(channel)); return { ok: String(types.length) }; } catch (e) { return fail(e); }
}

/** Alle Gewichte (Versand nach Gewicht) noch einmal an diesen Shop – im Hintergrund, Ergebnis im Protokoll */
export async function pushWeightsAction(channel: string): Promise<ShopResult> {
  await requireSession();
  const ch = CH(channel);
  void pushWeights(undefined, ch).then(() => revalidatePath(`/shops/${ch}`)).catch((e) => console.error("shopify weights", e));
  return { ok: "started" };
}
