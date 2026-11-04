import { getI18n, fill } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OpenButton } from "@/components/OpenButton";
import { SearchPick } from "@/components/SearchPick";
import Link from "next/link";
import { listCategories, storeContexts, storeNavs, type CategoryInfo } from "@/lib/categories";
import type { ShopChannel } from "@/lib/shopify/client";
import type { Dict } from "@/i18n/de";
import { NewCategory } from "./CategoryForms";
import { StoreChip } from "./StoreChip";

export const dynamic = "force-dynamic";

/** Kategorien (Wunsch Inhaber 04.11.2026): anlegen – auf Wunsch gleich im Shop –, Artikel hinzufügen, alles synchron mit den Shops */
export default async function CategoriesPage({ searchParams }: { searchParams: Promise<{ q?: string; deleted?: string }> }) {
  const { q = "", deleted } = await searchParams;
  const { t } = await getI18n();
  const stores = await storeContexts();
  const [list, navs] = await Promise.all([listCategories(stores), storeNavs(stores)]);
  const s = q.trim().toLowerCase();
  const rows = s ? list.filter((c) => c.name.toLowerCase().includes(s)) : list;
  const channels = stores.map((x) => x.channel);

  return (
    <div>
      <PageHeader title={t.cat.title} subtitle={t.cat.subtitle} />
      {deleted && (
        <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-100">
          <Icon name="check" className="h-4 w-4" />{fill(t.cat.deleted, { c: deleted })}
        </div>
      )}
      <NewCategory t={t} navs={navs} />

      <form className="card relative z-10 mb-4 flex flex-col gap-3 p-4 animate-rise md:flex-row md:items-end">
        <div className="md:w-80">
          <SearchPick name="q" defaultValue={q} label={t.cat.pick} placeholder={t.cat.search} emptyLabel={t.cat.none}
            items={list.map((c) => ({ label: c.name, sub: fill(t.cat.count, { n: c.n }), href: `/categories/${c.id}`, search: c.name.toLowerCase() }))} />
        </div>
        {s && <Link href="/categories" className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
      </form>

      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{s ? t.lists.noMatch : t.cat.none}</p> : (
          <>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr>
                <th>{t.cat.name}</th><th>{t.product.title}</th>
                {channels.map((c) => <th key={c}>{t.shop.names[c]}</th>)}
                <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
              </tr></thead>
              <tbody>{rows.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/categories/${c.id}`} className="font-semibold hover:text-brand-700 [overflow-wrap:anywhere]"><bdi>{c.name}</bdi></Link></td>
                  <td className="num">{c.n}</td>
                  {channels.map((ch) => <td key={ch}><StoreChip t={t} st={c.stores[ch]} /></td>)}
                  <td className="text-end"><OpenButton href={`/categories/${c.id}`} label={t.product.open} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-3 md:hidden">
              {rows.map((c) => <CategoryCard key={c.id} t={t} c={c} channels={channels} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CategoryCard({ t, c, channels }: { t: Dict; c: CategoryInfo; channels: ShopChannel[] }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl bg-brand-50/40 p-2.5 ring-1 ring-black/5">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-bold [overflow-wrap:anywhere]"><bdi>{c.name}</bdi></span>
          <span className="text-xs text-ink-soft">{fill(t.cat.count, { n: c.n })}</span>
        </div>
        {channels.length > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs">
            {channels.map((ch) => <span key={ch} className="flex items-center gap-1"><span className="text-ink-soft">{t.shop.names[ch]}:</span><StoreChip t={t} st={c.stores[ch]} /></span>)}
          </div>
        )}
      </div>
      <OpenButton href={`/categories/${c.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
    </div>
  );
}
