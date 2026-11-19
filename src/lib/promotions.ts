import "server-only";
/**
 * Aktionen – Datenbank (Wunsch Inhaber 19.11.2026: „قسم العروض“ + „بالاربع جهات“). Regeln rein in ./promo-rules.ts,
 * Werbebild ./promo-banner.ts + ./promo-banner-job.ts, Shops ./shopify/promo-shop.ts (Bild, Kollektion „Angebote“) und
 * ./shopify/prices.ts (Streichpreis). Jede Änderung am Rabatt merkt die betroffenen Artikel für die Shops vor (shop_price_dirty);
 * erreicht ein Rabatt sein Datum, merkt der Worker sie vor (syncPromoPriceStates).
 */
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";
import { todayIso } from "./dates";
import { bestDiscounts, isActive, isShop, MAX_ITEMS, phaseState, type PhaseState, type PromoPlace, PROMO_PLACES, PROMO_SHOPS } from "./promo-rules";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<typeof db, "execute">;

export class PromoError extends Error {
  constructor(public code: "notFound" | "noItems" | "tooMany" | "percent" | "date" | "order" | "noPlaces" | "noShops" | "noBanner" | "running" | "notEnded", public detail = "") {
    super(code);
  }
}

const today = () => todayIso();
const placeIn = (place: string) => sql`p.places @> ${JSON.stringify([place])}::jsonb`;
const PRICE_ACTIVE = (d: string) => sql`p.ended_at is null and p.price_on
  and (p.price_from is null or p.price_from <= ${d}::date) and (p.price_until is null or p.price_until >= ${d}::date)`;

/** Laufende Rabatte an einem Ort: Artikel → Basispunkte (mehrere Aktionen: der höchste) */
export async function activeDiscounts(place: PromoPlace, productIds?: string[], ex: Exec = db): Promise<Map<string, number>> {
  if (productIds && !productIds.length) return new Map();
  const d = today();
  const r = await ex.execute<{ product_id: string; bp: number }>(sql`
    select i.product_id, max(p.discount_bp)::int as bp from promotion_items i join promotions p on p.id = i.promotion_id
    where ${PRICE_ACTIVE(d)} and ${placeIn(place)}
      ${productIds ? sql`and i.product_id in (${sql.join(productIds.map((x) => sql`${x}`), sql`, `)})` : sql``}
    group by i.product_id`);
  return bestDiscounts(r.rows.map((x) => ({ productId: String(x.product_id), bp: Number(x.bp) })));
}

/**
 * Rabatte, die jemand ohne Recht „Rabatt“ in Angebot/Rechnung behalten darf: der Rabatt einer Aktion (im System) auf
 * genau diesen Artikel – auch einer schon beendeten (ein Angebot aus der Aktionszeit wird später zur Rechnung).
 */
export async function allowedPromoBps(productIds: string[]): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  if (!productIds.length) return out;
  const r = await db.execute<{ product_id: string; bp: number }>(sql`
    select distinct i.product_id, p.discount_bp as bp from promotion_items i join promotions p on p.id = i.promotion_id
    where (${placeIn("SYSTEM")} or ${placeIn("DIRECT")}) and (p.price_live or p.price_on or p.ended_at is not null)
      and i.product_id in (${sql.join(productIds.map((x) => sql`${x}`), sql`, `)})`);
  for (const x of r.rows) {
    const s = out.get(String(x.product_id)) ?? new Set<number>();
    s.add(Number(x.bp));
    out.set(String(x.product_id), s);
  }
  return out;
}

/** Artikel für die Shops vormerken (Preis + Streichpreis neu melden) */
export async function markPromoDirty(productIds: string[], ex: Exec = db) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return;
  await ex.execute(sql`insert into shop_price_dirty (product_id, at)
    select id, now() from products where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    on conflict (product_id) do update set at = now()`);
}

const itemIds = async (ex: Exec, promotionId: string) =>
  (await ex.execute<{ product_id: string }>(sql`select product_id from promotion_items where promotion_id = ${promotionId}`)).rows.map((r) => String(r.product_id));

const shopsActive = (p: { places: string[] }) => p.places.some((x) => isShop(x));
const priceActiveNow = (p: typeof schema.promotions.$inferSelect, d = today()) =>
  isActive({ on: p.priceOn, from: p.priceFrom, until: p.priceUntil }, d, !!p.endedAt);

