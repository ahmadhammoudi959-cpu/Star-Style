import Link from "next/link";
import { and, between, desc, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { formatDate, todayIso } from "@/lib/dates";
import { lockedMonths, monthRange } from "@/lib/periods";
import { MonthNav } from "./MonthNav";

export const dynamic = "force-dynamic";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ month?: string; q?: string; saved?: string }> }) {
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : todayIso().slice(0, 7);
  const q = (sp.q ?? "").trim();
  const { t, intl } = await getI18n();
  const { from, to } = monthRange(month);
  const [rows, locks] = await Promise.all([
    db.query.expenses.findMany({
      where: and(between(schema.expenses.date, from, to), q ? or(ilike(schema.expenses.vendorName, `%${q}%`), ilike(schema.expenses.invoiceNo, `%${q}%`)) : undefined),
      orderBy: [desc(schema.expenses.date), desc(schema.expenses.createdAt)],
    }),
    lockedMonths(),
  ]);
  const locked = locks.has(month);
  const sum = (k: "netCents" | "vatCents" | "grossCents") => rows.reduce((s, r) => s + r[k], 0);
  const missing = rows.filter((r) => !r.fileId).length;
  const unpaid = rows.filter((r) => !r.paid);

  return (
    <div>
      <PageHeader title={t.exp.title} actions={!locked && <Link href="/expenses/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.exp.new}</Link>} />
      <div className="mb-5 flex flex-wrap items-center gap-3 animate-rise">
        <MonthNav month={month} base="/expenses" months={t.rep.months} locked={locked} />
        <form className="relative w-full max-w-xs">
          <input type="hidden" name="month" value={month} />
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input name="q" defaultValue={q} placeholder={t.exp.search} className="input ps-9" />
        </form>
      </div>

      <div className="stagger mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label={t.exp.total} value={formatCents(sum("netCents"), intl)} sub={`${rows.length} ${t.exp.count} · ${t.exp.net}`} />
        <Kpi label={t.exp.vat} value={formatCents(sum("vatCents"), intl)} />
        <Kpi label={t.exp.open} value={formatCents(unpaid.reduce((s, r) => s + r.grossCents, 0), intl)} tone={unpaid.length ? "text-amber-600" : ""} />
        <Kpi label={t.exp.receiptMissing} value={String(missing)} tone={missing ? "text-red-600" : "text-brand-700"} />
      </div>

      <div className="card animate-rise overflow-hidden">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{t.exp.empty}</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>{t.common.date}</th><th>{t.exp.vendor}</th><th>{t.exp.category}</th><th className="text-end">{t.exp.net}</th><th className="text-end">{t.exp.gross}</th><th></th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className={sp.saved === r.id ? "bg-brand-50" : ""}>
                <td className="num">{formatDate(r.date, intl)}</td>
                <td>
                  <Link href={`/expenses/${r.id}`} className="font-semibold hover:text-brand-700">{r.vendorName}</Link>
                  {r.invoiceNo && <div className="text-xs text-ink-soft" dir="ltr">{r.invoiceNo}</div>}
                </td>
                <td>
                  <span className="badge bg-brand-50 text-brand-700">{t.exp.categories[r.category]}</span>
                  {r.taxCase !== "DOMESTIC" && <span className="badge ms-1 bg-sky-50 text-sky-800">{t.exp.taxCases[r.taxCase]}</span>}
                </td>
                <td className="num text-end">{formatCents(r.netCents, intl)}</td>
                <td className="num text-end font-semibold">{formatCents(r.grossCents, intl)}</td>
                <td className="text-end whitespace-nowrap">
                  {!r.paid && <span className="badge bg-amber-100 text-amber-800">{t.exp.open}</span>}
                  {r.fileId ? <a href={`/api/files/${r.fileId}`} target="_blank" title={t.exp.receiptShow} className="group ms-2 inline-grid h-8 w-8 place-items-center rounded-lg text-brand-700 hover:bg-brand-50"><Icon name="file" className="h-4 w-4" /></a>
                    : <span title={t.exp.receiptMissing} className="ms-2 inline-grid h-8 w-8 place-items-center text-red-500"><Icon name="alert" className="h-4 w-4" /></span>}
                  {!locked && <Link href={`/expenses/new?copy=${r.id}`} title={t.exp.copy} className="group inline-grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-brand-50"><Icon name="copy" className="h-4 w-4" /></Link>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="card group p-4">
      <div className="text-xs text-ink-soft">{label}</div>
      <div className={`num text-xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-ink-soft">{sub}</div>}
    </div>
  );
}
