import Link from "next/link";
import { desc, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { EventList } from "./EventList";

export const dynamic = "force-dynamic";
const CHANNELS = ["BRAND_SHOP", "GENERAL_SHOP"] as const;

export default async function ShopsPage() {
  const { t } = await getI18n();
  const [shops, counts, events] = await Promise.all([
    db.select().from(schema.shops),
    db.execute<{ channel: string; matched: number; open: number }>(sql`select channel::text, count(*) filter (where variant_id is not null)::int as matched, count(*) filter (where variant_id is null and tracked)::int as open from shop_variants group by channel`),
    db.select().from(schema.shopEvents).orderBy(desc(schema.shopEvents.createdAt)).limit(30),
  ]);
  const when = (d: Date | null) => (d ? new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" }).format(d) : t.shop.never);
  return (
    <div className="space-y-6">
      <PageHeader title={t.shop.title} subtitle={t.shop.subtitle} />
      <div className="stagger grid gap-5 lg:grid-cols-2">
        {CHANNELS.map((ch) => {
          const s = shops.find((x) => x.channel === ch);
          const c = counts.rows.find((x) => x.channel === ch);
          const status = !s?.domain ? "none" : s.active ? "on" : "off";
          return (
            <section key={ch} className="card animate-rise p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className={`grid h-12 w-12 place-items-center rounded-xl ${status === "on" ? "bg-brand-600 text-white" : "bg-slate-100 text-ink-soft"}`}><Icon name="globe" className="h-6 w-6" /></span>
                  <div><h2 className="text-lg font-bold">{t.shop.names[ch]}</h2><div className="text-sm text-ink-soft" dir="ltr">{s?.domain || "—"}</div></div>
                </div>
                <span className={`badge ${status === "on" ? "bg-brand-100 text-brand-800" : status === "off" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600"}`}>
                  {status === "on" ? t.shop.active : status === "off" ? t.shop.paused : t.shop.notConnected}
                </span>
              </div>
              {s?.domain && (
                <dl className="mb-4 grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-slate-50 p-2"><dt className="text-xs text-ink-soft">{t.shop.lastOrders}</dt><dd className="num font-semibold">{when(s.lastOrderSync)}</dd></div>
                  <div className="rounded-lg bg-slate-50 p-2"><dt className="text-xs text-ink-soft">{t.shop.lastStock}</dt><dd className="num font-semibold">{when(s.lastStockSync)}</dd></div>
                  <div className="rounded-lg bg-slate-50 p-2"><dt className="text-xs text-ink-soft">{t.shop.mapped}</dt><dd className="num font-semibold text-brand-700">{c?.matched ?? 0}</dd></div>
                  <div className="rounded-lg bg-slate-50 p-2"><dt className="text-xs text-ink-soft">{t.shop.unmapped}</dt><dd className={`num font-semibold ${c?.open ? "text-amber-700" : ""}`}>{c?.open ?? 0}</dd></div>
                </dl>
              )}
              {s?.lastError && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" dir="ltr">{s.lastError}</p>}
              <div className="flex flex-wrap gap-2">
                <Link href={`/shops/${ch}`} className="btn-primary group"><Icon name="settings" className="h-4 w-4" />{s?.domain ? t.shop.settings : t.shop.setup}</Link>
                {s?.domain && <Link href={`/shops/${ch}/mapping`} className="btn-ghost group"><Icon name="layers" className="h-4 w-4" />{t.shop.mapping}</Link>}
              </div>
            </section>
          );
        })}
      </div>
      <section className="card animate-rise p-5">
        <h2 className="mb-2 font-bold">{t.shop.events}</h2>
        <EventList t={t} events={events} showShop />
      </section>
    </div>
  );
}
