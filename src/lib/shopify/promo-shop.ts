import "server-only";
/**
 * Aktionen in den Shops (Wunsch Inhaber 19.11.2026):
 * - Kollektion „Angebote“ (Handle angebote): automatisch, Bedingung „Preis reduziert“ (IS_PRICE_REDUCED = Streichpreis gesetzt) –
 *   jeder rabattierte Artikel steht von selbst drin, nach der Aktion fällt er heraus. Das Theme zeigt den Menüpunkt „Angebote“
 *   nur, wenn sie Artikel hat. Wir legen sie an, wenn sie fehlt (nie löschen).
 * - Werbebild über/unter dem Hero: die fertigen Bilder (je Sprache breit + hoch) gehen nach Shopify Files (Recht write_files),
 *   ihre Adressen stehen im Metafeld star_style.banner (JSON) der Kollektion „Angebote“ – das liest der Abschnitt star-promo
 *   im Theme. Geschrieben wird nur bei Änderung (shops.promo_banner = zuletzt geschriebener Inhalt).
 * Der Streichpreis selbst kommt über ./prices.ts (Preis-Abgleich).
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, getShop, refreshTokenOnce, ShopifyError, type Shop, type ShopChannel } from "./client";
import { configured, publishToOnlineStore } from "./admin";
import { CHANNELS, logEvent } from "./sync";
import { todayIso } from "../dates";
import { bannerAlt, bannerJson, bannerSlots, BANNER_LANGS, isActive, type BannerCandidate, type SlotData } from "../promo-rules";

export const OFFERS_HANDLE = "angebote";
const OFFERS_TITLE: Record<string, string> = { de: "Angebote", en: "Offers", ar: "العروض", nl: "Aanbiedingen" };
const SCOPE_RE = /access denied|not approved|required access|access scope|write_files|write_images|write_themes/i;
const isScope = (e: unknown) => e instanceof ShopifyError && (e.code === "graphql" || e.code === "auth") && SCOPE_RE.test(e.message);
const transient = (e: unknown) => !(e instanceof ShopifyError) || e.code === "network" || e.code === "throttled";

/** Einmal mit frischem Token wiederholen, wenn ein Recht fehlt (der Token kann von vor der Freigabe stammen) */
async function call<T>(shop: Shop, q: string, v: Record<string, unknown> = {}): Promise<T> {
  try { return await gql<T>(shop, q, v); } catch (e) {
    if (isScope(e) && (await refreshTokenOnce(shop))) return gql<T>(shop, q, v);
    throw e;
  }
}

// ───────────────────────── Kollektion „Angebote“ ─────────────────────────

const BY_HANDLE_Q = `query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id handle } }`;
const NODE_Q = `query($id: ID!) { node(id: $id) { ... on Collection { id handle } } }`;
const CREATE_M = `mutation($input: CollectionInput!) { collectionCreate(input: $input) { collection { id handle } userErrors { field message } } }`;
const TR_Q = `query($id: ID!) { translatableResource(resourceId: $id) { translatableContent { key digest locale } } }`;
const TR_M = `mutation($id: ID!, $t: [TranslationInput!]!) { translationsRegister(resourceId: $id, translations: $t) { userErrors { message } } }`;
const LOCALES_Q = `{ shopLocales(published: true) { locale } }`;

