import { notFound } from "next/navigation";
import Link from "next/link";
import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n, fill } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OpenButton } from "@/components/OpenButton";
import { Thumb } from "@/components/Thumb";
import { variantOptions } from "@/lib/queries";
import { categoryProducts, getCategory, storeContexts, storeNavs, syncCategoryTable } from "@/lib/categories";
import { categoryStoreState, decodeStoreResults } from "@/lib/shopify/category-map";
import { AddProducts, AddToStore, DeleteCategory, MoveSelect, NoMenuAccess, StoreResultNotes } from "../CategoryForms";
import { StoreChip } from "../StoreChip";

export const dynamic = "force-dynamic";

export default async function CategoryPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string; created?: string }> }) {
  const { id } = await params;
  const { r, created } = await searchParams;
  const { t } = await getI18n();
  const cat = await getCategory(id);
  if (!cat) notFound();
  await syncCategoryTable();
  const stores = await storeContexts();
  const [products, navs, options, all] = await Promise.all([
    categoryProducts(cat.name), storeNavs(stores), variantOptions(),
    db.select({ id: schema.categories.id, name: schema.categories.name }).from(schema.categories).orderBy(asc(schema.categories.name)),
  ]);
  const results = decodeStoreResults(r);
  const active = products.filter((p) => p.active).length;

  return (
    <div>
      <PageHeader title={cat.name} subtitle={fill(t.cat.count, { n: active })} back="/categories"
        actions={<Link href={`/products/new?category=${encodeURIComponent(cat.name)}`} className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.cat.newProduct}</Link>} />
      {created && !results.length && (
        <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-100">
          <Icon name="check" className="h-4 w-4" />{t.common.saved}
        </div>
      )}
      <StoreResultNotes t={t} results={results} navs={navs} />

      {/* In den Shops: gibt es sie dort? Sonst „Im Shop anlegen“ */}
      {stores.length > 0 && (
        <section className="card relative z-10 mb-6 space-y-4 p-5 animate-rise">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="globe" className="icon-pop h-5 w-5 text-brand-600" />{t.cat.inStores}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {stores.map((s) => {
              const st = categoryStoreState(cat.name, s.types, s.map);
              const nav = navs.find((n) => n.channel === s.channel)!;
              return (
                <div key={s.channel} className="space-y-3 rounded-xl bg-brand-50/50 p-4 ring-1 ring-black/5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{t.shop.names[s.channel]}</span>
                    <StoreChip t={t} st={st} />
                  </div>
                  {st.state !== "same" && <AddToStore t={t} categoryId={cat.id} nav={nav} own={st.state === "mapped"} />}
                </div>
              );
            })}
          </div>
          <NoMenuAccess t={t} navs={navs} />
        </section>
      )}

      <section className="card relative z-20 mb-6 space-y-3 p-5 animate-rise">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="plus" className="icon-pop h-5 w-5 text-brand-600" />{t.cat.addProducts}</h2>
          <p className="max-w-2xl text-sm text-ink-soft">{t.cat.addHint}</p>
        </div>
        <AddProducts t={t} categoryId={cat.id} options={options} />
      </section>

      <section className="card overflow-hidden animate-rise">
        <h2 className="flex items-center gap-2 p-5 pb-0 text-lg font-bold"><Icon name="box" className="icon-pop h-5 w-5 text-brand-600" />{t.cat.products}</h2>
        {products.length === 0 ? <p className="p-10 text-center text-ink-soft">{t.cat.empty}</p> : (
          <ul className="divide-y divide-black/5 p-3 sm:p-5">
            {products.map((p) => (
              <li key={p.id} className={`grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] sm:items-center ${p.active ? "" : "opacity-60"}`}>
                <div className="flex min-w-0 items-center gap-3">
                  <Thumb id={p.imageId} size={48} />
                  <div className="min-w-0">
                    <Link href={`/products/${p.id}`} className="font-semibold hover:text-brand-700 [overflow-wrap:anywhere]">{p.nameDe}</Link>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-soft">
                      <bdi dir="ltr" className="num">{p.barcode ?? p.sku}</bdi>
                      {p.linked.map((c) => <span key={c} className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100">{t.shop.names[c]} ✓</span>)}
                      {!p.active && <span className="badge bg-slate-100 text-slate-600">{t.cat.inactive}</span>}
                    </div>
                  </div>
                </div>
                <MoveSelect t={t} productId={p.id} current={cat.id} categories={all} />
                <OpenButton href={`/products/${p.id}`} label={t.product.open} className="px-3 py-2 text-xs" />
              </li>
            ))}
          </ul>
        )}
      </section>

      {products.length === 0 && <DeleteCategory t={t} id={cat.id} name={cat.name} />}
    </div>
  );
}
