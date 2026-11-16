import Link from "next/link";
import { notFound } from "next/navigation";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { requirePerm } from "@/lib/auth";
import { canOpen } from "@/lib/permissions";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { getReturn } from "@/lib/returns";
import { isReturnReason } from "@/lib/returns-plan";

export const dynamic = "force-dynamic";

/** Eine Retoure: zurückgenommene Ware, was gebucht wurde (Storno, neue Rechnung, Verlust, Erstattung) */
export default async function ReturnPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ booked?: string }> }) {
  const session = await requirePerm("sales.view");
  const { id } = await params;
  const { booked } = await searchParams;
  const { t, intl } = await getI18n();
  const R = t.ret;
  const r = await getReturn(id);
  if (!r) notFound();
  const money = (c: number) => formatCents(c, intl);
  const restocked = r.lines.filter((l) => l.condition === "RESTOCK" && l.variantId).reduce((s, l) => s + l.qty, 0);
  const damaged = r.lines.filter((l) => l.condition === "DAMAGED").reduce((s, l) => s + l.qty, 0);

  return (
    <div className="space-y-6">
      <PageHeader title={`${R.one} ${r.number}`} subtitle={`${formatDate(r.date, intl)} · ${r.customer.name}`} back="/returns" />
      {booked === "1" && (
        <div role="status" className="flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
          <Icon name="check" className="h-4 w-4 shrink-0" />{R.booked.replace("{n}", r.number)}
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="card animate-rise min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 p-5">
            <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="undo" className="h-5 w-5 text-brand-600" />{R.goods}</h2>
            <span className="badge bg-slate-100 text-slate-700">{isReturnReason(r.reason) ? R.reasons[r.reason] : r.reason}</span>
          </div>
          <ul className="divide-y divide-black/5">
            {r.lines.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="font-semibold [overflow-wrap:anywhere]">{l.description}</div>
                  {l.code && <bdi dir="ltr" className="num text-xs text-ink-soft">{l.code.barcode || l.code.sku}</bdi>}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className={`badge ${l.condition === "DAMAGED" ? "bg-amber-100 text-amber-800" : l.variantId ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>
                    {l.variantId ? R.condition[l.condition] : R.creditOnly}
                  </span>
                  <b className="num text-lg">{l.qty}</b>
                </div>
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-2 gap-3 border-t border-black/5 p-5 sm:grid-cols-4">
            <Kpi k={R.units} v={String(r.lines.reduce((s, l) => s + l.qty, 0))} />
            <Kpi k={R.condition.RESTOCK} v={String(restocked)} tone="text-emerald-700" />
            <Kpi k={R.condition.DAMAGED} v={String(damaged)} tone={damaged ? "text-amber-700" : ""} />
            <Kpi k={R.creditAmount} v={money(r.creditCents)} tone="text-brand-700" />
          </div>
          {r.note && <p className="mx-5 mb-5 whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-black/5" dir="auto">{r.note}</p>}
        </section>

        <aside className="card h-fit animate-rise space-y-3 p-5">
          <h2 className="flex items-center gap-2 font-bold"><Icon name="receipt" className="h-5 w-5 text-brand-600" />{R.bookings}</h2>
          <ul className="space-y-2 text-sm">
            <Ref label={R.invoice} n={r.invoiceNumber} href={`/sales/invoices/${r.invoiceId}`} hint={R.nowCancelled} />
            {r.cancellationId && <Ref label={R.cancellation} n={r.cancellationNumber} href={`/sales/invoices/${r.cancellationId}`} />}
            {r.correctionId && <Ref label={R.correction} n={r.correctionNumber} href={`/sales/invoices/${r.correctionId}`} />}
            {r.writeOff && <Ref label={R.writeOff} n={r.writeOff.number} href={canOpen(session, "/write-offs") ? `/write-offs/${r.writeOff.id}` : undefined} />}
            {r.refundPayment ? (
              <Ref label={R.refund} n={`${money(r.refundCents)}${r.refundMethod ? ` · ${t.pay.methods[r.refundMethod]}` : ""}`} href={`/api/pdf/receipt/${r.refundPayment.id}`} external
                hint={r.refundPayment.cancelledAt ? t.pay.cancelled : r.refundPayment.number} />
            ) : null}
            {r.openCreditCents > 0 && r.creditInvoiceId && (
              <li><Link href={`/sales/invoices/${r.creditInvoiceId}#payments`} className="block rounded-lg bg-violet-50 px-3 py-2 text-xs font-semibold text-violet-900 ring-1 ring-violet-100 transition hover:bg-violet-100">
                {R.noRefund} <b className="num">{money(r.openCreditCents)}</b></Link></li>
            )}
          </ul>
          {canOpen(session, `/customers/${r.customerId}`) && (
            <Link href={`/customers/${r.customerId}`} className="btn-ghost group w-full justify-start"><Icon name="users" className="h-4 w-4" />{r.customer.name}</Link>
          )}
        </aside>
      </div>
    </div>
  );
}

function Kpi({ k, v, tone = "" }: { k: string; v: string; tone?: string }) {
  return <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-black/5"><div className="text-xs text-ink-soft">{k}</div><div className={`num text-lg font-bold ${tone}`}>{v}</div></div>;
}

function Ref({ label, n, href, hint, external }: { label: string; n: string | null; href?: string; hint?: string; external?: boolean }) {
  const box = "flex items-start justify-between gap-3 rounded-lg px-3 py-2 ring-1 ring-black/5";
  const body = <><span className="text-ink-soft">{label}</span><span className="text-end"><bdi dir="ltr" className="num font-semibold">{n ?? "—"}</bdi>{hint && <span className="block text-xs text-ink-soft">{hint}</span>}</span></>;
  return (
    <li>
      {href && external ? (
        <a href={href} target="_blank" rel="noopener" className={`${box} transition hover:bg-brand-50 hover:ring-brand-200`}>{body}</a>
      ) : href ? (
        <Link href={href} className={`${box} transition hover:bg-brand-50 hover:ring-brand-200`}>{body}</Link>
      ) : <div className={box}>{body}</div>}
    </li>
  );
}