/** Stand des Rabatts an die Shops geben: Artikel vormerken, wenn er in einem Shop gilt oder galt */
async function applyPriceState(tx: Tx, before: { places: string[]; live: boolean; items: string[] }, p: typeof schema.promotions.$inferSelect) {
  const live = priceActiveNow(p);
  const items = await itemIds(tx, p.id);
  if ((before.live && shopsActive(before)) || (live && shopsActive(p))) await markPromoDirty([...before.items, ...items], tx);
  if (live !== p.priceLive) await tx.update(schema.promotions).set({ priceLive: live }).where(eq(schema.promotions.id, p.id));
}

async function lockPromo(tx: Tx, id: string) {
  const r = await tx.execute<{ id: string }>(sql`select id from promotions where id = ${id} for update`);
  if (!r.rows.length) throw new PromoError("notFound");
  const p = await tx.query.promotions.findFirst({ where: eq(schema.promotions.id, id) });
  if (!p) throw new PromoError("notFound");
  return p;
}

/** Änderung in EINER Transaktion: alter Stand → Änderung → Shops vormerken → Protokoll */
async function change(id: string, userId: string, action: string, fn: (tx: Tx, p: typeof schema.promotions.$inferSelect) => Promise<Partial<typeof schema.promotions.$inferInsert> | void>) {
  return db.transaction(async (tx) => {
    const p = await lockPromo(tx, id);
    const items = await itemIds(tx, id);
    const set = await fn(tx, p);
    if (set && Object.keys(set).length) await tx.update(schema.promotions).set(set).where(eq(schema.promotions.id, id));
    const now = await tx.query.promotions.findFirst({ where: eq(schema.promotions.id, id) });
    await applyPriceState(tx, { places: p.places, live: p.priceLive, items }, now!);
    await audit(tx, { entity: "promotion", entityId: id, action, before: { ...strip(p), items }, after: { ...strip(now!), items: await itemIds(tx, id) }, userId });
    return now!;
  });
}
const strip = (p: typeof schema.promotions.$inferSelect) => ({
  number: p.number, title: p.title, discountBp: p.discountBp, places: p.places, priceOn: p.priceOn, priceFrom: p.priceFrom, priceUntil: p.priceUntil,
  bannerOn: p.bannerOn, bannerFrom: p.bannerFrom, bannerUntil: p.bannerUntil, bannerShops: p.bannerShops, bannerPlace: p.bannerPlace,
  bannerVersion: p.bannerVersion, endedAt: p.endedAt,
});

function checkWindow(from: string | null, until: string | null) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !iso.test(from)) || (until && !iso.test(until))) throw new PromoError("date");
  if (from && until && until < from) throw new PromoError("order");
}

// ───────────────────────── Anlegen / Ändern ─────────────────────────

export async function createPromotion(input: { title: string; discountBp: number; productIds: string[]; places: string[] }, userId: string): Promise<string> {
  const ids = [...new Set(input.productIds)];
  if (!ids.length) throw new PromoError("noItems");
  if (ids.length > MAX_ITEMS) throw new PromoError("tooMany");
  if (!(input.discountBp >= 100 && input.discountBp <= 9000 && input.discountBp % 100 === 0)) throw new PromoError("percent");
  const places = PROMO_PLACES.filter((x) => input.places.includes(x));
  if (!places.length) throw new PromoError("noPlaces");
  return db.transaction(async (tx) => {
    const found = (await tx.select({ id: schema.products.id }).from(schema.products).where(inArray(schema.products.id, ids))).map((r) => r.id);
    if (!found.length) throw new PromoError("noItems");
    const order = ids.filter((x) => found.includes(x));
    const shops = PROMO_SHOPS.filter((s) => places.includes(s));
    const [p] = await tx.insert(schema.promotions).values({
      title: input.title.trim().slice(0, 120), discountBp: input.discountBp, places, createdBy: userId,
      bannerShops: shops.length ? [shops[0]] : ["GENERAL_SHOP"],
    }).returning();
    await tx.insert(schema.promotionItems).values(order.map((productId, i) => ({ promotionId: p.id, productId, position: i })));
    await audit(tx, { entity: "promotion", entityId: p.id, action: "create", after: { ...strip(p), items: order }, userId });
    return p.id;
  });
}