/** Kollektion „Angebote“ finden oder anlegen; Id wird in shops gemerkt (gelöscht im Shop → neu anlegen) */
export async function ensureOffersCollection(shop: Shop): Promise<string> {
  if (shop.offersCollectionId) {
    const d = await call<{ node: { id: string } | null }>(shop, NODE_Q, { id: shop.offersCollectionId });
    if (d.node?.id) return d.node.id;
  }
  const found = (await call<{ collectionByIdentifier: { id: string } | null }>(shop, BY_HANDLE_Q, { h: OFFERS_HANDLE })).collectionByIdentifier;
  let id = found?.id;
  if (!id) {
    const d = await call<{ collectionCreate: { collection: { id: string } | null; userErrors: { message: string }[] } }>(shop, CREATE_M, {
      input: {
        title: OFFERS_TITLE.de, handle: OFFERS_HANDLE, sortOrder: "BEST_SELLING",
        descriptionHtml: "<p>Alle Artikel, die gerade im Angebot sind.</p>",
        ruleSet: { appliedDisjunctively: false, rules: [{ column: "IS_PRICE_REDUCED", relation: "IS_SET", condition: "" }] },
      },
    });
    const c = d.collectionCreate.collection;
    if (!c || d.collectionCreate.userErrors.length) throw new ShopifyError("userErrors", d.collectionCreate.userErrors.map((e) => e.message).join("; ") || "collectionCreate");
    id = c.id;
    await publishToOnlineStore(shop, id).catch((e) => console.error("offers publish", e));
    await translateOffersTitle(shop, id).catch(() => {}); // ohne Recht write_translations: Titel bleibt deutsch (Theme zeigt eigenen Text)
    await logEvent(shop.channel as ShopChannel, "info", "products", "offersCreated");
  }
  await db.update(schema.shops).set({ offersCollectionId: id }).where(eq(schema.shops.channel, shop.channel));
  shop.offersCollectionId = id;
  return id;
}

async function translateOffersTitle(shop: Shop, id: string) {
  const [res, loc] = await Promise.all([
    call<{ translatableResource: { translatableContent: { key: string; digest: string }[] } | null }>(shop, TR_Q, { id }),
    call<{ shopLocales: { locale: string }[] }>(shop, LOCALES_Q),
  ]);
  const title = res.translatableResource?.translatableContent.find((c) => c.key === "title");
  if (!title) return;
  const t = loc.shopLocales.map((l) => l.locale.slice(0, 2)).filter((l) => l !== "de" && OFFERS_TITLE[l])
    .map((l) => ({ key: "title", locale: l, value: OFFERS_TITLE[l], translatableContentDigest: title.digest }));
  if (t.length) await call(shop, TR_M, { id, t });
}

// ───────────────────────── Werbebild hochladen ─────────────────────────

const STAGED_M = `mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
  stagedTargets { url resourceUrl parameters { name value } } userErrors { field message } } }`;
