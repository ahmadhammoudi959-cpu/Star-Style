import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { expireOffers } from "@/lib/sales";
import { StatusBadge } from "./StatusBadge";
import { openItems } from "@/lib/receivables";

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const { tab = "invoices", q = "" } = await searchParams;
  const { t, intl } = await getI18n();
  await expireOffers();
  const like = q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const rows = tab === "offers"
    ? (await db.execute<Record<string, unknown>>(sql`
        select o.id, o.number, o.status::text as status, o.date as d, o.valid_until, c.name as customer,
          (select coalesce(sum(round(l.qty * l.unit_price_cents * (10000 - l.discount_bp) / 10000.0)),0) from offer_lines l where l.offer_id = o.id)::bigint as amount
        from offers o join customers c on c.id = o.customer_id
        where (${like}::text is null or lower(o.number) like ${like} or lower(c.name) like ${like})
        order by o.created_at desc limit 200`)).rows
    : (await db.execute<Record<string, unknown>>(sql`
        select i.id, coalesce(i.number, '—') as number, i.status::text as status, i.kind::text as kind, coalesce(i.issue_date, i.created_at::date) as d,
               i.due_date, c.name as customer, i.gross_cents as amount, i.channel::text as channel
        from invoices i join customers c on c.id = i.customer_id
        where (${like}::text is null or lower(coalesce(i.number,'')) like ${like} or lower(c.name) like ${like})
        order by i.created_at desc limit 200`)).rows;

  const pay = tab === "invoices" ? new Map((await openItems()).map((r) => [r.invoiceId, r])) : new Map();
  const PAY_TONE = { PAID: "bg-brand-100 text-brand-800", OPEN: "bg-slate-100 text-slate-700", PARTIAL: "bg-sky-100 text-sky-800", OVERDUE: "bg-red-100 text-red-800", CREDIT: "bg-violet-100 text-violet-800" } as const;
  const payBadge = (r: Record<string, unknown>) => {
    if (r.status !== "ISSUED" || r.kind !== "INVOICE") return null;
    const s = (pay.get(String(r.id))?.state.status ?? "PAID") as keyof typeof PAY_TONE;
    return <span className={`badge ms-1 ${PAY_TONE[s]}`}>{t.pay.status[s]}</span>;
  };
  return (
    <div>
      <PageHeader title={t.sales.title} actions={<>
        <Link href="/sales/offers/new" className="btn-ghost group"><Icon name="plus" className="h-4 w-4" />{t.sales.newOffer}</Link>
        <Link href="/sales/invoices/new" className="btn-primary group"><Icon name="receipt" className="h-4 w-4" />{t.sales.newInvoice}</Link>
      </>} />
      <div className="mb-4 flex flex-wrap items-center gap-3 animate-rise">
        <div className="inline-flex rounded-xl bg-white p-1 shadow-card ring-1 ring-black/5">
          {(["invoices", "offers"] as const).map((k) => (
            <Link key={k} href={`/sales?tab=${k}`} className={`rounded-lg px-4 py-2 text-sm font-semibold transition ${tab === k ? "bg-brand-600 text-white shadow-card" : "text-ink-soft hover:text-ink"}`}>
              {k === "offers" ? t.sales.offers : t.sales.invoices}
            </Link>
          ))}
        </div>
        <form className="relative w-full max-w-xs">
          <input type="hidden" name="tab" value={tab} />
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input name="q" defaultValue={q} placeholder={t.common.search} className="input ps-9" />
        </form>
      </div>
      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{t.sales.empty}</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr>
              <th>{t.sales.number}</th><th>{t.common.date}</th><th>{t.sales.customer}</th><th>{t.common.actions}</th>
              {tab === "offers" ? <th className="hidden md:table-cell">{t.sales.validUntil}</th> : <th className="hidden md:table-cell">{t.sales.channel}</th>}
              <th className="text-end">{tab === "offers" ? t.sales.net : t.sales.gross}</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={String(r.id)}>
                <td><Link href={`/sales/${tab}/${r.id}`} className="num font-semibold hover:text-brand-700" dir="ltr">{String(r.number)}</Link></td>
                <td className="num">{formatDate(String(r.d), intl)}</td>
                <td>{String(r.customer)}</td>
                <td><StatusBadge t={t} status={String(r.status)} />{r.kind === "CANCELLATION" && <span className="badge ms-1 bg-red-50 text-red-700">Storno</span>}{payBadge(r)}</td>
                <td className="num hidden md:table-cell">{tab === "offers" ? formatDate(String(r.valid_until), intl) : t.sales.channels[r.channel as "STORE"]}</td>
                <td className={`num text-end font-semibold ${Number(r.amount) < 0 ? "text-red-600" : ""}`}>{formatCents(Number(r.amount), intl)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