export async function updatePromotionBasics(id: string, input: { title: string; discountBp: number; places: string[] }, userId: string) {
  if (!(input.discountBp >= 100 && input.discountBp <= 9000 && input.discountBp % 100 === 0)) throw new PromoError("percent");
  const places = PROMO_PLACES.filter((x) => input.places.includes(x));
  if (!places.length) throw new PromoError("noPlaces");
  return change(id, userId, "update", async (_tx, p) => {
    // anderer Rabatt → Bild zeigt eine andere Zahl → neu zeichnen (macht die Seite, siehe actions)
    const shops = (p.bannerShops as string[]).filter((s) => (places as string[]).includes(s));
    return { title: input.title.trim().slice(0, 120), discountBp: input.discountBp, places, bannerShops: shops.length ? shops : p.bannerShops };
  });
}

export async function setPromotionProducts(id: string, productIds: string[], userId: string) {
  const ids = [...new Set(productIds)];
  if (!ids.length) throw new PromoError("noItems");
  if (ids.length > MAX_ITEMS) throw new PromoError("tooMany");
  return change(id, userId, "products", async (tx) => {
    const found = new Set((await tx.select({ id: schema.products.id }).from(schema.products).where(inArray(schema.products.id, ids))).map((r) => r.id));
    const order = ids.filter((x) => found.has(x));
    if (!order.length) throw new PromoError("noItems");
    await tx.delete(schema.promotionItems).where(eq(schema.promotionItems.promotionId, id));
    await tx.insert(schema.promotionItems).values(order.map((productId, i) => ({ promotionId: id, productId, position: i })));
  });
}

/** Rabatt an/aus + Zeitraum. Einschalten ohne Ende/Start = ab sofort bis zum Ausschalten. */
export async function setPriceWindow(id: string, w: { on: boolean; from: string | null; until: string | null }, userId: string) {
  checkWindow(w.from, w.until);
  return change(id, userId, w.on ? "price_on" : "price_off", async (_tx, p) => ({
    priceOn: w.on, priceFrom: w.from, priceUntil: w.until, ...(w.on ? { endedAt: null } : {}),
    ...(w.on && p.endedAt ? { bannerOn: false } : {}),
  }));
}

/** Werbebild an/aus + Zeitraum + Shops + Platz (über/unter dem Hero) */
export async function setBannerWindow(id: string, w: { on: boolean; from: string | null; until: string | null; shops: string[]; place: "top" | "below" }, userId: string) {
  checkWindow(w.from, w.until);
  const shops = PROMO_SHOPS.filter((s) => w.shops.includes(s));
  if (w.on && !shops.length) throw new PromoError("noShops");
  return change(id, userId, w.on ? "banner_on" : "banner_off", async (_tx, p) => {
    if (w.on && !Object.keys(p.bannerFiles ?? {}).length) throw new PromoError("noBanner");
    return {
      bannerOn: w.on, bannerFrom: w.from, bannerUntil: w.until, bannerShops: shops.length ? shops : p.bannerShops, bannerPlace: w.place,
      ...(w.on ? { endedAt: null, ...(!p.bannerOn || p.bannerPlace !== w.place ? { bannerStartedAt: new Date() } : {}) } : {}),
      ...(w.on && p.endedAt ? { priceOn: false } : {}),
    };
  });
}

/** Aktion beenden: Rabatt und Bild sofort aus (Preise zurück, Bild weg); bleibt in der Liste und kann neu gestartet werden */
export async function endPromotion(id: string, userId: string) {
  return change(id, userId, "end", async () => ({ priceOn: false, bannerOn: false, endedAt: new Date() }));
}

/** Löschen nur, wenn beendet bzw. nie gestartet und im Shop nichts mehr davon steht */
async function deletable(ex: Exec, p: typeof schema.promotions.$inferSelect): Promise<boolean> {
  if (p.priceOn || p.bannerOn || p.priceLive) return false;
  const shown = (await ex.execute<{ n: number }>(sql`select count(*)::int as n from shops where promo_banner like ${`%"id":"${p.id}"%`}`)).rows[0];
  return Number(shown?.n ?? 0) === 0;
}
export async function promoDeletable(id: string): Promise<boolean> {
  const p = await db.query.promotions.findFirst({ where: eq(schema.promotions.id, id) });
  return !!p && (await deletable(db, p));
}

