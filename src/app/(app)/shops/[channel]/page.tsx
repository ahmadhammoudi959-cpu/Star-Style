import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { EventList } from "../EventList";
import { ShopControls, ShopForm } from "./ShopSetup";

export const dynamic = "force-dynamic";

export default async function ShopPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (channel !== "BRAND_SHOP" && channel !== "GENERAL_SHOP") notFound();
  const { t } = await getI18n();
  const [s, events] = await Promise.all([
    db.query.shops.findFirst({ where: eq(schema.shops.channel, channel) }),
    db.select().from(schema.shopEvents).where(and(eq(schema.shopEvents.channel, channel))).orderBy(desc(schema.shopEvents.createdAt)).limit(50),
  ]);
  const data = {
    channel, domain: s?.domain ?? "", clientId: s?.clientId ?? "", hasSecret: Boolean(s?.clientSecretEnc), legacy: Boolean(s?.staticTokenEnc),
    stockBuffer: s?.stockBuffer ?? 0, importTestOrders: s?.importTestOrders ?? false, locationId: s?.locationId ?? "", locationName: s?.locationName ?? "",
    active: s?.active ?? false, webhooksAt: s?.webhooksAt?.toISOString() ?? null,
  };
  return (
    <div className="space-y-6">
      <PageHeader title={t.shop.names[channel]} subtitle={data.domain || t.shop.notConnected} back="/shops" />
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
