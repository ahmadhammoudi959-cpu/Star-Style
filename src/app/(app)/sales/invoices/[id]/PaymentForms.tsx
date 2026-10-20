"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { addPaymentAction, cancelPaymentAction, dunningAction, savePlanAction } from "../../pay-actions";
import { PlanEditor, fromPlanRows, toPlanRows } from "../../PlanEditor";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import type { Dict } from "@/i18n/de";

function Msg({ t, state }: { t: Dict; state: { error?: string; detail?: string; ok?: boolean } | undefined }) {
  if (!state?.error) return null;
  const m = (t.pay as Record<string, unknown>)[state.error] as string | undefined;
  return <p className="text-xs font-semibold text-red-600">{m ?? t.common.error}{(state.error === "overpay" || state.error === "skontoAmount") && state.detail ? ` (${formatCents(Number(state.detail))})` : ""}</p>;
}

const toInput = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export function AddPayment({ t, invoiceId, suggestCents, today, skonto }: {
  t: Dict; invoiceId: string; suggestCents: number; today: string; skonto?: { deadline: string; payCents: number } | null;
}) {
  const [state, action, pending] = useActionState(addPaymentAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  const [withSkonto, setWithSkonto] = useState(false);
  const [amount, setAmount] = useState(toInput(suggestCents));
  useEffect(() => { if (state?.ok) { ref.current?.reset(); setWithSkonto(false); } }, [state]);
  useEffect(() => { setAmount(toInput(withSkonto && skonto ? skonto.payCents : suggestCents)); }, [withSkonto, skonto, suggestCents]);
  return (
    <form ref={ref} action={action} className="space-y-2 rounded-xl bg-brand-50/60 p-3 ring-1 ring-brand-100">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="grid grid-cols-2 gap-2">
        <input name="amount" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} className="input num" aria-label={t.pay.amount} required />
        <input name="date" type="date" defaultValue={today} max={today} className="input" aria-label={t.common.date} required />
      </div>
      {skonto && (
        <label className="flex cursor-pointer items-start gap-2 rounded-lg bg-amber-50 p-2 text-sm ring-1 ring-amber-200">
          <input type="checkbox" name="withSkonto" checked={withSkonto} onChange={(e) => setWithSkonto(e.target.checked)} className="mt-0.5 h-5 w-5 accent-brand-600" />
          <span><span className="font-semibold">{t.pay.withSkonto}</span>
            <span className="block text-xs text-amber-800">{t.pay.skontoUntil} {skonto.deadline} · {t.pay.withSkontoHint}</span></span>
        </label>
      )}
      <select name="method" defaultValue="BANK" className="input" aria-label={t.pay.method}>
        {(["CASH", "BANK", "CARD", "ONLINE"] as const).map((m) => <option key={m} value={m}>{t.pay.methods[m]}</option>)}
      </select>
      <input name="note" placeholder={t.common.note} className="input" />
      <button disabled={pending} className="btn-primary group w-full">{pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="euro" className="h-4 w-4" />}{t.pay.add}</button>
      <Msg t={t} state={state} />
    </form>
  );
}

export function CancelPayment({ t, invoiceId, paymentId }: { t: Dict; invoiceId: string; paymentId: string }) {
  const [state, action, pending] = useActionState(cancelPaymentAction, undefined);
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-xs font-semibold text-red-600 hover:underline">{t.pay.cancel}</button>;
  return (
    <form action={action} className="mt-2 flex animate-rise gap-2">
      <input type="hidden" name="invoiceId" value={invoiceId} /><input type="hidden" name="paymentId" value={paymentId} />
      <input name="reason" required minLength={2} placeholder={t.pay.cancelReason} className="input py-1.5 text-sm" />
      <button disabled={pending} className="btn-danger px-3 py-1.5 text-xs">{t.common.confirm}</button>
      <Msg t={t} state={state} />
    </form>
  );
}

export function PlanForm({ t, invoiceId, grossCents, plan, today, intl }: { t: Dict; invoiceId: string; grossCents: number; plan: { dueDate: string; amountCents: number }[]; today: string; intl: string }) {
  const [state, action, pending] = useActionState(savePlanAction, undefined);
  const [rows, setRows] = useState(toPlanRows(plan));
  const p = fromPlanRows(rows);
  const ok = !rows.length || p.reduce((s, r) => s + r.amountCents, 0) === grossCents;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="plan" value={JSON.stringify(p)} />
      <PlanEditor t={t} grossCents={grossCents} rows={rows} setRows={setRows} today={today} intl={intl} />
      <div className="flex gap-2">
        <button disabled={pending || !ok} className="btn-primary flex-1">{t.pay.savePlan}</button>
        {plan.length > 0 && <button type="button" disabled={pending} onClick={() => setRows([])} className="btn-ghost">{t.pay.removePlan}</button>}
      </div>
      {state?.ok && <p className="text-xs font-semibold text-brand-700">✓ {t.common.saved}</p>}
      <Msg t={t} state={state} />
    </form>
  );
}

export function DunningButton({ t, invoiceId, nextLevel }: { t: Dict; invoiceId: string; nextLevel: 1 | 2 | 3 }) {
  const [state, action, pending] = useActionState(dunningAction, undefined);
  return (
    <form action={action}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <button disabled={pending} className="btn w-full justify-start bg-amber-500 text-white shadow-card hover:bg-amber-600 group"><Icon name="alert" className="h-4 w-4" />{t.pay.dunningLevels[nextLevel]}</button>
      <Msg t={t} state={state} />
    </form>
  );
}
