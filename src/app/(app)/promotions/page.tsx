import Link from "next/link";
import { getI18n, fill } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { OpenButton } from "@/components/OpenButton";
import { Icon } from "@/components/Icon";
import { requirePerm } from "@/lib/auth";
import { listPromotions } from "@/lib/promotions";
import { PHASE_TONE, phaseLabel } from "./labels";

export const dynamic = "force-dynamic";

/** Aktionen (Wunsch Inhaber 19.11.2026: „قسم العروض“): Liste mit Bild, Rabatt, Stand von Rabatt und Bild */
export default async function PromotionsPage() {
  await requirePerm("promotions");
  const { t, intl } = await getI18n();
  const T = t.promo;
  const rows = await listPromotions();

  return (
    <div className="space-y-6">
      <PageHeader title={T.title} subtitle={T.subtitle}
        actions={<Link href="/promotions/new" className="btn-primary group"><Icon name="plus" className="icon-pop h-4 w-4" />{T.new}</Link>} />
      {rows.length === 0 ? (
        <section className="card animate-rise p-8 text-center">
          <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-accent-50 text-accent-600"><Icon name="percent" className="icon-pop h-7 w-7" /></span>
          <p className="font-semibold">{T.empty}</p>
          <p className="mt-1 text-sm text-ink-soft">{T.emptyHint}</p>
          <Link href="/promotions/new" className="btn-primary group mt-4 inline-flex"><Icon name="plus" className="icon-pop h-4 w-4" />{T.new}</Link>
        </section>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((p) => {
            const name = p.title || fill(T.name, { n: p.number });
            const thumb = p.thumb ? p.thumb : null;
            return (
              <article key={p.id} data-promo-card className="card card-hover animate-rise flex flex-col overflow-hidden">
                <Link href={`/promotions/${p.id}`} className="relative block aspect-[3/1] bg-navy-900">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/files/${thumb}`} alt="" loading="lazy" className="h-full w-full object-cover" />
                  ) : (
                    <span className="grid h-full place-items-center text-white/60"><Icon name="image" className="h-8 w-8" /></span>
                  )}
                  <span className="num absolute start-3 top-3 rounded-full bg-accent-600 px-2.5 py-1 text-sm font-black text-white shadow-card" dir="ltr">−{Math.round(p.discountBp / 100)}%</span>
                </Link>
                <div className="flex flex-1 flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate font-bold" dir="auto">{name}</h2>
                      <p className="truncate text-xs text-ink-soft" dir="auto">{fill(T.items, { n: p.items })}{p.names.length ? ` · ${p.names.join(", ")}` : ""}</p>
                    </div>
                    <OpenButton href={`/promotions/${p.id}`} label={t.product.open} />
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    {p.ended ? <span className={`badge ${PHASE_TONE.off}`}>{T.state.ended}</span> : <>
                      <span className={`badge ${PHASE_TONE[p.state.price]}`}><Icon name="percent" className="h-3.5 w-3.5" />{T.price}: {phaseLabel(T, p.state.price, { from: p.priceFrom, until: p.priceUntil }, intl)}</span>
                      <span className={`badge ${PHASE_TONE[p.state.banner]}`}><Icon name="image" className="h-3.5 w-3.5" />{T.banner}: {phaseLabel(T, p.state.banner, { from: p.bannerFrom, until: p.bannerUntil }, intl)}</span>
                    </>}
                  </div>
                  <p className="mt-auto text-xs text-ink-soft">{p.places.map((x) => T.placesShort[x as keyof typeof T.placesShort] ?? x).join(" · ")}</p>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
