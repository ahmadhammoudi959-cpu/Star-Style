import Link from "next/link";
import { Thumb } from "@/components/Thumb";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { productCategories, stockRows, type StockRow } from "@/lib/queries";
import { formatCents } from "@/lib/money";
import { daysBetween, formatDate, todayIso } from "@/lib/dates";
import { CategorySelect } from "@/components/CategorySelect";
import { AutoSubmitCheckbox } from "@/components/AutoSubmitCheckbox";
import { OpenButton } from "@/components/OpenButton";
import { SearchPick } from "@/components/SearchPick";
import { fill } from "@/i18n";
import { LIST_STEP, listLimit, ShowMore } from "@/components/ShowMore";

export default async function StockPage({ searchParams }: { searchParams: Promise<{ q?: string; low?: string; cat?: string; n?: string }> }) {
  const { q = "", low, cat = "", n } = await searchParams;
  const { t, intl } = await getI18n();
  const lowOnly = low === "1";
  const [rows, cats] = await Promise.all([stockRows({ q, lowOnly, category: cat }), productCategories()]);
  const total = rows.reduce((s, r) => s + r.valueCents, 0);
  const today = todayIso();
  const filtered = Boolean(q.trim() || cat || lowOnly);
  // nur die ersten Zeilen zeigen, „Weitere anzeigen“ holt mehr (sonst lädt die Seite bei vielen Artikeln sehr lange)
  const limit = listLimit(n);
  const shown = rows.slice(0, limit);
  const moreHref = `/stock?${new URLSearchParams({ ...(q.trim() ? { q } : {}), ...(cat ? { cat } : {}), ...(lowOnly ? { low: "1" } : {}), n: String(limit + LIST_STEP) })}`;
  const expiry = (r: StockRow) => {
    if (!r.nextExpiry) return null;
    const d = daysBetween(today, r.nextExpiry);
    return <span className={`badge ${d < 0 ? "bg-red-100 text-red-800" : d <= 60 ? "bg-orange-100 text-orange-800" : "bg-brand-50 text-brand-700"}`}>{formatDate(r.nextExpiry, intl)}</span>;
  };

  return (
    <div>
      <PageHeader title={t.stock.title} subtitle={`${t.stock.value}: ${formatCents(total, intl)}`} />

      {/* Filter: Kategorie (filtert sofort), Suche, nur wenig Bestand (filtert sofort) */}
      <form className="card relative z-10 mb-4 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 p-3 animate-rise md:flex md:flex-row md:flex-wrap md:items-end md:gap-3 md:p-4">
        {cats.length > 0 && <CategorySelect categories={cats} label={t.picker.category} allLabel={t.picker.all} name="cat" defaultValue={cat} autoSubmit className="md:w-64" />}
        <div className={`min-w-0 md:max-w-md md:flex-1 ${cats.length ? "" : "col-span-2"}`}>
          <SearchPick name="q" defaultValue={q} label={t.picker.searchLabel} placeholder={t.product.searchHint} emptyLabel={t.picker.empty}
            items={rows.map((r) => ({ label: [r.nameDe, [r.size, r.color].filter(Boolean).join(" · ")].filter(Boolean).join(" – "),
              sub: [r.barcode ?? r.sku, r.category, `${t.product.stock}: ${r.stockQty}`].filter(Boolean).join(" · "), href: `/stock/${r.id}`, imageId: r.imageId,
              search: [r.nameDe, r.nameNl, r.sku, r.barcode ?? "", r.size, r.color, r.category].join(" ").toLowerCase() }))} />
        </div>
        <div className="col-span-2 flex flex-wrap items-center gap-2">
          <AutoSubmitCheckbox name="low" defaultChecked={lowOnly} label={t.stock.filterLow} />
          <button className="btn-primary group"><Icon name="search" className="h-4 w-4" />{t.common.search.replace("…", "").trim()}</button>
          {filtered && <Link href="/stock" className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
        </div>
      </form>

      {rows.length === 0 ? (
        <div className="card p-10 text-center text-ink-soft animate-rise">{lowOnly ? t.stock.noLow : filtered ? t.picker.empty : t.common.nothingYet}</div>
      ) : (
        <>
          {/* PC/Laptop: alle Spalten ohne seitliches Scrollen */}
          <div className="card hidden overflow-hidden animate-rise xl:block">
            <div className="table-wrap">
              <table className="tbl tbl-fit">
                <thead><tr>
                  <th className="w-[7rem]">{t.product.sku}</th>
                  <th className="w-[7rem]">{t.product.barcode}</th>
                  <th>{t.product.nameDe}</th>
                  <th className="w-px text-end">{t.product.stock}</th>
                  <th className="w-px text-end">{t.product.reserved}</th>
                  <th className="w-px text-end">{t.product.available}</th>
                  <th className="w-[5.5rem] text-end">{t.product.minStock}</th>
                  <th className="w-px">{t.receive.expiry}</th>
                  <th className="w-[6.5rem] text-end">{t.stock.value}</th>
                  <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
                </tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.id}>
                      <td><Code value={r.sku} /></td>
                      <td>{r.barcode ? <Code value={r.barcode} strong /> : <span className="text-xs text-ink-soft">—</span>}</td>
                      <td><NameCell r={r} /></td>
                      <td className="num text-end font-semibold"><Qty r={r} /></td>
                      <td className="num text-end text-ink-soft">{r.reserved || "—"}</td>
                      <td className="num text-end font-semibold">{r.stockQty - r.reserved}</td>
                      <td className="num text-end text-ink-soft">{r.minStock || "—"}</td>
                      <td>{expiry(r) ?? <span className="text-xs text-ink-soft">—</span>}</td>
                      <td className="num text-end">{formatCents(r.valueCents, intl)}</td>
                      <td className="text-end"><OpenButton href={`/stock/${r.id}`} label={t.product.open} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Handy/Tablet/kleiner Laptop: kompakte Karte je Größe/Farbe (Zahlen nebeneinander), alle Angaben sichtbar */}
          <div className="grid gap-2 md:grid-cols-2 xl:hidden">
            {shown.map((r) => (
              <div key={r.id} className="card p-3 animate-rise">
                <div className="flex items-start justify-between gap-2">
                  <NameCell r={r} />
                  <OpenButton href={`/stock/${r.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
                </div>
                {/* kleine Tabelle: jede Überschrift genau über ihrem Wert (Wunsch Inhaber 04.11.2026), dünne Linien dazwischen */}
                <dl className="mt-2 grid grid-cols-4 gap-px overflow-hidden rounded-xl bg-black/[0.07] text-xs ring-1 ring-black/[0.07]">
                  <Item label={t.product.sku} wide><Code value={r.sku} /></Item>
                  <Item label={t.product.barcode} wide>{r.barcode ? <Code value={r.barcode} strong /> : "—"}</Item>
                  <Item label={t.product.stock}><span className="num text-sm font-bold"><Qty r={r} /></span></Item>
                  <Item label={t.product.reserved}><span className="num">{r.reserved || "—"}</span></Item>
                  <Item label={t.product.available}><span className="num text-sm font-bold">{r.stockQty - r.reserved}</span></Item>
                  <Item label={t.product.minStock}><span className="num">{r.minStock || "—"}</span></Item>
                  <Item label={t.receive.expiry} wide>{expiry(r) ?? "—"}</Item>
                  <Item label={t.stock.value} wide><span className="num">{formatCents(r.valueCents, intl)}</span></Item>
                </dl>
              </div>
            ))}
          </div>
          <ShowMore shown={shown.length} total={rows.length} href={moreHref} more={fill(t.lists.showMore, { n: Math.min(LIST_STEP, rows.length - shown.length) })}
            showing={fill(t.lists.showing, { s: shown.length, t: rows.length })} />
        </>
      )}
    </div>
  );

}

function NameCell({ r, big = false }: { r: StockRow; big?: boolean }) {
  const variant = [r.size, r.color].filter(Boolean).join(" · ");
  return (
    <Link href={`/stock/${r.id}`} className="group flex items-center gap-2.5">
      <Thumb id={r.imageId} size={big ? 56 : 40} />
      <span className="min-w-0">
        <span className="block font-semibold leading-snug [overflow-wrap:anywhere] group-hover:text-brand-700">{r.nameDe}</span>
        {variant && <span className="badge mt-0.5 bg-brand-50 text-brand-700" dir="auto">{variant}</span>}
        {r.category && <span className="block text-[0.6875rem] text-ink-soft">{r.category}</span>}
      </span>
    </Link>
  );
}

function Qty({ r }: { r: StockRow }) {
  const lowStock = r.minStock > 0 && r.stockQty <= r.minStock;
  return <span className={r.stockQty < 0 ? "badge bg-red-100 text-red-800" : lowStock ? "badge bg-amber-100 text-amber-800" : ""}>{r.stockQty}</span>;
}

/** Nummern immer links-nach-rechts; lange Nummern brechen um statt die Tabelle zu verbreitern */
function Code({ value, strong = false }: { value: string; strong?: boolean }) {
  return <bdi dir="ltr" className={`block text-xs tabular-nums [overflow-wrap:anywhere] ${strong ? "text-ink" : "text-ink-soft"}`}>{value}</bdi>;
}

function Item({ label, children, wide = false }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 bg-white px-1.5 py-1.5 text-center ${wide ? "col-span-2" : ""}`}>
      <dt className="text-[0.6875rem] leading-tight text-ink-soft">{label}</dt><dd className="mt-0.5">{children}</dd>
    </div>
  );
}