const FILE_CREATE_M = `mutation($files: [FileCreateInput!]!) { fileCreate(files: $files) { files { id fileStatus } userErrors { field message } } }`;
const FILES_Q = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id fileStatus image { url } } } }`;
const FILE_DELETE_M = `mutation($ids: [ID!]!) { fileDelete(fileIds: $ids) { deletedFileIds userErrors { message } } }`;

type Media = Record<string, { id: string; url: string }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bilder einer Aktion (key → stored_files.id) nach Shopify Files; wartet, bis Shopify sie verarbeitet hat (höchstens ~60 s) */
async function uploadBanner(shop: Shop, promo: { number: number; bannerVersion: number }, files: Record<string, string>, alt: Record<string, string>): Promise<Media> {
  const keys = Object.keys(files).sort();
  const rows = await db.select({ id: schema.storedFiles.id, data: schema.storedFiles.data, mime: schema.storedFiles.mime, size: schema.storedFiles.size })
    .from(schema.storedFiles).where(sql`${schema.storedFiles.id} in (${sql.join(keys.map((k) => sql`${files[k]}`), sql`, `)})`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const list = keys.map((k) => ({ key: k, f: byId.get(files[k]) })).filter((x): x is { key: string; f: NonNullable<typeof x.f> } => Boolean(x.f));
  if (!list.length) throw new ShopifyError("userErrors", "noFiles");
  const names = list.map((x) => `star-aktion-${promo.number}-v${promo.bannerVersion}-${x.key}.webp`);
  const st = await call<{ stagedUploadsCreate: { stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[]; userErrors: { message: string }[] } }>(
    shop, STAGED_M, { input: list.map((x, i) => ({ resource: "IMAGE", filename: names[i], mimeType: x.f.mime, httpMethod: "POST", fileSize: String(x.f.size) })) });
  if (st.stagedUploadsCreate.userErrors.length) throw new ShopifyError("userErrors", st.stagedUploadsCreate.userErrors.map((e) => e.message).join("; "));
  const targets = st.stagedUploadsCreate.stagedTargets;
  for (const [i, t] of targets.entries()) {
    const form = new FormData();
    for (const p of t.parameters) form.append(p.name, p.value);
    form.append("file", new Blob([new Uint8Array(list[i].f.data)], { type: list[i].f.mime }), names[i]);
    const res = await fetch(t.url, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new ShopifyError("network", `upload HTTP ${res.status}`);
  }
  const fc = await call<{ fileCreate: { files: { id: string }[] | null; userErrors: { message: string }[] } }>(shop, FILE_CREATE_M, {
    files: list.map((x, i) => ({ originalSource: targets[i].resourceUrl, contentType: "IMAGE", filename: names[i], alt: alt[x.key.split("-")[1]] ?? "" })),
  });
  if (fc.fileCreate.userErrors.length || !fc.fileCreate.files) throw new ShopifyError("userErrors", fc.fileCreate.userErrors.map((e) => e.message).join("; ") || "fileCreate");
  const ids = fc.fileCreate.files.map((f) => f.id);
  const out: Media = {};
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(attempt ? 2000 : 1200);
    const d = await call<{ nodes: ({ id: string; fileStatus: string; image: { url: string } | null } | null)[] }>(shop, FILES_Q, { ids });
    if (d.nodes.some((n) => n?.fileStatus === "FAILED")) {
      await call(shop, FILE_DELETE_M, { ids }).catch(() => {});
      throw new ShopifyError("userErrors", "fileFailed");
    }
    if (d.nodes.every((n) => n?.fileStatus === "READY" && n.image?.url)) {
      d.nodes.forEach((n, i) => { out[list[i].key] = { id: n!.id, url: n!.image!.url }; });
      return out;
    }
  }
  throw new ShopifyError("network", "fileTimeout");
}

async function deleteMedia(shop: Shop, ids: string[]) {
  if (!ids.length) return;
  try { await call(shop, FILE_DELETE_M, { ids }); } catch (e) { console.error("promo fileDelete", e); }
}

// ───────────────────────── Abgleich je Shop ─────────────────────────

const SET_MF_M = `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { metafields { id } userErrors { field message } } }`;

type PromoRow = typeof schema.promotions.$inferSelect;
const running = new Set<string>();

/**
 * Ein Shop: Bilder laufender Aktionen hochladen (neue Version), Plätze über/unter dem Hero besetzen (neueste gewinnt),
 * Metafeld schreiben, alte Bilder löschen; Kollektion „Angebote“ sicherstellen, sobald eine Aktion den Shop betrifft.
 */
export async function syncPromoShop(channel: ShopChannel): Promise<void> {
  if (running.has(channel)) return;
  running.add(channel);
  try {
    const shop = await getShop(channel);
    if (!configured(shop)) return;
    const d = todayIso();
    const promos = await db.select().from(schema.promotions);
    const relevant = promos.filter((p) => !p.endedAt && ((p.priceOn && (p.places as string[]).includes(channel)) || (p.bannerOn && (p.bannerShops as string[]).includes(channel))));
    const empty = bannerJson({});
    const written = shop.promoBanner || empty;
    if (!relevant.length && written === empty) return; // nichts zu tun, im Shop steht kein Bild
    const states = new Map((await db.select().from(schema.promotionShops).where(eq(schema.promotionShops.channel, channel))).map((s) => [s.promotionId, s]));
    const bannerActive = (p: PromoRow) => isActive({ on: p.bannerOn, from: p.bannerFrom, until: p.bannerUntil }, d, !!p.endedAt)
      && (p.bannerShops as string[]).includes(channel) && Object.keys(p.bannerFiles ?? {}).length > 0;

    // 1) Bilder hochladen, wo nötig
    const oldMedia: string[] = [];
    for (const p of promos.filter(bannerActive)) {
      const st = states.get(p.id);
      if (st && st.bannerVersion === p.bannerVersion && Object.keys(st.media).length) continue;
      if (st && st.tries >= 30 && st.error && !st.error.startsWith("needScope") && st.bannerVersion === p.bannerVersion) continue; // dauerhaft abgelehnt → nicht endlos
      try {
        const alt = Object.fromEntries(BANNER_LANGS.map((l) => [l, bannerAlt(l, Math.round(p.discountBp / 100), p.bannerCopy?.[l]?.headline ?? "")]));
        const media = await uploadBanner(shop, p, p.bannerFiles, alt);
        if (st) oldMedia.push(...Object.values(st.media).map((m) => m.id));
        const row = { promotionId: p.id, channel, bannerVersion: p.bannerVersion, media, error: "", tries: 0 };
        await db.insert(schema.promotionShops).values(row).onConflictDoUpdate({ target: [schema.promotionShops.promotionId, schema.promotionShops.channel], set: { bannerVersion: row.bannerVersion, media, error: "", tries: 0 } });
        states.set(p.id, { ...row, updatedAt: new Date() } as typeof schema.promotionShops.$inferSelect);
      } catch (e) {
        const error = isScope(e) ? "needScope:write_files" : transient(e) ? "network" : (e as Error).message.slice(0, 300);
        await db.insert(schema.promotionShops).values({ promotionId: p.id, channel, bannerVersion: st?.bannerVersion ?? 0, media: st?.media ?? {}, error, tries: 1 })
          .onConflictDoUpdate({ target: [schema.promotionShops.promotionId, schema.promotionShops.channel], set: { error, tries: sql`${schema.promotionShops.tries} + 1` } });
        if (!st?.error || st.error !== error) await logEvent(channel, "warn", "products", error.startsWith("needScope") ? "needScopeFiles" : `promoBannerFailed:${error}`);
      }
    }

    // 2) Plätze besetzen und Metafeld schreiben (nur bei Änderung)
    const cands: BannerCandidate[] = promos.map((p) => ({
      id: p.id, shops: p.bannerShops as string[], place: p.bannerPlace, startedAt: (p.bannerStartedAt ?? p.updatedAt).getTime(),
      active: bannerActive(p), ready: Boolean(states.get(p.id)?.bannerVersion === p.bannerVersion && Object.keys(states.get(p.id)?.media ?? {}).length),
    }));
    const slots = bannerSlots(cands, channel);
    const handles = await productHandles(shop, promos, slots);
    const slotData = (id: string | null): SlotData | null => {
      if (!id) return null;
      const p = promos.find((x) => x.id === id)!, m = states.get(id)!.media;
      const img: SlotData["img"] = {};
      for (const l of BANNER_LANGS) if (m[`wide-${l}`] && m[`tall-${l}`]) img[l] = { w: m[`wide-${l}`].url, t: m[`tall-${l}`].url };
      return {
        id, pct: Math.round(p.discountBp / 100), until: p.priceOn && p.priceUntil ? p.priceUntil : null, product: handles.get(id) ?? null, img,
        alt: Object.fromEntries(BANNER_LANGS.map((l) => [l, bannerAlt(l, Math.round(p.discountBp / 100), p.bannerCopy?.[l]?.headline ?? "")])),
      };
    };
    const json = bannerJson({ top: slotData(slots.top), below: slotData(slots.below) });
    if (json !== written) {
      const collectionId = await ensureOffersCollection(shop);
      const r = await call<{ metafieldsSet: { userErrors: { message: string }[] } }>(shop, SET_MF_M, {
        m: [{ ownerId: collectionId, namespace: "star_style", key: "banner", type: "json", value: json }],
      });
      if (r.metafieldsSet.userErrors.length) throw new ShopifyError("userErrors", r.metafieldsSet.userErrors.map((e) => e.message).join("; "));
      await db.update(schema.shops).set({ promoBanner: json }).where(eq(schema.shops.channel, channel));
      const before = (() => { try { return JSON.parse(written) as { top: { id: string } | null; below: { id: string } | null }; } catch { return { top: null, below: null }; } })();
      for (const place of ["top", "below"] as const) {
        const was = before[place]?.id ?? null, now = slots[place];
        if (was === now) continue;
        const num = (id: string | null) => (id ? `#${promos.find((p) => p.id === id)?.number ?? "?"}` : "");
        if (now) await logEvent(channel, "info", "products", `promoBannerShown:${num(now)} (${place === "top" ? "↑" : "↓"})`);
        else if (was) await logEvent(channel, "info", "products", `promoBannerOff:${num(was)}`);
      }
    } else if (relevant.length && !shop.offersCollectionId) {
      await ensureOffersCollection(shop); // Rabatt ohne Bild: Kollektion trotzdem anlegen (Menüpunkt „Angebote“)
    }
    await deleteMedia(shop, oldMedia);
  } catch (e) {
    console.error("promo shop sync", channel, e);
    if (isScope(e)) await logEvent(channel, "warn", "products", "needScopeFiles").catch(() => {});
  } finally {
    running.delete(channel);
  }
}

