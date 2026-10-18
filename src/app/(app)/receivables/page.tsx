import Link from "next/link";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { openItems } from "@/lib/receivables";

export const dynamic = "force-dynamic";
const LIGHT = { green: "bg-brand-500", yellow: "bg-amber-400", red: "bg-red-500", none: "bg-violet-400" } as const;

export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ view?: string; f?: string }> }) {
  const { view = "invoice", f = "all" } = await searchParams;
  const { t, intl } = await getI18n();
  const all = await openItems();
  const debts = all.filter((r) => r.state.openCents > 0);
  const totalOpen = debts.reduce((s, r) => s + r.state.openCents, 0);
  const totalOverdue = debts.reduce((s, r) => s + r.state.overdueCents, 0);
  const soon = debts.filter((r) => r.light === "yellow");
  const soonCents = soon.reduce((s, r) => s + r.state.nextDueCents, 0);
  const rows = f === "red" ? all.filter((r) => r.light === "red") : f === "yellow" ? soon : f === "credit" ? all.filter((r) => r.state.openCents < 0) : all;

  const byCustomer = new Map<string, { id: string; name: string; open: number; overdue: number; count: number; worst: number; light: keyof typeof LIGHT }>();
  for (const r of rows) {
    const g = byCustomer.get(r.customerId) ?? { id: r.customerId, name: r.customerName, open: 0, overdue: 0, count: 0, worst: 0, light: "green" as const };
    g.open += r.state.openCents; g.overdue += r.state.overdueCents; g.count++; g.worst = Math.max(g.worst, r.state.daysOverdue);
    g.light = g.overdue > 0 ? "red" : g.light === "yellow" || r.light === "yellow" ? "yellow" : g.open < 0 ? "none" : "green";
    byCustomer.set(r.customerId, g);
  }
  const groups = [...byCustomer.values()].sort((a, b) => b.overdue - a.overdue || b.open - a.open);
  const q = (o: Record<string, string>) => "?" + new URLSearchParams({ view, f, ...o }).toString();

  return (
    <div>
      <PageHeader title={t.pay.receivables} />
      <div className="stagger mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card href={q({ f: "all" })} active={f === "all"} label={t.pay.totalOpen} value={formatCents(totalOpen, intl)} sub={`${debts.length} ${t.pay.openInvoices}`} dot="bg-brand-500" />
        <Card href={q({ f: "red" })} active={f === "red"} label={t.pay.totalOverdue} value={formatCents(totalOverdue, intl)} tone={totalOverdue ? "text-red-600" : ""} dot="bg-red-500" />
        <Card href={q({ f: "yellow" })} active={f === "yellow"} label={t.pay.dueSoon} value={formatCents(soonCents, intl)} tone={soonCents ? "text-amber-600" : ""} dot="bg-amber-400" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-xl bg-white p-1 shadow-card ring-1 ring-black/5">
          {(["invoice", "customer"] as const).map((v) => (
            <Link key={v} href={q({ view: v })} className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition ${view === v ? "bg-brand-600 text-white shadow" : "text-ink-soft hover:text-ink"}`}>
              {v === "invoice" ? t.pay.byInvoice : t.pay.byCustomer}
            </Link>
          ))}
        </div>
        {all.some((r) => r.state.openCents < 0) && <Link href={q({ f: f === "credit" ? "all" : "credit" })} className={`badge ${f === "credit" ? "bg-violet-600 text-white" : "bg-violet-100 text-violet-800"}`}>{t.pay.credit}</Link>}
      </div>

      {rows.length === 0 ? (
        <div className="card flex animate-rise items-center gap-3 p-8 text-ink-soft"><Icon name="check" className="h-6 w-6 text-brand-600" />{t.pay.nothingOpen}</div>
      ) : view === "customer" ? (
        <div className="card animate-rise overflow-hidden"><div className="table-wrap"><table className="tbl">
          <thead><tr><th></th><th>{t.pay.customer}</th><th className="text-end">{t.pay.openInvoices}</th><th className="text-end">{t.pay.daysOverdue}</th><th className="text-end">{t.pay.overdue}</th><th className="text-end">{t.pay.open}</th><th></th></tr></thead>
          <tbody>{groups.map((g) => (
            <tr key={g.id}>
              <td className="w-6"><span className={`block h-3 w-3 rounded-full ${LIGHT[g.light]}`} /></td>
              <td><Link href={`/customers/${g.id}`} className="font-semibold hover:text-brand-700">{g.name}</Link></td>
              <td className="num text-end">{g.count}</td>
              <td className="num text-end">{g.worst || ""}</td>
              <td className="num text-end font-semibold text-red-600">{g.overdue ? formatCents(g.overdue, intl) : ""}</td>
              <td className={`num text-end font-bold ${g.open < 0 ? "text-violet-700" : ""}`}>{formatCents(g.open, intl)}</td>
              <td className="text-end"><Link href={`/customers/${g.id}/statement`} className="text-xs font-semibold text-brand-700 hover:underline">{t.pay.statement}</Link></td>
            </tr>
          ))}</tbody>
        </table></div></div>
      ) : (
        <div className="card animate-rise overflow-hidden"><div className="table-wrap"><table className="tbl">
          <thead><tr><th></th><th>{t.pay.invoice}</th><th>{t.pay.customer}</th><th>{t.pay.nextDue}</th><th className="text-end">{t.pay.daysOverdue}</th><th className="text-end">{t.pay.paid}</th><th className="text-end">{t.pay.open}</th><th></th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.invoiceId} className={r.light === "red" ? "bg-red-50/50" : ""}>
              <td className="w-6"><span className={`block h-3 w-3 rounded-full ${LIGHT[r.light]}`} title={t.pay.status[r.state.status]} /></td>
              <td><Link href={`/sales/invoices/${r.invoiceId}#payments`} className="num font-semibold hover:text-brand-700" dir="ltr">{r.number}</Link></td>
              <td><Link href={`/customers/${r.customerId}`} className="hover:text-brand-700">{r.customerName}</Link></td>
              <td className="num">{r.state.nextDueDate ? formatDate(r.state.nextDueDate, intl) : "—"}</td>
              <td className="num text-end font-semibold text-red-600">{r.state.daysOverdue || ""}</td>
              <td className="num text-end text-ink-soft">{formatCents(r.state.paidCents, intl)}</td>
              <td className={`num text-end font-bold ${r.state.openCents < 0 ? "text-violet-700" : ""}`}>{formatCents(r.state.openCents, intl)}</td>
              <td className="text-end">{r.dunningLevel > 0 && <span className="badge bg-amber-100 text-amber-800">{t.pay.dunningLevels[Math.min(r.dunningLevel, 3) as 1 | 2 | 3]}</span>}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      )}
    </div>
  );
}

function Card({ href, active, label, value, sub, tone = "", dot }: { href: string; active: boolean; label: string; value: string; sub?: string; tone?: string; dot: string }) {
  return (
    <Link href={href} className={`card card-hover group p-5 ${active ? "ring-2 ring-brand-500" : ""}`}>
      <div className="flex items-center gap-2 text-sm text-ink-soft"><span className={`h-2.5 w-2.5 rounded-full ${dot}`} />{label}</div>
      <div className={`num mt-1 text-2xl font-bold ${tone}`}>{value}</div>
      {sub && <div className="text-xs text-ink-soft">{sub}</div>}
    </Link>
  );
}