export async function deletePromotion(id: string, userId: string) {
  await db.transaction(async (tx) => {
    const p = await lockPromo(tx, id);
    if (!(await deletable(tx, p))) throw new PromoError("notEnded");
    const items = await itemIds(tx, id);
    const files = Object.values(p.bannerFiles ?? {});
    await tx.delete(schema.promotions).where(eq(schema.promotions.id, id));
    if (files.length) await tx.delete(schema.storedFiles).where(inArray(schema.storedFiles.id, files));
    await audit(tx, { entity: "promotion", entityId: id, action: "delete", before: { ...strip(p), items }, userId });
  });
}

/** Worker: Rabatt hat sein Datum erreicht (startet/endet) → Artikel für die Shops vormerken */
export async function syncPromoPriceStates(): Promise<number> {
  const d = today();
  const all = await db.select().from(schema.promotions).where(sql`${schema.promotions.priceLive} or ${schema.promotions.priceOn}`);
  let n = 0;
  for (const p of all) {
    const live = priceActiveNow(p, d);
    if (live === p.priceLive) continue;
    await db.transaction(async (tx) => {
      if (shopsActive(p)) await markPromoDirty(await itemIds(tx, p.id), tx);
      await tx.update(schema.promotions).set({ priceLive: live }).where(eq(schema.promotions.id, p.id));
      await audit(tx, { entity: "promotion", entityId: p.id, action: live ? "price_started" : "price_ended", after: { date: d } });
    });
    n++;
  }
  return n;
}

// ───────────────────────── Lesen ─────────────────────────

export type PromoState = { price: PhaseState; banner: PhaseState };
export const promoState = (p: Pick<typeof schema.promotions.$inferSelect, "priceOn" | "priceFrom" | "priceUntil" | "bannerOn" | "bannerFrom" | "bannerUntil" | "endedAt">, d = today()): PromoState => ({
  price: phaseState({ on: p.priceOn, from: p.priceFrom, until: p.priceUntil }, d, !!p.endedAt),
  banner: phaseState({ on: p.bannerOn, from: p.bannerFrom, until: p.bannerUntil }, d, !!p.endedAt),
});

export type PromoListItem = {
  id: string; number: number; title: string; discountBp: number; places: string[]; items: number; state: PromoState;
  priceFrom: string | null; priceUntil: string | null; bannerFrom: string | null; bannerUntil: string | null; bannerShops: string[];
  bannerPlace: "top" | "below"; ended: boolean; thumb: string | null; names: string[]; createdAt: string;
};

export async function listPromotions(): Promise<PromoListItem[]> {
  const rows = await db.select().from(schema.promotions).orderBy(desc(schema.promotions.createdAt));
  if (!rows.length) return [];
  const items = (await db.execute<{ promotion_id: string; n: number; names: string[] }>(sql`
    select i.promotion_id, count(*)::int as n, (array_agg(p.name_de order by i.position))[1:3] as names
    from promotion_items i join products p on p.id = i.product_id group by i.promotion_id`)).rows;
  const by = new Map(items.map((r) => [String(r.promotion_id), r]));
  const d = today();
  return rows.map((p) => ({
    id: p.id, number: p.number, title: p.title, discountBp: p.discountBp, places: p.places, items: Number(by.get(p.id)?.n ?? 0),
    state: promoState(p, d), priceFrom: p.priceFrom, priceUntil: p.priceUntil, bannerFrom: p.bannerFrom, bannerUntil: p.bannerUntil,
    bannerShops: p.bannerShops, bannerPlace: p.bannerPlace, ended: !!p.endedAt, thumb: p.bannerFiles?.["wide-de"] ?? null,
    names: (by.get(p.id)?.names ?? []).map(String), createdAt: p.createdAt.toISOString(),
  }));
}

export type PromoItem = {
  productId: string; name: string; category: string; imageId: string | null; sku: string; variants: number;
  retailCents: number; wholesaleCents: number; costCents: number; vatRateBp: number; inShops: string[];
  /** höherer Rabatt einer anderen laufenden Aktion auf diesem Artikel (dann gilt der) */
  otherBp: number;
};
export type PromoDetail = typeof schema.promotions.$inferSelect & {
  state: PromoState; items: PromoItem[]; shops: (typeof schema.promotionShops.$inferSelect)[];
  /** steht das Bild gerade in diesem Shop (Metafeld geschrieben)? */
  shown: Record<string, "top" | "below" | null>;
};

