import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OpenButton } from "@/components/OpenButton";
import { SearchPick } from "@/components/SearchPick";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * Ausgaben → Firmen: Firmen, von denen es nur Ausgaben gibt (kind EXPENSE, z. B. Baumarkt, Steuerbüro).
 * Sie stehen bewusst nicht bei den Lieferanten/im Wareneingang (Wunsch Inhaber 12.11.2026); Buchhaltung unverändert.
 */
export default async function ExpenseVendorsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const { t, intl } = await getI18n();
  const all = (await db.execute<Record<string, unknown>>(sql`
    select s.id, s.name, s.country, s.vat_id, count(e.id)::int as n, coalesce(sum(e.gross_cents), 0)::bigint as gross, max(e.date) as last
    from suppliers s left join expenses e on e.supplier_id = s.id
    where s.kind = 'EXPENSE'
    group by s.id order by lower(s.name)`)).rows.map((r) => ({
    id: String(r.id), name: String(r.name), country: String(r.country ?? ""), vatId: String(r.vat_id ?? ""),
    n: Number(r.n), gross: Number(r.gross), last: r.last ? String(r.last) : null,
  }));
  const s = q.trim().toLowerCase();
  const rows = s ? all.filter((r) => [r.name, r.vatId].some((f) => f.toLowerCase().includes(s))) : all;
  const href = (id: string) => `/expenses/vendors/${id}`;

  return (
    <div>
      <PageHeader title={t.exp.vendorsTitle} subtitle={t.exp.vendorsHint} back="/expenses" />
      {all.length > 0 && (
        <form className="card relative z-10 mb-4 grid grid-cols-2 gap-2 p-3 animate-rise md:flex md:flex-row md:flex-wrap md:items-end md:gap-3 md:p-4">
          <div className="col-span-2 md:w-80">
            <SearchPick name="q" defaultValue={q} label={t.exp.vendorsTitle} placeholder={t.exp.vendorSearch} emptyLabel={t.exp.vendorsEmpty}
              items={all.map((r) => ({ label: r.name, sub: [r.country, r.vatId, `${r.n} ${t.exp.vendorInvoices}`].filter(Boolean).join(" · "),
                href: href(r.id), search: `${r.name} ${r.vatId}`.toLowerCase() }))} />
          </div>
          {s && <Link href="/expenses/vendors" className="btn-ghost group"><Icon name="x" className="h-4 w-4" />{t.stock.clear}</Link>}
        </form>
      )}

      <div className="card overflow-hidden animate-rise">
        {rows.length === 0 ? <p className="p-10 text-center text-ink-soft">{s ? t.lists.noMatch : t.exp.vendorsEmpty}</p> : (
          <>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr>
                <th>{t.supplier.name}</th><th>{t.supplier.vatId}</th><th className="w-px text-end">{t.exp.vendorInvoices}</th>
                <th>{t.exp.vendorLast}</th><th className="text-end">{t.exp.vendorTotal}</th>
                <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={href(r.id)} className="font-semibold hover:text-brand-700">{r.name}</Link>
                    {r.country && <div className="text-xs text-ink-soft">{r.country}</div>}
                  </td>
                  <td><bdi dir="ltr" className="text-xs tabular-nums">{r.vatId || "—"}</bdi></td>
                  <td className="num text-end">{r.n}</td>
                  <td className="num">{r.last ? formatDate(r.last, intl) : "—"}</td>
                  <td className="num text-end font-semibold">{formatCents(r.gross, intl)}</td>
                  <td className="text-end"><OpenButton href={href(r.id)} label={t.product.open} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-2 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2 rounded-xl bg-brand-50/40 p-2.5 ring-1 ring-black/5">
                  <div className="min-w-0 space-y-0.5">
                    <div className="font-bold [overflow-wrap:anywhere]">{r.name}</div>
                    <div className="text-xs text-ink-soft">
                      {r.n} {t.exp.vendorInvoices}{r.last && <> · <span className="num">{formatDate(r.last, intl)}</span></>} · <span className="num font-semibold text-ink">{formatCents(r.gross, intl)}</span>
                    </div>
                  </div>
                  <OpenButton href={href(r.id)} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
