import Link from "next/link";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { todayIso } from "@/lib/dates";
import { lockedMonths } from "@/lib/periods";
import { monthReport, yearReport } from "@/lib/reports";
import { MonthNav } from "../expenses/MonthNav";
import { YearChart } from "./YearChart";

export const dynamic = "force-dynamic";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : todayIso().slice(0, 7);
  const { t, intl } = await getI18n();
  const [r, year, locks] = await Promise.all([monthReport(month), yearReport(Number(month.slice(0, 4))), lockedMonths()]);
  const T = r.totals;
  const pct = (bp: number) => `${(bp / 100).toFixed(1).replace(".", ",")} %`;
  const maxCat = Math.max(1, ...r.expensesByCategory.map((e) => e.net));
  const empty = T.revenueNet === 0 && T.expenses === 0 && T.goodsPurchases === 0 && T.losses === 0;

  return (
    <div className="space-y-6">
      <PageHeader title={t.rep.title} actions={
        <Link href={`/reports/export?month=${month}`} className="btn-primary group"><Icon name="download" className="h-4 w-4" />{t.rep.export}</Link>} />
      <div className="animate-rise"><MonthNav month={month} base="/reports" months={t.rep.months} locked={locks.has(month)} /></div>

      <div className="stagger grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon="cart" label={t.rep.revenue} value={formatCents(T.revenueNet, intl)} sub={`${r.channels.reduce((s, c) => s + c.invoices, 0)} ${t.rep.invoices}`} />
        <Kpi icon="layers" label={t.rep.grossProfit} value={formatCents(T.grossProfit, intl)} sub={`${t.rep.margin} ${pct(T.marginBp)}`} />
        <Kpi icon="receipt" label={t.rep.expenses} value={formatCents(T.expenses + T.losses, intl)} sub={T.losses ? `${t.rep.losses} ${formatCents(T.losses, intl)}` : undefined} />
        <Kpi icon="chart" label={t.rep.profit} value={formatCents(T.profit, intl)} tone={T.profit < 0 ? "text-red-600" : "text-brand-700"} strong />
      </div>

      {empty ? <div className="card animate-rise p-8 text-center text-ink-soft">{t.rep.noData}</div> : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-6">
            <section className="card animate-rise overflow-hidden">
              <h2 className="px-5 pt-5 text-lg font-bold">{t.rep.channels}</h2>
              <div className="table-wrap mt-3"><table className="tbl">
                <thead><tr><th>{t.rep.channel}</th><th className="text-end">{t.rep.revenue}</th><th className="text-end">{t.rep.cogs}</th><th className="text-end">{t.rep.grossProfit}</th><th className="text-end">{t.rep.margin}</th><th className="text-end">{t.rep.direct}</th><th className="text-end">{t.rep.contribution}</th></tr></thead>
                <tbody>
                  {r.channels.map((c) => (
                    <tr key={c.channel} className={c.revenueNet === 0 && c.direct === 0 ? "text-ink-soft" : ""}>
                      <td className="font-semibold">{t.sales.channels[c.channel]}</td>
                      <td className="num text-end">{formatCents(c.revenueNet, intl)}</td>
                      <td className="num text-end">{formatCents(c.cogs, intl)}</td>
                      <td className="num text-end font-semibold">{formatCents(c.grossProfit, intl)}</td>
                      <td className="num text-end">{c.revenueNet ? pct(c.marginBp) : "–"}</td>
                      <td className="num text-end">{formatCents(c.direct, intl)}</td>
                      <td className={`num text-end font-bold ${c.contribution < 0 ? "text-red-600" : ""}`}>{formatCents(c.contribution, intl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <dl className="ms-auto max-w-md space-y-1.5 p-5 text-sm">
                <Row k={t.rep.grossProfit} v={formatCents(T.grossProfit, intl)} />
                <Row k={`− ${t.rep.expenses}`} v={formatCents(-T.expenses, intl)} />
                <Row k={`− ${t.rep.losses}`} v={formatCents(-T.losses, intl)} />
                <div className={`flex justify-between rounded-xl px-4 py-3 font-bold text-white ${T.profit < 0 ? "bg-red-600" : "bg-brand-600"}`}><span>{t.rep.profit}</span><span className="num">{formatCents(T.profit, intl)}</span></div>
              </dl>
              {T.goodsPurchases > 0 && <p className="px-5 pb-5 text-xs text-ink-soft">{t.rep.goodsInfo.replace("{v}", formatCents(T.goodsPurchases, intl))}</p>}
            </section>

            <section className="card animate-rise p-5">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold">{t.rep.byCategory}</h2>
                <Link href={`/expenses?month=${month}`} className="text-sm font-semibold text-brand-700 hover:underline">{t.exp.title} →</Link>
              </div>
              {r.expensesByCategory.length === 0 ? <p className="text-sm text-ink-soft">{t.exp.empty}</p> : (
                <ul className="space-y-2.5">
                  {r.expensesByCategory.map((e) => (
                    <li key={e.category}>
                      <div className="mb-1 flex justify-between text-sm"><span className="font-semibold">{t.exp.categories[e.category]} <span className="text-xs font-normal text-ink-soft">· {e.count}</span></span><span className="num font-semibold">{formatCents(e.net, intl)}</span></div>
                      <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className={`h-full rounded-full ${e.category === "GOODS" ? "bg-slate-400" : "bg-brand-500"}`} style={{ width: `${(e.net / maxCat) * 100}%` }} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <aside className="space-y-6">
            <section className="card animate-rise space-y-2 p-5 text-sm">
              <h2 className="mb-1 text-lg font-bold">{t.rep.vatTitle}</h2>
              {r.vat.output.map((v) => <Row key={v.rateBp} k={`${t.rep.vatOut} ${v.rateBp / 100} %`} v={formatCents(v.vat, intl)} />)}
              {r.vat.output.length === 0 && <Row k={t.rep.vatOut} v={formatCents(0, intl)} />}
              <Row k={t.rep.vatIn} v={formatCents(-r.vat.inputVat, intl)} />
              {r.vat.selfAssessed > 0 && <Row k={t.rep.vatRc} v={`± ${formatCents(r.vat.selfAssessed, intl)}`} />}
              {r.vat.taxFreeEu !== 0 && <Row k={t.rep.taxFree} v={formatCents(r.vat.taxFreeEu, intl)} soft />}
              {r.vat.taxFreeExport !== 0 && <Row k={t.rep.taxFreeExport} v={formatCents(r.vat.taxFreeExport, intl)} soft />}
              {r.vat.oss.map((o) => <Row key={o.country} k={`${t.rep.oss} ${o.country}`} v={formatCents(o.vat, intl)} soft />)}
              <div className={`mt-2 flex justify-between rounded-xl px-4 py-3 font-bold ${r.vat.payable < 0 ? "bg-brand-50 text-brand-800" : "bg-amber-50 text-amber-900"}`}>
                <span>{r.vat.payable < 0 ? t.rep.refund : t.rep.payable}</span><span className="num">{formatCents(Math.abs(r.vat.payable), intl)}</span>
              </div>
              <p className="text-xs text-ink-soft">{t.rep.vatNote}</p>
            </section>
          </aside>
        </div>
      )}

      <section className="card animate-rise p-5">
        <h2 className="mb-3 text-lg font-bold">{t.rep.year} {month.slice(0, 4)}</h2>
        <YearChart data={year} months={t.rep.months} active={month} intl={intl}
          labels={{ revenue: t.rep.revenue, profit: t.rep.profit, grossProfit: t.rep.grossProfit, expenses: t.rep.expenses, losses: t.rep.losses }} />
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-semibold text-brand-700">{t.rep.table}</summary>
          <div className="table-wrap mt-2"><table className="tbl">
            <thead><tr><th></th><th className="text-end">{t.rep.revenue}</th><th className="text-end">{t.rep.grossProfit}</th><th className="text-end">{t.rep.expenses}</th><th className="text-end">{t.rep.losses}</th><th className="text-end">{t.rep.profit}</th></tr></thead>
            <tbody>{year.map((m) => (
              <tr key={m.month}><td><Link href={`/reports?month=${m.month}`} className="font-semibold hover:text-brand-700">{t.rep.months[Number(m.month.slice(5)) - 1]}</Link></td>
                <td className="num text-end">{formatCents(m.revenueNet, intl)}</td><td className="num text-end">{formatCents(m.grossProfit, intl)}</td>
                <td className="num text-end">{formatCents(m.expenses, intl)}</td><td className="num text-end">{formatCents(m.losses, intl)}</td>
                <td className={`num text-end font-semibold ${m.profit < 0 ? "text-red-600" : ""}`}>{formatCents(m.profit, intl)}</td></tr>
            ))}</tbody>
          </table></div>
        </details>
      </section>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone = "", strong }: { icon: "cart" | "layers" | "receipt" | "chart"; label: string; value: string; sub?: string; tone?: string; strong?: boolean }) {
  return (
    <div className={`card group p-5 ${strong ? "ring-2 ring-brand-500/30" : ""}`}>
      <div className="mb-2 flex items-center gap-2 text-sm text-ink-soft"><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-600"><Icon name={icon} className="h-4 w-4" /></span>{label}</div>
      <div className={`num text-2xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-ink-soft">{sub}</div>}
    </div>
  );
}
function Row({ k, v, soft }: { k: string; v: string; soft?: boolean }) {
  return <div className={`flex justify-between gap-3 ${soft ? "text-ink-soft" : ""}`}><dt className="text-ink-soft">{k}</dt><dd className="num font-semibold">{v}</dd></div>;
}
