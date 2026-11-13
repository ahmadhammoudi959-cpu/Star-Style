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

type Group = "WHOLESALE" | "RETAIL";
type Shop = "GENERAL_SHOP" | "BRAND_SHOP";
const NEW_DAYS = 7; // „neu aus dem Shop“ = in den letzten 7 Tagen im Shop angelegt (Startseite zeigt dieselbe Zahl)

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ q?: string; city?: string; tax?: string; group?: string; src?: string }> }) {
  const { q = "", city = "", tax = "", group = "", src = "" } = await searchParams;
  const { t } = await getI18n();
  // Shop-Konten (Wunsch Inhaber 13.11.2026): je Kunde die Shops, in denen er ein Konto hat oder bestellt hat, und seit wann
  const all = (await db.execute<Record<string, unknown>>(sql`
    select c.id, c.number, c.type, c.name, c.city, c.country, c.vat_id, c.vat_id_status, c.email, c.price_group,
      coalesce((select array_agg(distinct sc.channel) from shop_customers sc where sc.customer_id = c.id), '{}') as shops,
      (select min(coalesce(sc.registered_at, sc.created_at)) from shop_customers sc where sc.customer_id = c.id and sc.created_customer) as shop_new_at
    from customers c where c.active order by c.name`)).rows.map((r) => ({
    id: String(r.id), number: Number(r.number), name: String(r.name), city: String(r.city ?? ""), country: String(r.country ?? ""),
    vatId: String(r.vat_id ?? ""), email: String(r.email ?? ""), group: r.price_group as Group,
    shops: ((r.shops as string[] | null) ?? []).filter((x): x is Shop => x === "GENERAL_SHOP" || x === "BRAND_SHOP").sort(),
    isNew: r.shop_new_at != null && Date.now() - new Date(String(r.shop_new_at)).getTime() < NEW_DAYS * 86_400_000,
    mode: determineTaxMode({ type: r.type as "COMPANY", country: String(r.country), vatIdStatus: r.vat_id_status as "NONE" }) as TaxMode,
  }));
  const s = q.trim().toLowerCase();
  const srcOk = (r: (typeof all)[number]) => !src || (src === "shop" ? r.shops.length > 0 : src === "new" ? r.isNew : r.shops.includes(src as Shop));
  const rows = all.filter((r) => (!city || r.city === city) && (!tax || r.mode === tax) && (!group || r.group === group) && srcOk(r)
    && (!s || [r.name, r.city, r.vatId, r.email].some((f) => f.toLowerCase().includes(s)) || String(r.number) === s));
  const cities = [...new Set(all.map((r) => r.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  const modes = [...new Set(all.map((r) => r.mode))];
  const anyShop = all.some((r) => r.shops.length > 0);
  const filtered = Boolean(s || city || tax || group || src);
  // Preisgruppe und Herkunft als Abzeichen (Wunsch Inhaber: „يظهر الزبون نوعه جملة ولا جملة الجملة“)
  const groupBadge = (g: Group) => <span className={`badge ${g === "WHOLESALE" ? "bg-violet-100 text-violet-800" : "bg-sky-100 text-sky-800"}`}>{t.customer[g]}</span>;
  const shopBadges = (r: (typeof all)[number]) => (
    <>
      {r.isNew && <span className="badge bg-emerald-100 text-emerald-800">{t.customer.newBadge}</span>}
      {r.shops.map((x) => <span key={x} className="badge inline-flex items-center gap-1 bg-slate-100 text-slate-700"><Icon name="globe" className="h-3 w-3" />{t.shop.names[x]}</span>)}
    </>
  );

  return (
    <div>
      <PageHeader title={t.customer.title} actions={<Link href="/customers/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.customer.new}</Link>} />
      {/* Auswählen statt tippen: Stadt, Steuer, oder Kunde direkt aus der Liste */}
      <form className="card relative z-10 mb-4 grid grid-cols-2 gap-2 p-3 animate-rise md:flex md:flex-row md:flex-wrap md:items-end md:gap-3 md:p-4">
        <div className="col-span-2 md:w-80">
          <SearchPick name="q" defaultValue={q} label={t.lists.pickCustomer} placeholder={t.lists.searchCustomer} emptyLabel={t.customer.empty}
            items={all.map((r) => ({ label: r.name, sub: [`${t.customer.number} ${r.number}`, [r.city, r.country].filter(Boolean).join(", "), r.vatId].filter(Boolean).join(" · "),
              href: `/customers/${r.id}`, search: [r.name, r.city, r.vatId, r.email, String(r.number)].join(" ").toLowerCase() }))} />
        </div>
        {cities.length > 0 && <FilterSelect name="city" label={t.setup.city} allLabel={t.lists.allCities} defaultValue={city} icon="globe" className="md:w-56"
          options={cities.map((c) => ({ value: c, label: c }))} />}
        {modes.length > 1 && <FilterSelect name="tax" label={t.customer.taxMode} allLabel={t.lists.all} defaultValue={tax} icon="receipt" className="md:w-56"
          options={modes.map((m) => ({ value: m, label: t.taxMode[m] }))} />}
        <FilterSelect name="group" label={t.customer.priceGroup} allLabel={t.lists.all} defaultValue={group} icon="tag" className="md:w-48"
          options={(["RETAIL", "WHOLESALE"] as const).map((g) => ({ value: g, label: t.customer[g] }))} />
        {anyShop && <FilterSelect name="src" label={t.customer.src} allLabel={t.lists.all} defaultValue={src} icon="globe" className="md:w-64"
          options={[{ value: "shop", label: t.customer.srcShop }, { value: "new", label: t.customer.srcNew },
            ...(["GENERAL_SHOP", "BRAND_SHOP"] as const).map((x) => ({ value: x, label: t.shop.names[x] }))]} />}
        {filtered && <Link href="/customers" className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
      </form>

      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{filtered ? t.lists.noMatch : t.customer.empty}</p> : (
          <>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr><th>{t.customer.number}</th><th>{t.customer.name}</th><th>{t.customer.priceGroup}</th><th>{t.setup.city}</th><th>{t.customer.vatId}</th><th>{t.customer.taxMode}</th>
                <th className="w-px"><span className="sr-only">{t.product.open}</span></th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="num text-ink-soft">{r.number}</td>
                  <td>
                    <Link href={`/customers/${r.id}`} className="font-semibold [overflow-wrap:anywhere] hover:text-brand-700">{r.name}</Link>
                    {(r.isNew || r.shops.length > 0) && <div className="mt-1 flex flex-wrap gap-1">{shopBadges(r)}</div>}
                  </td>
                  <td>{groupBadge(r.group)}</td>
                  <td className="text-ink-soft">{[r.city, r.country].filter(Boolean).join(", ")}</td>
                  <td><bdi dir="ltr" className="text-xs tabular-nums">{r.vatId || "—"}</bdi></td>
                  <td><span className="badge bg-brand-50 text-brand-700">{t.taxMode[r.mode]}</span></td>
                  <td className="text-end"><OpenButton href={`/customers/${r.id}`} label={t.product.open} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-2 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 rounded-xl bg-brand-50/40 p-2.5 ring-1 ring-black/5">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-bold [overflow-wrap:anywhere]">{r.name}</span>
                      <span className="text-xs text-ink-soft">{t.customer.number} {r.number}</span>
                    </div>
                    <div className="text-xs text-ink-soft">{[r.city, r.country].filter(Boolean).join(", ")}{r.vatId && <> · <bdi dir="ltr">{r.vatId}</bdi></>}</div>
                    <div className="flex flex-wrap gap-1">{groupBadge(r.group)}<span className="badge bg-brand-50 text-brand-700">{t.taxMode[r.mode]}</span>{shopBadges(r)}</div>
                  </div>
                  <OpenButton href={`/customers/${r.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
