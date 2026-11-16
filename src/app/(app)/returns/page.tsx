import Link from "next/link";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { OpenButton } from "@/components/OpenButton";
import { Icon } from "@/components/Icon";
import { can, requirePerm } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { listReturns } from "@/lib/returns";
import { isReturnReason } from "@/lib/returns-plan";

export const dynamic = "force-dynamic";

/** Retouren (Wunsch Inhaber 16.11.2026): Liste mit Suche; erfassen über „Retoure erfassen“ oder an der Rechnung */
export default async function ReturnsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await requirePerm("sales.view");
  const { q = "" } = await searchParams;
  const { t, intl } = await getI18n();
  const R = t.ret;
  const rows = await listReturns({ q });
  const mayBook = can(session, "sales.returns");
  const reason = (r: string) => (isReturnReason(r) ? R.reasons[r] : r);
  const refundText = (r: (typeof rows)[number]) => (r.refundCents ? `${formatCents(r.refundCents, intl)}${r.refundMethod ? ` · ${t.pay.methods[r.refundMethod]}` : ""}` : "—");

  return (
    <div className="space-y-6">
      <PageHeader title={R.title} subtitle={R.subtitle}
        actions={mayBook ? <Link href="/returns/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{R.new}</Link> : undefined} />
      <section className="card animate-rise overflow-hidden">
        <form method="get" className="flex gap-2 border-b border-black/5 p-4">
          <input name="q" defaultValue={q} placeholder={R.searchHint} className="input min-w-0 flex-1" autoComplete="off" />
          <button className="btn-ghost group shrink-0"><Icon name="search" className="h-4 w-4" /><span className="sr-only sm:not-sr-only">{t.common.search.replace(/[ .…]+$/, "")}</span></button>
        </form>
        {rows.length === 0 ? (
          <div className="space-y-1 p-5 text-sm text-ink-soft"><p className="font-semibold text-ink">{q ? R.noMatch : R.empty}</p>{!q && <p>{R.emptyHint}</p>}</div>
        ) : (
          <>
            <div className="table-wrap hidden md:block"><table className="tbl tbl-fit">
              <thead><tr>
                <th>{R.number}</th><th>{t.common.date}</th><th>{R.customer}</th><th>{R.invoice}</th><th>{R.reason}</th>
                <th className="text-end">{R.units}</th><th className="text-end">{R.creditAmount}</th><th className="text-end">{R.refund}</th>
                <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/returns/${r.id}`} className="num font-semibold hover:text-brand-700" dir="ltr">{r.number}</Link></td>
                  <td className="num">{formatDate(r.date, intl)}</td>
                  <td dir="auto">{r.customerName}</td>
                  <td><bdi dir="ltr" className="num">{r.invoiceNumber}</bdi></td>
                  <td><span className="badge bg-slate-100 text-slate-700">{reason(r.reason)}</span></td>
                  <td className="num text-end">{r.units}{r.damaged > 0 && <span className="block text-xs text-amber-700">{R.ofDamaged}: {r.damaged}</span>}</td>
                  <td className="num text-end font-semibold">{formatCents(r.creditCents, intl)}</td>
                  <td className="num text-end">{refundText(r)}</td>
                  <td className="text-end"><OpenButton href={`/returns/${r.id}`} label={t.product.open} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-3 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="space-y-1.5 rounded-xl bg-slate-50 p-2.5 ring-1 ring-black/5">
                  <div className="flex items-center justify-between gap-2">
                    <bdi dir="ltr" className="font-bold">{r.number}</bdi>
                    <span className="num text-xs text-ink-soft">{formatDate(r.date, intl)}</span>
                  </div>
                  <div className="truncate text-sm font-semibold" dir="auto">{r.customerName} · <bdi dir="ltr" className="num font-normal text-ink-soft">{r.invoiceNumber}</bdi></div>
                  <div className="flex items-end justify-between gap-2">
                    <div className="grid grid-cols-3 gap-x-3 text-xs">
                      <span className="text-ink-soft">{R.units}<b className="num block text-ink">{r.units}{r.damaged > 0 ? ` (${r.damaged}!)` : ""}</b></span>
                      <span className="text-ink-soft">{R.creditAmount}<b className="num block text-ink">{formatCents(r.creditCents, intl)}</b></span>
                      <span className="text-ink-soft">{R.refund}<b className="num block text-ink">{r.refundCents ? formatCents(r.refundCents, intl) : "—"}</b></span>
                    </div>
                    <OpenButton href={`/returns/${r.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
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
