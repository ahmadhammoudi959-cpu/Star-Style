import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { saleOptions } from "@/lib/sales-queries";
import { MappingRow } from "./MappingRow";

export const dynamic = "force-dynamic";

export default async function MappingPage({ params, searchParams }: { params: Promise<{ channel: string }>; searchParams: Promise<{ f?: string }> }) {
  const { channel } = await params;
  if (channel !== "BRAND_SHOP" && channel !== "GENERAL_SHOP") notFound();
  const { f = "open" } = await searchParams;
  const { t } = await getI18n();
  const where = f === "all" ? eq(schema.shopVariants.channel, channel)
    : f === "errors" ? and(eq(schema.shopVariants.channel, channel), ne(schema.shopVariants.pushError, ""))
    : and(eq(schema.shopVariants.channel, channel), isNull(schema.shopVariants.variantId), eq(schema.shopVariants.tracked, true));
  const [rows, options] = await Promise.all([
    db.query.shopVariants.findMany({ where, orderBy: [asc(schema.shopVariants.title)], limit: 500 }),
    saleOptions(),
  ]);
  const names = new Map(options.map((o) => [o.id, `${o.nameDe}${[o.size, o.color].filter(Boolean).length ? ` (${[o.size, o.color].filter(Boolean).join(" · ")})` : ""} · ${o.sku}`]));
  return (
    <div className="space-y-5">
      <PageHeader title={t.shop.mapping} subtitle={t.shop.names[channel]} back={`/shops/${channel}`} />
      <div className="inline-flex rounded-xl bg-white p-1 shadow-card ring-1 ring-black/5 animate-rise">
        {(["open", "all", "errors"] as const).map((k) => (
          <Link key={k} href={`?f=${k}`} className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${f === k ? "bg-brand-600 text-white shadow-card" : "text-ink-soft hover:text-ink"}`}>{t.shop.filter[k]}</Link>
        ))}
      </div>
      <div className="card animate-rise overflow-visible">
        {rows.length === 0 ? <p className="p-8 text-center text-ink-soft">{f === "open" ? "✓" : t.shop.noVariants}</p> : (
          <table className="tbl">
            <thead><tr><th>{t.shop.shopVariant}</th><th>{t.shop.ours}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <MappingRow key={r.id} t={t} channel={channel} options={options}
                row={{ id: r.id, title: r.title, sku: r.sku, barcode: r.barcode, tracked: r.tracked, variantId: r.variantId, ourName: r.variantId ? names.get(r.variantId) ?? "?" : "", matchedBy: r.matchedBy, pushError: r.pushError, lastPushedQty: r.lastPushedQty }} />
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
