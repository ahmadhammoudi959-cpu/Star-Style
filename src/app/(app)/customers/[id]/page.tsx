import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { determineTaxMode } from "@/lib/tax";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { CustomerForm, type CustomerData } from "../CustomerForm";
import { VatCheckButton } from "../VatCheckButton";

export default async function CustomerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { id } = await params;
  const { saved } = await searchParams;
  const { t, intl } = await getI18n();
  const empty: CustomerData = { type: "COMPANY", name: "", contact: "", email: "", phone: "", street: "", zip: "", city: "", country: "DE", vatId: "", vatIdStatus: "NONE", priceGroup: "WHOLESALE", creditLimit: "", paymentTermDays: "", notes: "" };
  if (id === "new") return <div><PageHeader title={t.customer.new} back="/customers" /><CustomerForm t={t} initial={empty} /></div>;

  const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, id) });
  if (!c) notFound();
  const [checks, docs] = await Promise.all([
    db.select().from(schema.vatChecks).where(eq(schema.vatChecks.customerId, id)).orderBy(desc(schema.vatChecks.checkedAt)).limit(6),
    db.execute<Record<string, unknown>>(sql`
      select 'offer' as kind, id, number, status::text, date as d, null::int as gross from offers where customer_id = ${id}
      union all
      select 'invoice', id, coalesce(number, '—'), status::text, coalesce(issue_date, created_at::date), gross_cents from invoices where customer_id = ${id}
      order by d desc limit 30`),
  ]);
  const mode = determineTaxMode(c);
  const statusTone = { NONE: "bg-gray-100 text-gray-700", PENDING: "bg-amber-100 text-amber-800", VALID: "bg-brand-100 text-brand-700", INVALID: "bg-red-100 text-red-800" }[c.vatIdStatus];

  return (
    <div>
      <PageHeader title={c.name} subtitle={`${t.customer.number} ${c.number}`} back="/customers"
        actions={<Link href={`/sales/offers/new?customer=${c.id}`} className="btn-primary group"><Icon name="cart" className="h-4 w-4" />{t.sales.newOffer}</Link>} />
      {saved && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700"><Icon name="check" className="h-4 w-4" />{t.common.saved}</div>}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <CustomerForm t={t} initial={{
            id: c.id, type: c.type, name: c.name, contact: c.contact, email: c.email, phone: c.phone, street: c.street, zip: c.zip, city: c.city,
            country: c.country, vatId: c.vatId, vatIdStatus: c.vatIdStatus, priceGroup: c.priceGroup,
            creditLimit: c.creditLimitCents != null ? (c.creditLimitCents / 100).toFixed(2).replace(".", ",") : "",
            paymentTermDays: c.paymentTermDays != null ? String(c.paymentTermDays) : "", notes: c.notes,
          }} />
          <section className="card overflow-hidden animate-rise">
            <h2 className="px-5 pt-5 text-lg font-bold">{t.customer.documents}</h2>
            {docs.rows.length === 0 ? <p className="p-5 text-sm text-ink-soft">{t.sales.empty}</p> : (
              <div className="table-wrap mt-3"><table className="tbl">
                <tbody>{docs.rows.map((d) => (
                  <tr key={String(d.id)}>
                    <td><Link href={`/sales/${d.kind === "offer" ? "offers" : "invoices"}/${d.id}`} className="num font-semibold hover:text-brand-700" dir="ltr">{String(d.number)}</Link></td>
                    <td>{d.kind === "offer" ? t.sales.offers : t.sales.invoices}</td>
                    <td className="num">{formatDate(String(d.d), intl)}</td>
                    <td><span className="badge bg-brand-50 text-brand-700">{t.sales.status[d.status as keyof typeof t.sales.status]}</span></td>
                    <td className="num text-end">{d.gross != null ? formatCents(Number(d.gross), intl) : ""}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </div>
        <aside className="space-y-4">
          <div className="card p-5 animate-rise">
            <div className="text-sm text-ink-soft">{t.customer.taxMode}</div>
            <div className="mb-3 text-lg font-bold">{t.taxMode[mode]}</div>
            <div className="text-sm text-ink-soft">{t.customer.vatId}</div>
            <div className="mb-1 font-semibold" dir="ltr">{c.vatId || "—"}</div>
            <span className={`badge ${statusTone}`}>{t.customer.vatStatus[c.vatIdStatus]}</span>
            {c.vatCheckedAt && <span className="ms-2 text-xs text-ink-soft">{formatDate(c.vatCheckedAt.toISOString(), intl)}</span>}
            {c.vatId && c.country !== "DE" && <div className="mt-4"><VatCheckButton t={t} customerId={c.id} /></div>}
          </div>
          {checks.length > 0 && (
            <div className="card p-5 animate-rise">
              <h3 className="mb-2 font-bold">{t.customer.checks}</h3>
              <ul className="space-y-2 text-sm">
                {checks.map((k) => (
                  <li key={k.id} className="rounded-lg bg-brand-50/50 p-2">
                    <div className="flex justify-between"><b>{k.source}</b><span className={k.valid ? "text-brand-700" : k.valid === false ? "text-red-700" : "text-amber-700"}>{k.valid ? "✓" : k.valid === false ? "✗" : "?"}</span></div>
                    <div className="text-xs text-ink-soft">{formatDate(k.checkedAt.toISOString(), intl)} {k.name} {k.address} {k.error}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
