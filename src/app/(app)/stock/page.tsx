import Link from "next/link";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { stockRows } from "@/lib/queries";
import { formatCents } from "@/lib/money";
import { daysBetween, formatDate, todayIso } from "@/lib/dates";

export default async function StockPage({ searchParams }: { searchParams: Promise<{ q?: string; low?: string }> }) {
  const { q = "", low } = await searchParams;
  const { t, intl } = await getI18n();
  const rows = await stockRows({ q, lowOnly: low === "1" });
  const total = rows.reduce((s, r) => s + r.valueCents, 0);
  const today = todayIso();
  return (
    <div>
      <PageHeader title={t.stock.title} subtitle={`${t.stock.value}: ${formatCents(total, intl)}`} />
      <form className="mb-4 flex flex-wrap items-center gap-3 animate-rise">
        <label className="relative block w-full max-w-md">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input name="q" defaultValue={q} placeholder={t.common.search} className="input ps-9" />
        </label>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input type="checkbox" name="low" value="1" defaultChecked={low === "1"} className="h-5 w-5 accent-brand-600" />{t.stock.filterLow}
        </label>
        <button className="btn-ghost">{t.common.search.replace("…", "").trim()}</button>
      </form>
      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{t.common.nothingYet}</p> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr>
                <th>{t.product.nameDe}</th><th className="hidden md:table-cell">{t.product.sku}</th>
                <th className="text-end">{t.product.stock}</th><th className="text-end">{t.product.reserved}</th>
                <th className="text-end">{t.product.available}</th><th className="hidden text-end md:table-cell">{t.product.minStock}</th>
                <th className="hidden md:table-cell">{t.receive.expiry}</th><th className="text-end">{t.stock.value}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const lowStock = r.minStock > 0 && r.stockQty <= r.minStock;
                  const d = r.nextExpiry ? daysBetween(today, r.nextExpiry) : null;
                  const label = [r.nameDe, [r.size, r.color].filter(Boolean).join(" · ")].filter(Boolean);
                  return (
                    <tr key={r.id}>
                      <td><Link href={`/stock/${r.id}`} className="font-semibold hover:text-brand-700">{label[0]}</Link>
                        {label[1] && <span className="ms-2 text-ink-soft">{label[1]}</span>}</td>
                      <td className="num hidden text-ink-soft md:table-cell" dir="ltr">{r.sku}</td>
                      <td className="num text-end font-semibold">
                        <span className={lowStock ? "badge bg-amber-100 text-amber-800" : ""}>{r.stockQty}</span>
                      </td>
                      <td className="num text-end text-ink-soft">{r.reserved || ""}</td>
                      <td className="num text-end">{r.stockQty - r.reserved}</td>
                      <td className="num hidden text-end text-ink-soft md:table-cell">{r.minStock || ""}</td>
                      <td className="hidden md:table-cell">
                        {d != null && <span className={`badge ${d < 0 ? "bg-red-100 text-red-800" : d <= 60 ? "bg-orange-100 text-orange-800" : "bg-brand-50 text-brand-700"}`}>{formatDate(r.nextExpiry, intl)}</span>}
                      </td>
                      <td className="num text-end">{formatCents(r.valueCents, intl)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
