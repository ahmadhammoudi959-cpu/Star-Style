import Link from "next/link";
import { headers } from "next/headers";
import { getI18n, fill } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { OpenButton } from "@/components/OpenButton";
import { FilterSelect } from "@/components/FilterSelect";
import { Icon } from "@/components/Icon";
import { can, requirePerm } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/dates";
import { directBaseUrl, directLinks, listDirectOrders, type DirectRow } from "@/lib/direct";
import { directLinkUrl } from "@/lib/direct-rules";
import { LinkCards } from "./LinkCards";

export const dynamic = "force-dynamic";

const STATES = ["new", "done", "rejected", "all"] as const;

/** Direktverkauf (Wunsch Inhaber 19.11.2026): Bestell-Links + Listen, die Kunden darüber schicken */
export default async function DirectPage({ searchParams }: { searchParams: Promise<{ state?: string; q?: string }> }) {
  const session = await requirePerm("direct");
  const sp = await searchParams;
  const state = (STATES as readonly string[]).includes(sp.state ?? "") ? sp.state! : "new";
  const q = (sp.q ?? "").slice(0, 100);
  const { t, intl } = await getI18n();
  const D = t.direct;
  const [rows, links] = await Promise.all([listDirectOrders({ state, q }), directLinks()]);
  const base = directBaseUrl(await headers());
  const groupName = { RETAIL: t.customer.RETAIL, WHOLESALE: t.customer.WHOLESALE };
  const cards = links.map((l) => ({
    group: l.group, title: fill(D.linkFor[l.group], { g: groupName[l.group] }), url: l.token ? directLinkUrl(base, l.token) : null,
    exists: l.exists, on: l.on, since: l.since ? fill(D.since, { d: formatDate(l.since, intl) }) : null,
  }));

  const stateBadge = (r: DirectRow) => {
    if (r.state === "done") return <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"><Icon name="check" className="h-3.5 w-3.5" />{D.states.done}</span>;
    if (r.state === "rejected") return <span className="badge bg-slate-100 text-slate-600">{D.states.rejected}</span>;
    return <span className="badge bg-accent-50 text-accent-700 ring-1 ring-accent-100">{D.states.new}</span>;
  };
  const customerCell = (r: DirectRow) => {
    const c = r.customer ?? r.suggestion;
    if (!c) return <span className="text-xs text-ink-soft">{D.noCustomer}</span>;
    return (
      <span className="block min-w-0">
        <Link href={`/customers/${c.id}`} className="font-semibold hover:text-brand-700" dir="auto">{c.name}</Link>
        <span className="block text-xs text-ink-soft">{r.customer ? `${t.customer.number} ${c.number}` : `${D.sameEmail} · ${t.customer.number} ${c.number}`}</span>
      </span>
    );
  };
  const docCell = (r: DirectRow) => r.offer ? <Link href={`/sales/offers/${r.offer.id}`} className="num text-xs font-semibold text-brand-700 hover:underline" dir="ltr">{r.offer.number}</Link>
    : r.invoice ? <Link href={`/sales/invoices/${r.invoice.id}`} className="num text-xs font-semibold text-brand-700 hover:underline" dir="ltr">{r.invoice.number ?? D.draft}</Link> : null;

  return (
    <div className="space-y-6">
      <PageHeader title={D.title} subtitle={D.subtitle} />
      <LinkCards t={D} links={cards} mayLink={can(session, "direct.link")} state={{ on: t.common.active, off: t.common.inactive }} />

      <section className="card animate-rise overflow-hidden">
        <form method="get" className="grid grid-cols-2 gap-3 border-b border-black/5 p-4 md:grid-cols-[14rem_1fr_auto] md:items-end">
          <FilterSelect name="state" label={D.show} allLabel={D.states.new} defaultValue={state === "new" ? "" : state} icon="list"
            options={(["done", "rejected", "all"] as const).map((s) => ({ value: s, label: D.states[s] }))} />
          <label className="col-span-2 block md:col-span-1">
            <span className="label">{t.common.search.replace(/[ .…]+$/, "")}</span>
            <input name="q" defaultValue={q} placeholder={D.searchHint} className="input" autoComplete="off" />
          </label>
          <button className="btn-ghost group col-span-2 md:col-span-1"><Icon name="search" className="icon-pop h-4 w-4" />{t.common.search.replace(/[ .…]+$/, "")}</button>
        </form>
        {rows.length === 0 ? (
          <div className="space-y-1 p-5 text-sm text-ink-soft"><p className="font-semibold text-ink">{q ? D.noMatch : D.empty}</p>{!q && <p>{D.emptyHint}</p>}</div>
        ) : (
          <>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr>
                <th>{D.number}</th><th>{D.received}</th><th>{D.sender}</th><th>{D.prices}</th><th className="text-end">{D.items}</th>
                <th className="text-end">{D.total}</th><th>{D.customer}</th><th>{D.state}</th><th className="w-px"><span className="sr-only">{t.product.open}</span></th>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} data-direct-row={r.number}>
                  <td><Link href={`/direct/${r.id}`} className="num font-semibold hover:text-brand-700">{r.number}</Link></td>
                  <td className="num text-xs">{formatDateTime(r.createdAt, intl)}</td>
                  <td className="text-start">
                    <span className="block font-semibold" dir="auto">{r.name}</span>
                    <span className="block text-xs text-ink-soft" dir="auto">{[r.company, r.email].filter(Boolean).join(" · ")}</span>
                  </td>
                  <td><span className={`badge ${r.group === "WHOLESALE" ? "bg-violet-50 text-violet-700" : "bg-brand-50 text-brand-700"}`}>{groupName[r.group]}</span></td>
                  <td className="num text-end">{r.lines}<span className="block text-xs text-ink-soft">{fill(D.units, { n: r.units })}</span></td>
                  <td className="num text-end font-semibold">{formatCents(r.netCents, intl)}</td>
                  <td className="text-start">{customerCell(r)}</td>
                  <td><span className="flex flex-col items-center gap-1">{stateBadge(r)}{docCell(r)}</span></td>
                  <td className="text-end"><OpenButton href={`/direct/${r.id}`} label={t.product.open} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-3 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="space-y-1.5 rounded-xl bg-slate-50 p-2.5 ring-1 ring-black/5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2"><span className="num font-bold">#{r.number}</span>{stateBadge(r)}</span>
                    <span className="num text-xs text-ink-soft">{formatDateTime(r.createdAt, intl)}</span>
                  </div>
                  <div className="truncate text-sm font-semibold" dir="auto">{r.name}{r.company ? ` · ${r.company}` : ""}</div>
                  <div className="flex items-end justify-between gap-2">
                    <div className="grid grid-cols-3 gap-x-3 text-xs">
                      <span className="text-ink-soft">{D.items}<b className="num block text-ink">{r.lines}</b></span>
                      <span className="text-ink-soft">{D.total}<b className="num block text-ink">{formatCents(r.netCents, intl)}</b></span>
                      <span className="text-ink-soft">{D.prices}<b className="block truncate text-ink">{groupName[r.group]}</b></span>
                    </div>
                    <OpenButton href={`/direct/${r.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
