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
import { OpenButton } from "@/components/OpenButton";
import { FilterSelect } from "@/components/FilterSelect";
import { SearchPick } from "@/components/SearchPick";

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string; customer?: string; status?: string }> }) {
  const { tab = "invoices", q = "", customer = "", status = "" } = await searchParams;
  const { t, intl } = await getI18n();
  await expireOffers();
  const like = q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const cust = customer || null;
  // Filter „Status“: Angebote nach Angebotsstatus; Rechnungen nach Entwurf/ausgestellt/storniert oder Zahlungsstand
  const st = status || null;
  const rows = tab === "offers"
    ? (await db.execute<Record<string, unknown>>(sql`
        select o.id, o.number, o.status::text as status, o.date as d, o.valid_until, c.name as customer,
          (select coalesce(sum(round(l.qty * l.unit_price_cents * (10000 - l.discount_bp) / 10000.0)),0) from offer_lines l where l.offer_id = o.id)::bigint as amount
        from offers o join customers c on c.id = o.customer_id
        where (${like}::text is null or lower(o.number) like ${like} or lower(c.name) like ${like})
          and (${cust}::text is null or o.customer_id = ${cust}) and (${st}::text is null or o.status::text = ${st})
        order by o.created_at desc limit 200`)).rows
    : (await db.execute<Record<string, unknown>>(sql`
        select i.id, coalesce(i.number, '—') as number, i.status::text as status, i.kind::text as kind, coalesce(i.issue_date, i.created_at::date) as d,
               i.due_date, c.name as customer, i.gross_cents as amount, i.channel::text as channel
        from invoices i join customers c on c.id = i.customer_id
        where (${like}::text is null or lower(coalesce(i.number,'')) like ${like} or lower(c.name) like ${like})
          and (${cust}::text is null or i.customer_id = ${cust})
          and (${st}::text is null or ${st} in ('PAID', 'OPEN', 'PARTIAL', 'OVERDUE', 'CREDIT') or i.status::text = ${st})
        order by i.created_at desc limit 200`)).rows;

  const pay = tab === "invoices" ? new Map((await openItems()).map((r) => [r.invoiceId, r])) : new Map();
  const PAY_TONE = { PAID: "bg-emerald-100 text-emerald-800", OPEN: "bg-slate-100 text-slate-700", PARTIAL: "bg-sky-100 text-sky-800", OVERDUE: "bg-red-100 text-red-800", CREDIT: "bg-violet-100 text-violet-800" } as const;
  const payStateOf = (r: Record<string, unknown>) =>
    r.status === "ISSUED" && r.kind === "INVOICE" ? ((pay.get(String(r.id))?.state.status ?? "PAID") as string) : null;
  const shown = tab === "invoices" && st && ["PAID", "OPEN", "PARTIAL", "OVERDUE", "CREDIT"].includes(st) ? rows.filter((r) => payStateOf(r) === st) : rows;
  const customers = (await db.execute<{ id: string; name: string; number: number }>(sql`
    select id, name, number from customers where active order by name`)).rows;
  const statusOptions = tab === "offers"
    ? (["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CONVERTED"] as const).map((k) => ({ value: k, label: t.sales.status[k] }))
    : [...(["DRAFT", "ISSUED", "CANCELLED"] as const).map((k) => ({ value: k, label: t.sales.status[k] })),
       ...(["OPEN", "PARTIAL", "OVERDUE", "PAID"] as const).map((k) => ({ value: k, label: t.pay.status[k] }))];
  const filtered = Boolean(q.trim() || customer || status);
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
      </div>
      {/* Auswählen statt tippen: Kunde, Status, oder Beleg direkt aus der Liste */}
      <form className="card relative z-10 mb-4 flex flex-col gap-3 p-4 animate-rise md:flex-row md:flex-wrap md:items-end">
        <input type="hidden" name="tab" value={tab} />
        <div className="md:w-72">
          <SearchPick name="q" defaultValue={q} label={t.lists.pickDoc} placeholder={t.lists.searchDoc} emptyLabel={t.sales.empty}
            items={rows.map((r) => ({ label: `${String(r.number)} · ${String(r.customer)}`, sub: `${formatDate(String(r.d), intl)} · ${formatCents(Number(r.amount), intl)}`,
              href: `/sales/${tab}/${r.id}`, search: `${String(r.number)} ${String(r.customer)}`.toLowerCase() }))} />
        </div>
        {customers.length > 0 && <FilterSelect name="customer" label={t.sales.customer} allLabel={t.lists.allCustomers} defaultValue={customer} icon="users" className="md:w-60"
          options={customers.map((c) => ({ value: c.id, label: c.name }))} />}
        <FilterSelect name="status" label={t.lists.status} allLabel={t.lists.allStatuses} defaultValue={status} icon="check" className="md:w-56" options={statusOptions} />
        {filtered && <Link href={`/sales?tab=${tab}`} className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
      </form>
      <div className="card overflow-hidden animate-rise">
        {shown.length === 0 ? <p className="p-10 text-center text-ink-soft">{filtered ? t.lists.noMatch : t.sales.empty}</p> : (
          <>
          <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
            <thead><tr>
              <th>{t.sales.number}</th><th>{t.common.date}</th><th>{t.sales.customer}</th><th>{t.lists.status}</th>
              {tab === "offers" ? <th className="hidden md:table-cell">{t.sales.validUntil}</th> : <th className="hidden md:table-cell">{t.sales.channel}</th>}
              <th className="text-end">{tab === "offers" ? t.sales.net : t.sales.gross}</th>
              <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
            </tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={String(r.id)}>
                <td><Link href={`/sales/${tab}/${r.id}`} className="num font-semibold hover:text-brand-700" dir="ltr">{String(r.number)}</Link></td>
                <td className="num">{formatDate(String(r.d), intl)}</td>
                <td>{String(r.customer)}</td>
                <td><StatusBadge t={t} status={String(r.status)} />{r.kind === "CANCELLATION" && <span className="badge ms-1 bg-red-50 text-red-700">Storno</span>}{payBadge(r)}</td>
                <td className="num hidden md:table-cell">{tab === "offers" ? formatDate(String(r.valid_until), intl) : t.sales.channels[r.channel as "STORE"]}</td>
                <td className={`num text-end font-semibold ${Number(r.amount) < 0 ? "text-red-600" : ""}`}>{formatCents(Number(r.amount), intl)}</td>
                <td className="text-end"><OpenButton href={`/sales/${tab}/${r.id}`} label={t.product.open} /></td>
              </tr>
            ))}</tbody>
          </table></div>
          {/* Handy: eine Karte pro Beleg, kein seitliches Scrollen */}
          <div className="space-y-2 p-3 md:hidden">
            {shown.map((r) => (
              <div key={String(r.id)} className="space-y-2 rounded-xl bg-brand-50/40 p-3 ring-1 ring-black/5">
                <div className="flex items-center justify-between gap-2">
                  <bdi dir="ltr" className="font-bold">{String(r.number)}</bdi>
                  <span className={`num font-bold ${Number(r.amount) < 0 ? "text-red-600" : ""}`}>{formatCents(Number(r.amount), intl)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="[overflow-wrap:anywhere]">{String(r.customer)}</span>
                  <span className="num text-xs text-ink-soft">{formatDate(String(r.d), intl)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <StatusBadge t={t} status={String(r.status)} />{r.kind === "CANCELLATION" && <span className="badge bg-red-50 text-red-700">Storno</span>}{payBadge(r)}
                </div>
                <OpenButton href={`/sales/${tab}/${r.id}`} label={t.product.open} className="w-full py-2.5 text-sm" />
              </div>
            ))}
          </div>
          </>
        )}
      </div>
    </div>
  );
}
