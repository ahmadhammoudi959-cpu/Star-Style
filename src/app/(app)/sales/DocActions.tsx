"use client";
import { useActionState, useState } from "react";
import { convertOfferAction, emailDocAction, invoiceAction, offerStatusAction } from "./actions";
import { ErrorBox } from "@/components/Forms";
import { Icon, type IconName } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

function Btn({ children, className, confirmText, pending }: { children: React.ReactNode; className: string; confirmText?: string; pending?: boolean }) {
  return (
    <button type="submit" disabled={pending} className={`${className} w-full justify-start`}
      onClick={(e) => { if (confirmText && !confirm(confirmText)) e.preventDefault(); }}>
      {children}
    </button>
  );
}

export function InvoiceOp({ t, id, op, label, icon, tone = "btn-ghost", confirmText }: { t: Dict; id: string; op: string; label: string; icon: IconName; tone?: string; confirmText?: string }) {
  const [state, action, pending] = useActionState(invoiceAction, undefined);
  const err = state?.error ? `${((t.sales as Record<string, unknown>)[state.error] as string) ?? t.common.error}${state.detail ? `: ${state.detail}` : ""}` : undefined;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="op" value={op} />
      <Btn className={`${tone} group`} confirmText={confirmText} pending={pending}><Icon name={icon} className="h-4 w-4" />{label}</Btn>
      <ErrorBox message={err} />
    </form>
  );
}

export function OfferOps({ t, id, status }: { t: Dict; id: string; status: string }) {
  const [state, action, pending] = useActionState(offerStatusAction, undefined);
  const [cState, cAction, cPending] = useActionState(convertOfferAction, undefined);
  const [via, setVia] = useState("");
  const err = state?.error || cState?.error ? t.common.error : undefined;
  return (
    <div className="space-y-2">
      <ErrorBox message={err} />
      {status === "DRAFT" && (
        <form action={action}><input type="hidden" name="id" value={id} /><input type="hidden" name="status" value="SENT" />
          <Btn className="btn-ghost group" pending={pending}><Icon name="check" className="h-4 w-4" />{t.sales.send}</Btn></form>
      )}
      {(status === "DRAFT" || status === "SENT") && (
        <form action={action} className="space-y-2 rounded-xl bg-brand-50/60 p-3 ring-1 ring-brand-100">
          <input type="hidden" name="id" value={id} /><input type="hidden" name="status" value="ACCEPTED" />
          <input name="acceptedVia" value={via} onChange={(e) => setVia(e.target.value)} placeholder={t.sales.acceptedVia} className="input" />
          <Btn className="btn-primary group" pending={pending}><Icon name="check" className="h-4 w-4" />{t.sales.accept}</Btn>
        </form>
      )}
      {(status === "ACCEPTED" || status === "SENT" || status === "DRAFT") && (
        <form action={cAction}><input type="hidden" name="id" value={id} />
          <Btn className={status === "ACCEPTED" ? "btn-primary group" : "btn-ghost group"} pending={cPending}><Icon name="receipt" className="h-4 w-4" />{t.sales.toInvoice}</Btn></form>
      )}
      {(status === "DRAFT" || status === "SENT") && (
        <form action={action}><input type="hidden" name="id" value={id} /><input type="hidden" name="status" value="REJECTED" />
          <Btn className="btn-danger group" pending={pending}><Icon name="trash" className="h-4 w-4" />{t.sales.reject}</Btn></form>
      )}
    </div>
  );
}

export function EmailForm({ t, kind, id, defaultTo }: { t: Dict; kind: "offer" | "invoice"; id: string; defaultTo: string }) {
  const [state, action, pending] = useActionState(emailDocAction, undefined);
  return (
    <form action={action} className="space-y-2 rounded-xl bg-sky-50/60 p-3 ring-1 ring-sky-100">
      <input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} />
      <input name="to" type="email" defaultValue={defaultTo} required className="input" dir="ltr" placeholder="kunde@example.de" />
      <Btn className="btn-ghost group" pending={pending}>{pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" /> : <Icon name="check" className="h-4 w-4" />}{t.sales.email}</Btn>
      {state?.ok && <p className="text-xs font-semibold text-brand-700">✓ {t.common.saved}</p>}
      {state?.error && <p className="text-xs font-semibold text-red-700">{t.common.error}</p>}
    </form>
  );
}
