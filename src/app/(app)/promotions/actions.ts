"use server";
/**
 * Aktionen (Wunsch Inhaber 19.11.2026). Ohne revalidatePath – die Seite übernimmt den Stand selbst bzw. lädt neu
 * (siehe „Hängender Übergang nach Server-Action“ in CLAUDE.md). Nach jeder Änderung gehen Preise und Bild sofort an die
 * Shops (im Hintergrund); der Worker holt alle 5 min nach, was dabei nicht geklappt hat.
 */
import { requirePerm } from "@/lib/auth";
import {
  createPromotion, deletePromotion, endPromotion, promoDeletable, PromoError, setBannerWindow, setPriceWindow, setPromotionProducts, updatePromotionBasics,
} from "@/lib/promotions";
import { startBannerJob } from "@/lib/promo-banner-job";
import { percentToBp } from "@/lib/promo-rules";
import { pushDirtyPrices } from "@/lib/shopify/prices";
import { deletePromoMedia, syncPromoShops } from "@/lib/shopify/promo-shop";
import { COPY_LANGS, cut, COPY_LIMITS } from "@/lib/ai/promo-copy";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export type PromoResult = { ok?: boolean; id?: string; error?: string };

const fail = (e: unknown): PromoResult => {
  if (e instanceof PromoError) return { error: e.code };
  console.error("promotions", e);
  return { error: "error" };
};
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const date = (v: unknown) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const list = (v: unknown, max = 400) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => x.slice(0, 100)) : []);

/** Preise + Bild sofort an die Shops (Hintergrund) */
function kickShops() {
  void (async () => {
    await pushDirtyPrices().catch((e) => console.error("promo prices", e));
    await syncPromoShops().catch((e) => console.error("promo shops", e));
  })();
}

export async function createPromotionAction(input: { title: string; percent: string; places: string[]; productIds: string[] }): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  const bp = percentToBp(str(input.percent, 10));
  if (bp == null) return { error: "percent" };
  try {
    const id = await createPromotion({ title: str(input.title, 120), discountBp: bp, places: list(input.places, 4), productIds: list(input.productIds) }, s.uid);
    await startBannerJob(id, s.uid); // Werbebild gleich erstellen (KI schreibt den Text)
    return { ok: true, id };
  } catch (e) { return fail(e); }
}

export async function updateBasicsAction(id: string, input: { title: string; percent: string; places: string[] }): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  const bp = percentToBp(str(input.percent, 10));
  if (bp == null) return { error: "percent" };
  try {
    const before = await db.query.promotions.findFirst({ where: eq(schema.promotions.id, str(id)) });
    const p = await updatePromotionBasics(str(id), { title: str(input.title, 120), discountBp: bp, places: list(input.places, 4) }, s.uid);
    // andere Zahl → Bild neu zeichnen (gleicher Text, gleiche Farbe)
    if (before && before.discountBp !== p.discountBp && Object.keys(p.bannerFiles ?? {}).length) await startBannerJob(p.id, s.uid, { copy: p.bannerCopy });
    kickShops();
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function setProductsAction(id: string, productIds: string[]): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  try {
    const p = await setPromotionProducts(str(id), list(productIds), s.uid);
    // andere Artikel → neue Kurznamen und Fotos im Bild (KI schreibt neu, Farbe bleibt)
    if (Object.keys(p.bannerFiles ?? {}).length) await startBannerJob(p.id, s.uid, { keepStyle: true });
    kickShops();
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function priceAction(id: string, input: { on: boolean; from: string; until: string }): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  try {
    const before = await db.query.promotions.findFirst({ where: eq(schema.promotions.id, str(id)) });
    const p = await setPriceWindow(str(id), { on: !!input.on, from: date(input.from), until: date(input.until) }, s.uid);
    // „Nur bis …“ steht im Bild → bei anderem Ende neu zeichnen
    const shownUntil = (x: typeof p | undefined) => (x?.priceOn && x.priceUntil ? x.priceUntil : null);
    if (Object.keys(p.bannerFiles ?? {}).length && shownUntil(before) !== shownUntil(p)) await startBannerJob(p.id, s.uid, { copy: p.bannerCopy });
    kickShops();
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function bannerAction(id: string, input: { on: boolean; from: string; until: string; shops: string[]; place: string }): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  try {
    await setBannerWindow(str(id), { on: !!input.on, from: date(input.from), until: date(input.until), shops: list(input.shops, 2), place: input.place === "below" ? "below" : "top" }, s.uid);
    kickShops();
    return { ok: true };
  } catch (e) { return fail(e); }
}

/** Neues Bild: andere Farbe + neuer Text von der KI */
export async function regenerateAction(id: string): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  const r = await startBannerJob(str(id), s.uid, { restyle: true });
  return r === "started" ? { ok: true } : { error: r === "running" ? "running" : "notFound" };
}

/** Text von Hand geändert → mit diesem Text neu zeichnen */
export async function textAction(id: string, copy: Record<string, { headline: string; sub: string; names: string[] }>): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  const clean: Record<string, { headline: string; sub: string; names: string[] }> = {};
  for (const l of COPY_LANGS) {
    const c = copy?.[l];
    const ar = l === "ar";
    clean[l] = {
      headline: cut(str(c?.headline, 200), ar ? COPY_LIMITS.headlineAr : COPY_LIMITS.headline),
      sub: cut(str(c?.sub, 200), ar ? COPY_LIMITS.subAr : COPY_LIMITS.sub),
      names: list(c?.names, 4).map((n) => cut(n, COPY_LIMITS.name)),
    };
  }
  const r = await startBannerJob(str(id), s.uid, { copy: clean });
  return r === "started" ? { ok: true } : { error: r === "running" ? "running" : "notFound" };
}

export async function endAction(id: string): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  try { await endPromotion(str(id), s.uid); kickShops(); return { ok: true }; } catch (e) { return fail(e); }
}

export async function deleteAction(id: string): Promise<PromoResult> {
  const s = await requirePerm("promotions");
  try {
    if (!(await promoDeletable(str(id)))) return { error: "notEnded" };
    await deletePromoMedia(str(id)).catch((e) => console.error("promo media", e)); // Bilder in Shopify Files (stehen nirgends mehr)
    await deletePromotion(str(id), s.uid);
    return { ok: true };
  } catch (e) { return fail(e); }
}
