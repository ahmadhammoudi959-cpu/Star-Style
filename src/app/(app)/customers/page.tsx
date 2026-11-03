import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OpenButton } from "@/components/OpenButton";
import { FilterSelect } from "@/components/FilterSelect";
import { SearchPick } from "@/components/SearchPick";
import { determineTaxMode, type TaxMode } from "@/lib/tax";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; city?: string; tax?: string }> }) {
  const { q = "", city = "", tax = "" } = await searchParams;
  const { t } = await getI18n();
  const all = (await db.execute<Record<string, unknown>>(sql`
    select id, number, type, name, city, country, vat_id, vat_id_status, email from customers where active order by name`)).rows.map((r) => ({
    id: String(r.id), number: Number(r.number), name: String(r.name), city: String(r.city ?? ""), country: String(r.country ?? ""),
    vatId: String(r.vat_id ?? ""), email: String(r.email ?? ""),
    mode: determineTaxMode({ type: r.type as "COMPANY", country: String(r.country), vatIdStatus: r.vat_id_status as "NONE" }) as TaxMode,
  }));
  const s = q.trim().toLowerCase();
  const rows = all.filter((r) => (!city || r.city === city) && (!tax || r.mode === tax)
    && (!s || [r.name, r.city, r.vatId, r.email].some((f) => f.toLowerCase().includes(s)) || String(r.number) === s));
  const cities = [...new Set(all.map((r) => r.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  const modes = [...new Set(all.map((r) => r.mode))];
  const filtered = Boolean(s || city || tax);

  return (
    <div>
      <PageHeader title={t.customer.title} actions={<Link href="/customers/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.customer.new}</Link>} />
      {/* Auswählen statt tippen: Stadt, Steuer, oder Kunde direkt aus der Liste */}
      <form className="card relative z-10 mb-4 flex flex-col gap-3 p-4 animate-rise md:flex-row md:flex-wrap md:items-end">
        <div className="md:w-80">
          <SearchPick name="q" defaultValue={q} label={t.lists.pickCustomer} placeholder={t.lists.searchCustomer} emptyLabel={t.customer.empty}
            items={all.map((r) => ({ label: r.name, sub: [`${t.customer.number} ${r.number}`, [r.city, r.country].filter(Boolean).join(", "), r.vatId].filter(Boolean).join(" · "),
              href: `/customers/${r.id}`, search: [r.name, r.city, r.vatId, r.email, String(r.number)].join(" ").toLowerCase() }))} />
        </div>
        {cities.length > 0 && <FilterSelect name="city" label={t.setup.city} allLabel={t.lists.allCities} defaultValue={city} icon="globe" className="md:w-56"
          options={cities.map((c) => ({ value: c, label: c }))} />}
        {modes.length > 1 && <FilterSelect name="tax" label={t.customer.taxMode} allLabel={t.lists.all} defaultValue={tax} icon="receipt" className="md:w-56"
          options={modes.map((m) => ({ value: m, label: t.taxMode[m] }))} />}
        {filtered && <Link href="/customers" className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
      </form>

      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{filtered ? t.lists.noMatch : t.customer.empty}</p> : (
          <>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr><th>{t.customer.number}</th><th>{t.customer.name}</th><th>{t.setup.city}</th><th>{t.customer.vatId}</th><th>{t.customer.taxMode}</th>
                <th className="w-px"><span className="sr-only">{t.product.open}</span></th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="num text-ink-soft">{r.number}</td>
                  <td><Link href={`/customers/${r.id}`} className="font-semibold hover:text-brand-700">{r.name}</Link></td>
                  <td className="text-ink-soft">{[r.city, r.country].filter(Boolean).join(", ")}</td>
                  <td><bdi dir="ltr" className="text-xs tabular-nums">{r.vatId || "—"}</bdi></td>
                  <td><span className="badge bg-brand-50 text-brand-700">{t.taxMode[r.mode]}</span></td>
                  <td className="text-end"><OpenButton href={`/customers/${r.id}`} label={t.product.open} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-3 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="space-y-2 rounded-xl bg-brand-50/40 p-3 ring-1 ring-black/5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold [overflow-wrap:anywhere]">{r.name}</span>
                    <span className="text-xs text-ink-soft">{t.customer.number} {r.number}</span>
                  </div>
                  <div className="text-sm text-ink-soft">{[r.city, r.country].filter(Boolean).join(", ")}{r.vatId && <> · <bdi dir="ltr">{r.vatId}</bdi></>}</div>
                  <span className="badge bg-brand-50 text-brand-700">{t.taxMode[r.mode]}</span>
                  <OpenButton href={`/customers/${r.id}`} label={t.product.open} className="w-full py-2.5 text-sm" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
