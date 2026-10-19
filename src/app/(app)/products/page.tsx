import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { formatCents } from "@/lib/money";

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const { t, intl } = await getI18n();
  const like = q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select p.id, p.image_file_id, p.sku, p.name_de, p.name_nl, p.category, p.wholesale_price_cents, p.retail_price_cents, p.active,
           count(v.id) filter (where v.active)::int as variants,
           coalesce(sum(v.stock_qty) filter (where v.active),0)::int as stock,
           bool_or(v.active and v.min_stock > 0 and v.stock_qty <= v.min_stock) as low
    from products p left join variants v on v.product_id = p.id
    where (${like}::text is null or lower(p.name_de) like ${like} or lower(p.name_nl) like ${like} or lower(p.sku) like ${like}
           or exists (select 1 from variants vb where vb.product_id = p.id and vb.barcode like ${like}))
    group by p.id order by p.active desc, p.name_de`)).rows;

  return (
    <div>
      <PageHeader title={t.product.title} actions={<Link href="/products/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.product.new}</Link>} />
      <form className="mb-4 animate-rise">
        <label className="relative block max-w-md">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input name="q" defaultValue={q} placeholder={t.common.search} className="input ps-9" />
        </label>
      </form>
      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-ink-soft">{t.product.empty}</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr>
                <th>{t.product.sku}</th><th>{t.product.nameDe}</th><th className="hidden md:table-cell">{t.product.nameNl}</th>
                <th className="hidden md:table-cell">{t.product.category}</th><th className="text-end">{t.product.wholesale}</th>
                <th className="text-end">{t.product.stock}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r.id)} className={r.active ? "" : "opacity-50"}>
                    <td className="num text-ink-soft" dir="ltr">{String(r.sku)}</td>
                    <td><div className="flex items-center gap-3">
                      <Thumb id={r.image_file_id as string | null} size={44} />
                      <div><Link href={`/products/${r.id}`} className="font-semibold hover:text-brand-700">{String(r.name_de)}</Link>
                      {Number(r.variants) > 1 && <span className="badge ms-2 bg-brand-50 text-brand-700">{Number(r.variants)} {t.product.variants}</span>}
                    </div></div></td>
                    <td className="hidden text-ink-soft md:table-cell">{String(r.name_nl)}</td>
                    <td className="hidden text-ink-soft md:table-cell">{String(r.category)}</td>
                    <td className="num text-end">{formatCents(Number(r.wholesale_price_cents), intl)}</td>
                    <td className="num text-end font-semibold">
                      <span className={r.low ? "text-amber-600" : ""}>{Number(r.stock)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
