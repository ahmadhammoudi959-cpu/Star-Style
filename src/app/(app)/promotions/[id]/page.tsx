import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { getI18n, fill } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { can, requirePerm } from "@/lib/auth";
import { db } from "@/db";
import { promotionDetail } from "@/lib/promotions";
import { jobRunning } from "@/lib/promo-banner-job";
import { saleOptions } from "@/lib/sales-queries";
import { PHASE_TONE, phaseLabel } from "../labels";
import { PromoDetail, type PromoView } from "./PromoDetail";

export const dynamic = "force-dynamic";

/** Seite einer Aktion: Werbebild, Rabatt (an/aus + Datum), Bild im Shop (an/aus + Shop + Platz + Datum), Artikel, beenden/löschen */
export default async function PromotionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePerm("promotions");
  const { id } = await params;
  const { t, intl, locale } = await getI18n();
  const T = t.promo;
  const p = await promotionDetail(id);
  if (!p) notFound();
  const [options, shopRows, dirty] = await Promise.all([
    saleOptions(),
    db.execute<{ channel: string; ok: boolean }>(sql`select channel::text, (domain <> '' and (client_secret_enc <> '' or static_token_enc <> '')) as ok from shops`),
    db.execute<{ n: number }>(sql`select count(*)::int as n from shop_price_dirty d join promotion_items i on i.product_id = d.product_id where i.promotion_id = ${id}`),
  ]);
  const name = p.title || fill(T.name, { n: p.number });
  const view: PromoView = {
    id: p.id, number: p.number, title: p.title, discountBp: p.discountBp, places: p.places,
    priceOn: p.priceOn, priceFrom: p.priceFrom, priceUntil: p.priceUntil,
    bannerOn: p.bannerOn, bannerFrom: p.bannerFrom, bannerUntil: p.bannerUntil, bannerShops: p.bannerShops, bannerPlace: p.bannerPlace,
    ended: p.endedAt ? p.endedAt.toISOString() : null,
    items: p.items,
    configuredShops: shopRows.rows.filter((r) => r.ok).map((r) => String(r.channel)),
    live: {
      job: jobRunning(p) ? "running" : p.bannerJob === "running" ? "failed" : p.bannerJob, error: p.bannerError, version: p.bannerVersion,
      files: p.bannerFiles, copy: p.bannerCopy, state: p.state, dirty: Number(dirty.rows[0]?.n ?? 0), shown: p.shown,
      shops: p.shops.map((s) => ({ channel: s.channel, error: s.error, uploaded: s.bannerVersion === p.bannerVersion && Object.keys(s.media).length > 0 })),
    },
  };
  const ended = !!p.endedAt;
  return (
    <div className="space-y-6">
      <PageHeader title={name} back="/promotions"
        subtitle={`${fill(T.items, { n: p.items.length })} · ${p.places.map((x) => T.placesShort[x as keyof typeof T.placesShort] ?? x).join(" · ")}`}
        actions={<>
          <span className="num badge bg-accent-600 px-3 py-1 text-base font-black text-white" dir="ltr">−{Math.round(p.discountBp / 100)}%</span>
          {ended ? <span className={`badge ${PHASE_TONE.off}`}>{T.state.ended}</span> : <>
            <span className={`badge ${PHASE_TONE[p.state.price]}`}>{T.price}: {phaseLabel(T, p.state.price, { from: p.priceFrom, until: p.priceUntil }, intl)}</span>
            <span className={`badge ${PHASE_TONE[p.state.banner]}`}>{T.banner}: {phaseLabel(T, p.state.banner, { from: p.bannerFrom, until: p.bannerUntil }, intl)}</span>
          </>}
        </>} />
      <PromoDetail t={t} view={view} options={options} intl={intl} uiLang={locale} canCost={can(session, "products.cost")} />
    </div>
  );
}
