import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { formatDate, todayIso } from "@/lib/dates";
import { paymentState, trafficLight } from "@/lib/payment-status";
import { skontoDeadline } from "@/lib/payments";
import { skontoMax } from "@/lib/tax";
import type { Dict } from "@/i18n/de";
import { AddPayment, CancelPayment, DunningButton, PlanForm } from "./PaymentForms";

const STATUS_TONE = { PAID: "bg-brand-100 text-brand-800", OPEN: "bg-slate-100 text-slate-700", PARTIAL: "bg-sky-100 text-sky-800", OVERDUE: "bg-red-100 text-red-800", CREDIT: "bg-violet-100 text-violet-800" } as const;
const LIGHT = { green: "bg-brand-500", yellow: "bg-amber-400", red: "bg-red-500", none: "bg-slate-300" } as const;

export async function PaymentPanel({ t, intl, invoiceId }: { t: Dict; intl: string; invoiceId: string }) {
  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { payments: true, installments: true, dunnings: true } });
  if (!inv || inv.kind !== "INVOICE" || inv.status === "DRAFT") return null;
  const today = todayIso();
  const cancelled = inv.status === "CANCELLED";
  if (cancelled && !inv.payments.some((p) => !p.cancelledAt)) return null;
  const st = paymentState({ ...inv, grossCents: cancelled ? 0 : inv.grossCents, installments: cancelled ? [] : inv.installments }, today);
  const light = trafficLight(st, today);
  const payments = [...inv.payments].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  const dunnings = [...inv.dunnings].sort((a, b) => a.level - b.level);
  const nextLevel = Math.min(dunnings.length + 1, 3) as 1 | 2 | 3;
  const deadline = skontoDeadline(inv);
  const skontoLeft = skontoMax(inv.grossCents, inv.skontoBp) - inv.payments.filter((p) => !p.cancelledAt).reduce((s, p) => s + p.skontoCents, 0);
  const skonto = deadline && today <= deadline && st.openCents > skontoLeft && skontoLeft > 0
    ? { deadline: formatDate(deadline, intl), payCents: st.openCents - skontoLeft } : null;
  const plan = [...inv.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((r) => ({ dueDate: r.dueDate, amountCents: r.amountCents }));

  return (
    <section className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]" id="payments">
      <div className="card animate-rise overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/5 p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="euro" className="h-5 w-5 text-brand-600" />{t.pay.title}</h2>
          <span className={`badge flex items-center gap-1.5 ${STATUS_TONE[st.status]}`}><span className={`h-2 w-2 rounded-full ${LIGHT[light]}`} />{t.pay.status[st.status]}{st.daysOverdue > 0 && ` · ${st.daysOverdue} ${t.pay.days}`}</span>
        </div>
        <div className="grid grid-cols-3 gap-3 p-5">
          <Kpi label={t.pay.paid} value={formatCents(st.paidCents, intl)} tone="text-brand-700" />
          <Kpi label={st.openCents < 0 ? t.pay.credit : t.pay.open} value={formatCents(Math.abs(st.openCents), intl)} tone={st.openCents < 0 ? "text-violet-700" : st.overdueCents ? "text-red-600" : ""} />
          <Kpi label={t.pay.nextDue} value={st.nextDueDate ? `${formatDate(st.nextDueDate, intl)}` : "—"} sub={st.nextDueCents ? formatCents(st.nextDueCents, intl) : ""} />
        </div>

        {!cancelled && (
          <div className="px-5 pb-5">
            <h3 className="mb-2 text-sm font-bold text-ink-soft">{t.pay.schedule}</h3>
            <div className="table-wrap"><table className="tbl">
              <thead><tr><th>#</th><th>{t.pay.due}</th><th className="text-end">{t.pay.amount}</th><th className="text-end">{t.pay.paid}</th><th className="text-end">{t.pay.open}</th></tr></thead>
              <tbody>{st.schedule.map((r, i) => {
                const late = r.openCents > 0 && r.dueDate < today;
                return (
                  <tr key={i} className={late ? "bg-red-50/60" : ""}>
                    <td className="text-ink-soft">{i + 1}</td>
                    <td className={late ? "font-semibold text-red-700" : ""}>{formatDate(r.dueDate, intl)}</td>
                    <td className="num text-end">{formatCents(r.amountCents, intl)}</td>
                    <td className="num text-end text-brand-700">{r.paidCents ? formatCents(r.paidCents, intl) : ""}</td>
                    <td className="num text-end font-semibold">{r.openCents ? formatCents(r.openCents, intl) : <Icon name="check" className="ms-auto h-4 w-4 text-brand-600" />}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </div>
        )}

        <div className="px-5 pb-5">
          <h3 className="mb-2 text-sm font-bold text-ink-soft">{t.pay.payments}</h3>
          {payments.length === 0 ? <p className="text-sm text-ink-soft">{t.pay.noPayments}</p> : (
            <ul className="divide-y divide-black/5 rounded-xl ring-1 ring-black/5">
              {payments.map((p) => (
                <li key={p.id} className={`px-4 py-3 text-sm ${p.cancelledAt ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="num font-bold" dir="ltr">{p.number}</span>
                      <span className="text-ink-soft">{formatDate(p.date, intl)} · {t.pay.methods[p.method]}</span>
                      {p.movedFromInvoiceId && <span className="badge bg-slate-100 text-slate-600">{t.pay.sinceMoved}</span>}
                      {p.cancelledAt && <span className="badge bg-red-100 text-red-700">{t.pay.cancelled}</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`num font-bold ${p.cancelledAt ? "line-through" : ""}`}>{formatCents(p.amountCents, intl)}</span>
                      {p.skontoCents > 0 && <span className={`badge bg-amber-100 text-amber-800 ${p.cancelledAt ? "line-through" : ""}`}>+ {t.pay.skontoGranted} <span className="num">{formatCents(p.skontoCents, intl)}</span></span>}
                      <a href={`/api/pdf/receipt/${p.id}`} target="_blank" className="text-xs font-semibold text-brand-700 hover:underline">{t.pay.receipt}</a>
                      {!p.cancelledAt && <CancelPayment t={t} invoiceId={inv.id} paymentId={p.id} />}
                    </div>
                  </div>
                  {(p.note || p.cancelReason) && <p className="mt-1 text-xs text-ink-soft">{p.cancelReason || p.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {dunnings.length > 0 && (
          <div className="px-5 pb-5">
            <h3 className="mb-2 text-sm font-bold text-ink-soft">{t.pay.dunningsDone}</h3>
            <ul className="divide-y divide-black/5 rounded-xl ring-1 ring-black/5">
              {dunnings.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
                  <span className="font-semibold">{t.pay.dunningLevels[d.level as 1 | 2 | 3]}</span>
                  <span className="text-ink-soft">{formatDate(d.date, intl)} · {t.pay.newDue}: {formatDate(d.newDueDate, intl)}{d.feeCents ? ` · ${t.pay.fee} ${formatCents(d.feeCents, intl)}` : ""}</span>
                  <span className="num font-semibold">{formatCents(d.openCents + d.feeCents, intl)}</span>
                  <a href={`/api/pdf/dunning/${d.id}`} target="_blank" className="text-xs font-semibold text-brand-700 hover:underline">PDF</a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {!cancelled && (
        <aside className="h-fit space-y-4">
          {st.openCents > 0 && (
            <div className="card animate-rise space-y-2 p-5">
              <h3 className="font-bold">{t.pay.add}</h3>
              <AddPayment t={t} invoiceId={inv.id} suggestCents={st.overdueCents || st.nextDueCents || st.openCents} today={today} skonto={skonto} />
            </div>
          )}
          {st.overdueCents > 0 && (
            <div className="card animate-rise space-y-2 p-5">
              <h3 className="font-bold">{t.pay.dunning}</h3>
              <DunningButton t={t} invoiceId={inv.id} nextLevel={nextLevel} />
            </div>
          )}
          {st.openCents > 0 && (
            <details className="card animate-rise group/d p-5">
              <summary className="cursor-pointer list-none font-bold">{t.pay.editPlan}</summary>
              <div className="mt-3"><PlanForm t={t} invoiceId={inv.id} grossCents={inv.grossCents} plan={plan} today={today} intl={intl} /></div>
            </details>
          )}
        </aside>
      )}
    </section>
  );
}

function Kpi({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-black/5">
      <div className="text-xs text-ink-soft">{label}</div>
      <div className={`num text-lg font-bold ${tone}`}>{value}</div>
      {sub && <div className="num text-xs text-ink-soft">{sub}</div>}
    </div>
  );
}