/** Bei genau einem Artikel führt das Bild direkt zu dessen Seite: Handle des Shop-Produkts */
async function productHandles(shop: Shop, promos: PromoRow[], slots: Record<string, string | null>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of Object.values(slots)) {
    if (!id || out.has(id)) continue;
    const items = (await db.execute<{ product_id: string }>(sql`select product_id from promotion_items where promotion_id = ${id}`)).rows;
    if (items.length !== 1) continue;
    const sv = (await db.execute<{ shop_variant_id: string }>(sql`select sv.shop_variant_id from shop_variants sv join variants v on v.id = sv.variant_id
      where sv.channel = ${shop.channel} and v.product_id = ${String(items[0].product_id)} limit 1`)).rows[0];
    if (!sv) continue;
    try {
      const d = await call<{ node: { product: { handle: string } } | null }>(shop, `query($id: ID!) { node(id: $id) { ... on ProductVariant { product { handle } } } }`, { id: sv.shop_variant_id });
      if (d.node?.product.handle) out.set(id, d.node.product.handle);
    } catch { /* dann eben „Angebote“ */ }
  }
  void promos;
  return out;
}

/** Worker + nach jeder Änderung an einer Aktion: alle Shops */
export async function syncPromoShops(): Promise<void> {
  for (const ch of CHANNELS) await syncPromoShop(ch);
}

/** Aktion wird gelöscht: ihre Bilder auch aus Shopify Files entfernen (so gut es geht – im Shop stehen sie da schon nicht mehr) */
export async function deletePromoMedia(promotionId: string): Promise<void> {
  const rows = await db.select().from(schema.promotionShops).where(eq(schema.promotionShops.promotionId, promotionId));
  for (const r of rows) {
    const ids = Object.values(r.media ?? {}).map((m) => m.id);
    if (!ids.length) continue;
    const shop = await getShop(r.channel as ShopChannel);
    if (configured(shop)) await deleteMedia(shop, ids);
  }
}

/** Stand je Shop für die Oberfläche */
export async function promoShopStates(promotionId: string) {
  const rows = await db.select().from(schema.promotionShops).where(eq(schema.promotionShops.promotionId, promotionId));
  return new Map(rows.map((r) => [r.channel as string, r]));
}