export async function promotionDetail(id: string): Promise<PromoDetail | null> {
  const p = await db.query.promotions.findFirst({ where: eq(schema.promotions.id, id) });
  if (!p) return null;
  const d = today();
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select pr.id, pr.name_de, pr.category, pr.sku, pr.image_file_id, pr.vat_rate_bp,
      min(coalesce(nullif(v.retail_price_cents, 0), pr.retail_price_cents)) as retail,
      min(coalesce(nullif(v.wholesale_price_cents, 0), pr.wholesale_price_cents)) as wholesale,
      greatest(max(nullif(v.avg_cost_cents, 0)), pr.purchase_price_cents, 0) as cost,
      count(v.id)::int as variants,
      array_remove(array_agg(distinct sv.channel::text), null) as in_shops,
      coalesce((select max(o.discount_bp) from promotion_items oi join promotions o on o.id = oi.promotion_id
        where oi.product_id = pr.id and o.id <> ${id} and o.ended_at is null and o.price_on
          and (o.price_from is null or o.price_from <= ${d}::date) and (o.price_until is null or o.price_until >= ${d}::date)), 0) as other
    from promotion_items i join products pr on pr.id = i.product_id
      left join variants v on v.product_id = pr.id and v.active
      left join shop_variants sv on sv.variant_id = v.id
    where i.promotion_id = ${id}
    group by pr.id, i.position order by i.position`)).rows;
  const shops = await db.select().from(schema.promotionShops).where(eq(schema.promotionShops.promotionId, id)).orderBy(asc(schema.promotionShops.channel));
  const shopRows = (await db.execute<{ channel: string; promo_banner: string }>(sql`select channel::text, promo_banner from shops`)).rows;
  const shown: Record<string, "top" | "below" | null> = {};
  for (const s of shopRows) {
    let at: "top" | "below" | null = null;
    try {
      const j = JSON.parse(s.promo_banner || "{}") as { top?: { id?: string } | null; below?: { id?: string } | null };
      at = j.top?.id === id ? "top" : j.below?.id === id ? "below" : null;
    } catch { /* noch nie geschrieben */ }
    shown[String(s.channel)] = at;
  }
  return {
    ...p, state: promoState(p, d), shops, shown,
    items: rows.map((x) => ({
      productId: String(x.id), name: String(x.name_de), category: String(x.category ?? ""), imageId: (x.image_file_id as string) ?? null, sku: String(x.sku),
      variants: Number(x.variants), retailCents: Number(x.retail ?? 0), wholesaleCents: Number(x.wholesale ?? 0), costCents: Number(x.cost ?? 0),
      vatRateBp: Number(x.vat_rate_bp), inShops: ((x.in_shops as string[]) ?? []).map(String), otherBp: Number(x.other ?? 0),
    })),
  };
}

/** Startseite: laufende bzw. geplante Aktionen (Rabatt oder Bild) */
export async function runningPromotions() {
  const rows = await db.select().from(schema.promotions)
    .where(and(isNull(schema.promotions.endedAt), sql`(${schema.promotions.priceOn} or ${schema.promotions.bannerOn})`))
    .orderBy(desc(schema.promotions.updatedAt));
  const d = today();
  const counts = rows.length ? (await db.execute<{ promotion_id: string; n: number }>(sql`select promotion_id, count(*)::int as n from promotion_items
    where promotion_id in (${sql.join(rows.map((r) => sql`${r.id}`), sql`, `)}) group by promotion_id`)).rows : [];
  return rows.map((p) => ({ id: p.id, number: p.number, title: p.title, discountBp: p.discountBp, state: promoState(p, d), priceUntil: p.priceUntil, priceFrom: p.priceFrom,
    items: Number(counts.find((c) => String(c.promotion_id) === p.id)?.n ?? 0) }))
    .filter((p) => p.state.price === "active" || p.state.banner === "active" || p.state.price === "scheduled" || p.state.banner === "scheduled");
}

/** Artikel, die gerade in einer Aktion im System rabattiert sind (Artikelliste, Artikelseite, Scanner) */
export const systemDiscounts = (productIds?: string[]) => activeDiscounts("SYSTEM", productIds);
