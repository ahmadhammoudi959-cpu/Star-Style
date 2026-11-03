import { notFound } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { EventList } from "../EventList";
import { ShopControls, ShopForm } from "./ShopSetup";
import { CategoryMap, PendingProducts } from "./PendingProducts";
import { bulkPushStatus, getStoreTypes, pendingProducts, type StoreType } from "@/lib/shopify/product-push";
import { resolveStoreType } from "@/lib/shopify/product-push-map";

export const dynamic = "force-dynamic";

export default async function ShopPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (channel !== "BRAND_SHOP" && channel !== "GENERAL_SHOP") notFound();
  const { t } = await getI18n();
  const [s, events] = await Promise.all([
    db.query.shops.findFirst({ where: eq(schema.shops.channel, channel) }),
    db.select().from(schema.shopEvents).where(and(eq(schema.shopEvents.channel, channel))).orderBy(desc(schema.shopEvents.createdAt)).limit(50),
  ]);
  // „Noch nicht im Shop“ und Kategorien nur für eingerichtete Shops; Kategorien höchstens stündlich frisch, nie länger als 3 s warten
  const ready = Boolean(s?.domain && (s.clientSecretEnc || s.staticTokenEnc));
  let types: StoreType[] = [];
  let pending: Awaited<ReturnType<typeof pendingProducts>> = [];
  let catRows: { category: string; n: number; auto: string | null; mapped: string | null }[] = [];
  if (s && ready) {
    types = await Promise.race([getStoreTypes(s, 3600_000), new Promise<StoreType[]>((r) => setTimeout(() => r(s.storeTypes ?? []), 3000))]);
    pending = await pendingProducts(channel, { ...s, storeTypes: types });
    const flag = channel === "BRAND_SHOP" ? sql`in_brand_shop` : sql`in_general_shop`;
    const cats = await db.execute<{ category: string; n: number }>(sql`
      select category, count(*)::int as n from products where active and ${flag} and category <> '' group by category order by category`);
    catRows = cats.rows.map((r) => ({ category: r.category, n: Number(r.n), auto: types.length ? resolveStoreType(r.category, types, {}) : null, mapped: s.categoryMap?.[r.category] ?? null }));
  }
  const data = {
    channel, domain: s?.domain ?? "", clientId: s?.clientId ?? "", hasSecret: Boolean(s?.clientSecretEnc), legacy: Boolean(s?.staticTokenEnc),
    stockBuffer: s?.stockBuffer ?? 0, importTestOrders: s?.importTestOrders ?? false, locationId: s?.locationId ?? "", locationName: s?.locationName ?? "",
    active: s?.active ?? false, webhooksAt: s?.webhooksAt?.toISOString() ?? null,
  };
  return (
    <div className="space-y-6">
      <PageHeader title={t.shop.names[channel]} subtitle={data.domain || t.shop.notConnected} back="/shops" />
      {ready && <PendingProducts t={t} channel={channel} items={pending} types={types} initialBulk={bulkPushStatus(channel)} />}
      {ready && <CategoryMap t={t} channel={channel} rows={catRows} types={types} />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <ShopForm t={t} s={data} />
          <section className="card animate-rise p-5">
            <h2 className="mb-3 font-bold">{t.shop.guideTitle}</h2>
            <ol className="space-y-2 text-sm">
              {t.shop.guide.map((g, i) => (
                <li key={i} className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-800">{i + 1}</span><span className="leading-relaxed">{g}</span></li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="space-y-6"><ShopControls t={t} s={data} /></aside>
      </div>
      <section className="card animate-rise p-5"><h2 className="mb-2 font-bold">{t.shop.events}</h2><EventList t={t} events={events} /></section>
    </div>
  );
}
