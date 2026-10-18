import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { determineTaxMode } from "@/lib/tax";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const { t } = await getI18n();
  const like = q.trim() ? `%${q.trim().toLowerCase()}%` : null;
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select id, number, type, name, city, country, vat_id, vat_id_status, email from customers
    where active and (${like}::text is null or lower(name) like ${like} or lower(city) like ${like} or lower(vat_id) like ${like} or number::text = ${q.trim()})
    order by name`)).rows;
  return (
    <div>
      <PageHeader title={t.customer.title} actions={<Link href="/customers/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.customer.new}</Link>} />
      <form className="mb-4 animate-rise">
        <label className="relative block max-w-md">
          <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
          <input name="q" defaultValue={q} placeholder={t.common.search} className="input ps-9" />
        </label>
      </form>
      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{t.customer.empty}</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>{t.customer.number}</th><th>{t.customer.name}</th><th>{t.setup.city}</th><th>{t.customer.vatId}</th><th>{t.customer.taxMode}</th></tr></thead>
            <tbody>{rows.map((r) => {
              const mode = determineTaxMode({ type: r.type as "COMPANY", country: String(r.country), vatIdStatus: r.vat_id_status as "NONE" });
              return (
                <tr key={String(r.id)}>
                  <td className="num text-ink-soft">{Number(r.number)}</td>
                  <td><Link href={`/customers/${r.id}`} className="font-semibold hover:text-brand-700">{String(r.name)}</Link></td>
                  <td className="text-ink-soft">{[r.city, r.country].filter(Boolean).join(", ")}</td>
                  <td className="num" dir="ltr">{String(r.vat_id) || "—"}</td>
                  <td><span className="badge bg-brand-50 text-brand-700">{t.taxMode[mode]}</span></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
