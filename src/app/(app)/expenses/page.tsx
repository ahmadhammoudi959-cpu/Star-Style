import Link from "next/link";
import { and, between, desc, eq, ilike, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { formatDate, todayIso } from "@/lib/dates";
import { lockedMonths, monthRange } from "@/lib/periods";
import { MonthNav } from "./MonthNav";
import { OpenButton } from "@/components/OpenButton";
import { FilterSelect } from "@/components/FilterSelect";
import { SearchPick } from "@/components/SearchPick";

export const dynamic = "force-dynamic";

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ month?: string; q?: string; saved?: string; cat?: string }> }) {
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : todayIso().slice(0, 7);
  const q = (sp.q ?? "").trim();
  type Cat = (typeof schema.expenseCategory.enumValues)[number];
  const cat = (schema.expenseCategory.enumValues as readonly string[]).includes(sp.cat ?? "") ? (sp.cat as Cat) : null;
  const { t, intl } = await getI18n();
  const { from, to } = monthRange(month);
  const [rows, locks] = await Promise.all([
    db.query.expenses.findMany({
      where: and(between(schema.expenses.date, from, to), q ? or(ilike(schema.expenses.vendorName, `%${q}%`), ilike(schema.expenses.invoiceNo, `%${q}%`)) : undefined,
        cat ? eq(schema.expenses.category, cat) : undefined),
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
      </div>
      {/* Auswählen statt tippen: Kategorie, oder Ausgabe direkt aus der Liste */}
      <form className="card relative z-10 mb-5 flex flex-col gap-3 p-4 animate-rise md:flex-row md:flex-wrap md:items-end">
        <input type="hidden" name="month" value={month} />
        <div className="md:w-80">
          <SearchPick name="q" defaultValue={q} label={t.lists.pickExpense} placeholder={t.exp.search} emptyLabel={t.exp.empty}
            items={rows.map((r) => ({ label: r.vendorName, sub: [formatDate(r.date, intl), r.invoiceNo, formatCents(r.grossCents, intl)].filter(Boolean).join(" · "),
              href: `/expenses/${r.id}`, search: `${r.vendorName} ${r.invoiceNo}`.toLowerCase() }))} />
        </div>
        <FilterSelect name="cat" label={t.exp.category} allLabel={t.lists.all} defaultValue={cat ?? ""} icon="tag" className="md:w-64"
          options={schema.expenseCategory.enumValues.map((c) => ({ value: c, label: t.exp.categories[c] }))} />
        {(q || cat) && <Link href={`/expenses?month=${month}`} className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
      </form>

      <div className="stagger mb-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label={t.exp.total} value={formatCents(sum("netCents"), intl)} sub={`${rows.length} ${t.exp.count} · ${t.exp.net}`} />
        <Kpi label={t.exp.vat} value={formatCents(sum("vatCents"), intl)} />
        <Kpi label={t.exp.open} value={formatCents(unpaid.reduce((s, r) => s + r.grossCents, 0), intl)} tone={unpaid.length ? "text-amber-600" : ""} />
        <Kpi label={t.exp.receiptMissing} value={String(missing)} tone={missing ? "text-red-600" : "text-brand-700"} />
      </div>

      <div className="card animate-rise overflow-hidden">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{t.exp.empty}</p> : (
          <>
          <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
            <thead><tr><th>{t.common.date}</th><th>{t.exp.vendor}</th><th>{t.exp.category}</th><th className="text-end">{t.exp.net}</th><th className="text-end">{t.exp.gross}</th><th></th><th className="w-px"><span className="sr-only">{t.product.open}</span></th></tr></thead>
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
                <td className="text-end"><OpenButton href={`/expenses/${r.id}`} label={t.product.open} /></td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="space-y-2 p-3 md:hidden">
            {rows.map((r) => (
              <div key={r.id} className={`space-y-2 rounded-xl p-3 ring-1 ring-black/5 ${sp.saved === r.id ? "bg-brand-50" : "bg-brand-50/40"}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-bold [overflow-wrap:anywhere]">{r.vendorName}</span>
                  <span className="num font-bold">{formatCents(r.grossCents, intl)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
                  <span className="num">{formatDate(r.date, intl)}</span>
                  {r.invoiceNo && <bdi dir="ltr">{r.invoiceNo}</bdi>}
                  <span className="badge bg-brand-50 text-brand-700">{t.exp.categories[r.category]}</span>
                  {!r.paid && <span className="badge bg-amber-100 text-amber-800">{t.exp.open}</span>}
                  {!r.fileId && <span className="badge bg-red-50 text-red-700">{t.exp.receiptMissing}</span>}
                </div>
                <OpenButton href={`/expenses/${r.id}`} label={t.product.open} className="w-full py-2.5 text-sm" />
              </div>
            ))}
          </div>
          </>
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
