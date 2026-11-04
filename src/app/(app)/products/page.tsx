import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n, type Dict } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { formatCents } from "@/lib/money";
import { productCategories } from "@/lib/queries";
import { CategorySelect } from "@/components/CategorySelect";
import { OpenButton } from "@/components/OpenButton";
import { SearchPick } from "@/components/SearchPick";
import { pendingSummary } from "@/lib/shopify/product-push";
import { fill } from "@/i18n";

type Row = {
  id: string; imageFileId: string | null; sku: string; nameDe: string; nameNl: string; category: string;
  wholesaleCents: number; active: boolean; variants: number; stock: number; low: boolean; barcodes: string[];
};

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; cat?: string }> }) {
  const { q = "", cat = "" } = await searchParams;
  const { t, intl } = await getI18n();
  const like = q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const category = cat.trim() || null;
  const [cats, pend] = await Promise.all([productCategories(), pendingSummary()]);
  const rows: Row[] = (await db.execute<Record<string, unknown>>(sql`
    select p.id, p.image_file_id, p.sku, p.name_de, p.name_nl, p.category, p.wholesale_price_cents, p.active,
           count(v.id) filter (where v.active)::int as variants,
           coalesce(sum(v.stock_qty) filter (where v.active),0)::int as stock,
           bool_or(v.active and v.min_stock > 0 and v.stock_qty <= v.min_stock) as low,
           coalesce(array_agg(v.barcode order by v.created_at, v.id) filter (where v.active and v.barcode is not null and v.barcode <> ''), '{}') as barcodes
    from products p left join variants v on v.product_id = p.id
    where (${like}::text is null or lower(p.name_de) like ${like} or lower(p.name_nl) like ${like} or lower(p.sku) like ${like}
           or lower(p.category) like ${like}
           or exists (select 1 from variants vb where vb.product_id = p.id and vb.barcode like ${like}))
      and (${category}::text is null or p.category = ${category})
    group by p.id order by p.active desc, p.name_de`)).rows.map((r) => ({
    id: String(r.id), imageFileId: (r.image_file_id as string) ?? null, sku: String(r.sku), nameDe: String(r.name_de), nameNl: String(r.name_nl),
    category: String(r.category), wholesaleCents: Number(r.wholesale_price_cents), active: Boolean(r.active), variants: Number(r.variants),
    stock: Number(r.stock), low: Boolean(r.low), barcodes: (r.barcodes as string[] | null) ?? [],
  }));

  return (
    <div>
      <PageHeader title={t.product.title} actions={<Link href="/products/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.product.new}</Link>} />
      {pend.map((x) => (
        <Link key={x.channel} href={`/shops/${x.channel}#pending`} className="card card-hover group mb-3 flex animate-rise items-center gap-3 p-3 text-sm ring-1 ring-accent-500/20">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600"><Icon name="upload" className="icon-pop h-5 w-5" /></span>
          <span className="min-w-0 flex-1">{fill(t.home.pendingText, { shop: t.shop.names[x.channel], n: x.total, r: x.ready })}</span>
          <span className="hidden font-semibold text-brand-700 sm:inline">{t.home.pendingAction}</span>
          <Icon name="arrowRight" className="h-4 w-4 shrink-0 text-brand-700 rtl:rotate-180" />
        </Link>
      ))}
      <form className="relative z-10 mb-4 flex flex-col gap-3 animate-rise md:flex-row md:items-end">
        {cats.length > 0 && <CategorySelect categories={cats} label={t.picker.category} allLabel={t.picker.all} name="cat" defaultValue={cat} autoSubmit className="md:w-64" />}
        <div className="min-w-0 md:max-w-md md:flex-1">
          <SearchPick name="q" defaultValue={q} label={t.picker.searchLabel} placeholder={t.product.searchHint} emptyLabel={t.picker.empty}
            items={rows.map((r) => ({ label: r.nameDe, sub: [r.sku, r.category].filter(Boolean).join(" · "), href: `/products/${r.id}`, imageId: r.imageFileId,
              search: [r.nameDe, r.nameNl, r.sku, r.category, ...r.barcodes].join(" ").toLowerCase() }))} />
        </div>
      </form>
      {rows.length === 0 ? (
        <div className="card p-10 text-center text-ink-soft animate-rise">
          {q.trim() || category ? t.picker.empty : t.product.empty}
          {!q.trim() && !category && <Link href="/shops" className="mt-3 block font-semibold text-brand-700 hover:underline">{t.product.importLink}</Link>}
        </div>
      ) : (
        <>
          {/* PC/Laptop: alle Spalten ohne seitliches Scrollen */}
          <div className="card hidden overflow-hidden animate-rise lg:block">
            <div className="table-wrap">
            <table className="tbl tbl-fit">
              <thead><tr>
                <th className="w-[7rem]">{t.product.sku}</th>
                <th className="w-[7rem]">{t.product.barcode}</th>
                <th>{t.product.nameDe}</th>
                <th>{t.product.nameNl}</th>
                <th>{t.product.category}</th>
                <th className="w-[7.5rem] text-end">{t.product.wholesale}</th>
                <th className="w-px text-end">{t.product.stock}</th>
                <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.active ? "" : "opacity-50"}>
                    <td><Code value={r.sku} /></td>
                    <td><Barcodes list={r.barcodes} t={t} /></td>
                    <td>
                      <Link href={`/products/${r.id}`} className="group flex items-center gap-2.5">
                        <Thumb id={r.imageFileId} size={40} />
                        <span className="min-w-0">
                          <span className="font-semibold [overflow-wrap:anywhere] group-hover:text-brand-700">{r.nameDe}</span>
                          {r.variants > 1 && <span className="badge mt-0.5 flex w-fit bg-brand-50 text-brand-700">{r.variants} {t.product.variants}</span>}
                        </span>
                      </Link>
                    </td>
                    <td className="text-[0.8125rem] text-ink-soft [overflow-wrap:anywhere]" dir="auto">{r.nameNl || "—"}</td>
                    <td className="text-[0.8125rem] text-ink-soft [overflow-wrap:break-word]">{r.category || "—"}</td>
                    <td className="num text-end">{formatCents(r.wholesaleCents, intl)}</td>
                    <td className="num text-end font-semibold"><span className={r.low ? "text-amber-600" : ""}>{r.stock}</span></td>
                    <td className="text-end"><OpenButton href={`/products/${r.id}`} label={t.product.open} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          {/* Handy/Tablet: eine Karte pro Artikel, alle Angaben sichtbar */}
          <div className="space-y-2 lg:hidden">
            {rows.map((r) => (
              <div key={r.id} className={`card space-y-3 p-3 animate-rise ${r.active ? "" : "opacity-50"}`}>
                <div className="flex gap-3">
                  <Link href={`/products/${r.id}`} className="shrink-0"><Thumb id={r.imageFileId} size={56} /></Link>
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link href={`/products/${r.id}`} className="block font-semibold leading-snug [overflow-wrap:anywhere]">{r.nameDe}</Link>
                    {r.nameNl && <div className="text-xs text-ink-soft [overflow-wrap:anywhere]" dir="auto">{r.nameNl}</div>}
                    {r.variants > 1 && <span className="badge bg-brand-50 text-brand-700">{r.variants} {t.product.variants}</span>}
                  </div>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-xl bg-brand-50/40 p-2.5 text-xs ring-1 ring-black/5">
                  <Item label={t.product.sku}><Code value={r.sku} /></Item>
                  <Item label={t.product.barcode}><Barcodes list={r.barcodes} t={t} /></Item>
                  <Item label={t.product.category}><span className="[overflow-wrap:anywhere]">{r.category || "—"}</span></Item>
                  <Item label={t.product.wholesale}><span className="num">{formatCents(r.wholesaleCents, intl)}</span></Item>
                  <Item label={t.product.stock}><span className={`num font-semibold ${r.low ? "text-amber-600" : ""}`}>{r.stock}</span></Item>
                </dl>
                <OpenButton href={`/products/${r.id}`} label={t.product.open} className="w-full py-2.5 text-sm" />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Nummern immer links-nach-rechts; lange Nummern brechen um statt die Tabelle zu verbreitern */
function Code({ value }: { value: string }) {
  return <bdi dir="ltr" className="block text-xs tabular-nums text-ink-soft [overflow-wrap:anywhere]">{value}</bdi>;
}

/** Barcodes der Varianten: die ersten zwei, dazu „+n“ (alle im Tooltip) */
function Barcodes({ list, t }: { list: string[]; t: Dict }) {
  if (!list.length) return <span className="text-xs text-ink-soft">—</span>;
  const more = list.length - 2;
  return (
    <span className="block space-y-0.5" title={list.join("\n")}>
      {list.slice(0, 2).map((b) => <bdi key={b} dir="ltr" className="block text-xs tabular-nums [overflow-wrap:anywhere]">{b}</bdi>)}
      {more > 0 && <span className="badge bg-black/5 text-ink-soft">{t.product.moreBarcodes.replace("{n}", String(more))}</span>}
    </span>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-[0.6875rem] text-ink-soft">{label}</dt><dd className="mt-0.5">{children}</dd></div>;
}

