import Link from "next/link";
import { getI18n, fill } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OpenButton } from "@/components/OpenButton";
import { FilterSelect } from "@/components/FilterSelect";
import { SearchPick } from "@/components/SearchPick";
import { can, requireSession } from "@/lib/auth";
import { loadCustomerRows } from "@/lib/customer-list";
import { ORIGIN_FILTERS, filterCustomerRows, filterQuery, nameIsEmail, readFilter, splitByOrigin, type CustomerRow, type PriceGroup } from "@/lib/customer-filter";

type Sp = { q?: string; city?: string; tax?: string; group?: string; src?: string };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const f = readFilter((k) => sp[k as keyof Sp]);
  const { q = "", city = "", tax = "", group = "", src = "" } = f;
  const { t } = await getI18n();
  const session = await requireSession();
  const all = await loadCustomerRows();
  const rows = filterCustomerRows(all, f);
  const cities = [...new Set(all.map((r) => r.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  const modes = [...new Set(all.map((r) => r.mode))];
  const anyShop = all.some((r) => r.fromShop || r.shops.length > 0);
  const filtered = Boolean(q.trim() || city || tax || group || src);
  // Excel-Liste mit E-Mails (Wunsch Inhaber 13.11.2026) – dieselben Filter wie die Liste, eigenes Recht
  const exportHref = `/api/customers/export${filterQuery(f) ? `?${filterQuery(f)}` : ""}`;
  // System und Shops getrennt (Wunsch Inhaber 13.11.2026: „تفصل بين الزباين يلي بكريتها من السيستم والزباين يلي جاية من المتجرين“):
  // ohne Herkunft-Filter zwei Teile mit Überschrift und Anzahl, mit Filter nur der eine
  const split = splitByOrigin(rows);
  const parts = (ORIGIN_FILTERS as readonly string[]).includes(src) || !anyShop
    ? [{ key: "one", rows, head: null }]
    : [
      { key: "system", rows: split.system, head: { icon: "users" as const, title: t.customer.srcSystem, hint: t.customer.srcSystemHint } },
      { key: "shops", rows: split.shops, head: { icon: "globe" as const, title: t.customer.srcShops, hint: t.customer.srcShopsHint } },
    ].filter((p) => p.rows.length > 0);
  // Preisgruppe und Herkunft als Abzeichen (Wunsch Inhaber: „يظهر الزبون نوعه جملة ولا جملة الجملة“)
  const groupBadge = (g: PriceGroup) => <span className={`badge ${g === "WHOLESALE" ? "bg-violet-100 text-violet-800" : "bg-sky-100 text-sky-800"}`}>{t.customer[g]}</span>;
  const shopBadges = (r: CustomerRow) => (
    <>
      {r.isNew && <span className="badge bg-emerald-100 text-emerald-800">{t.customer.newBadge}</span>}
      {r.fromShop && <span className="badge inline-flex items-center gap-1 bg-slate-100 text-slate-700"><Icon name="globe" className="h-3 w-3" />{t.shop.names[r.fromShop]}</span>}
      {/* im System angelegt (oder aus dem anderen Shop), hat aber ein Konto / Bestellungen im Shop – z. B. Großhandelskunde */}
      {r.shops.filter((x) => x !== r.fromShop).map((x) => (
        <span key={x} className="badge inline-flex items-center gap-1 bg-white text-slate-600 ring-1 ring-slate-200"><Icon name="link" className="h-3 w-3" />{fill(t.customer.linkedShop, { shop: t.shop.names[x] })}</span>
      ))}
    </>
  );
  const hasBadges = (r: CustomerRow) => r.isNew || r.fromShop || r.shops.length > 0;
  // E-Mail in eigener Spalte; steht nur die E-Mail als Name da (Anmeldung im Shop ohne Namen) → „ohne Namen“ statt doppelt
  const nameOf = (r: CustomerRow) => nameIsEmail(r) ? <span className="font-normal italic text-ink-soft">{t.customer.noName}</span> : r.name;
  const mail = (r: CustomerRow) => r.email
    ? <a href={`mailto:${r.email}`} dir="ltr" className="[overflow-wrap:anywhere] hover:text-brand-700 hover:underline">{r.email}</a>
    : <span className="text-ink-soft">—</span>;
  const Head = ({ head, n }: { head: { icon: "users" | "globe"; title: string; hint: string }; n: number }) => (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <Icon name={head.icon} className="h-4 w-4 text-brand-600" />
      <span className="font-bold text-ink">{head.title}</span>
      <span className="badge bg-brand-600 text-white">{n}</span>
      <span className="text-xs font-normal text-ink-soft">{head.hint}</span>
    </div>
  );

  return (
    <div>
      <PageHeader title={t.customer.title} actions={<>
        {can(session, "customers.export") && rows.length > 0 && (
          <a href={exportHref} download className="btn-ghost group" title={t.customer.exportHint}>
            <Icon name="download" className="icon-pop h-4 w-4" />{t.customer.exportXlsx}
          </a>
        )}
        <Link href="/customers/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.customer.new}</Link>
      </>} />
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
          options={[{ value: "system", label: t.customer.srcSystem }, { value: "shops", label: t.customer.srcShops },
            ...(["GENERAL_SHOP", "BRAND_SHOP"] as const).map((x) => ({ value: x, label: fill(t.customer.srcFrom, { shop: t.shop.names[x] }) })),
            { value: "new", label: t.customer.srcNew }]} />}
        {filtered && <Link href="/customers" className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
      </form>

      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{filtered ? t.lists.noMatch : t.customer.empty}</p> : (
          <>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr><th>{t.customer.number}</th><th>{t.customer.name}</th><th>{t.supplier.email}</th><th>{t.customer.priceGroup}</th><th>{t.setup.city}</th>
                <th>{t.customer.vatId}</th><th>{t.customer.taxMode}</th><th className="w-px"><span className="sr-only">{t.product.open}</span></th></tr></thead>
              {parts.map((p) => (
                <tbody key={p.key}>
                  {p.head && <tr className="bg-brand-50/60"><td colSpan={8} className="py-2.5"><Head head={p.head} n={p.rows.length} /></td></tr>}
                  {p.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="num text-ink-soft">{r.number}</td>
                      <td>
                        <Link href={`/customers/${r.id}`} className="font-semibold [overflow-wrap:anywhere] hover:text-brand-700">{nameOf(r)}</Link>
                        {hasBadges(r) && <div className="mt-1 flex flex-wrap gap-1">{shopBadges(r)}</div>}
                      </td>
                      <td className="text-sm">{mail(r)}</td>
                      <td>{groupBadge(r.group)}</td>
                      <td className="text-ink-soft">{[r.city, r.country].filter(Boolean).join(", ")}</td>
                      <td><bdi dir="ltr" className="text-xs tabular-nums">{r.vatId || "—"}</bdi></td>
                      <td><span className="badge bg-brand-50 text-brand-700">{t.taxMode[r.mode]}</span></td>
                      <td className="text-end"><OpenButton href={`/customers/${r.id}`} label={t.product.open} /></td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table></div>
            <div className="space-y-2 p-2 md:hidden">
              {parts.map((p) => (
                <section key={p.key} className="space-y-2">
                  {p.head && <div className="px-1 pt-1"><Head head={p.head} n={p.rows.length} /></div>}
                  {p.rows.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-2 rounded-xl bg-brand-50/40 p-2.5 ring-1 ring-black/5">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-bold [overflow-wrap:anywhere]">{nameOf(r)}</span>
                          <span className="text-xs text-ink-soft">{t.customer.number} {r.number}</span>
                        </div>
                        {r.email && <div className="text-xs">{mail(r)}</div>}
                        <div className="text-xs text-ink-soft">{[r.city, r.country].filter(Boolean).join(", ")}{r.vatId && <> · <bdi dir="ltr">{r.vatId}</bdi></>}</div>
                        <div className="flex flex-wrap gap-1">{groupBadge(r.group)}<span className="badge bg-brand-50 text-brand-700">{t.taxMode[r.mode]}</span>{shopBadges(r)}</div>
                      </div>
                      <OpenButton href={`/customers/${r.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
