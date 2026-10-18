"use client";
import { useActionState } from "react";
import { createPackageAction, sendPackageAction, unlockAction } from "./actions";
import { ErrorBox, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

export function CreatePackage({ t, month, canLock, mail, advisorEmail }: { t: Dict; month: string; canLock: boolean; mail: boolean; advisorEmail: string }) {
  const [state, action] = useActionState(createPackageAction, undefined);
  const msg = state?.error === "notPast" ? t.rep.notPast : state?.error ? t.common.error : undefined;
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4">
        <input type="hidden" name="month" value={month} />
        {canLock && (
          <label className="flex cursor-pointer items-start gap-2 text-sm font-semibold">
            <input type="checkbox" name="lock" className="mt-0.5 h-5 w-5 accent-brand-600" />{t.rep.lockAfter}
          </label>
        )}
        <ErrorBox message={msg} />
        <SubmitButton className="btn-primary w-full py-3"><Icon name="download" className="h-4 w-4" />{t.rep.download}</SubmitButton>
      </form>
      {state?.ok && (
        <div className="animate-rise space-y-3 rounded-xl bg-brand-50 p-4 ring-1 ring-brand-100">
          <div className="flex items-center gap-2 font-bold text-brand-800"><Icon name="check" className="h-5 w-5" />{t.rep.ready} · {state.ok.bookings} {t.rep.bookings}</div>
          {state.ok.missingReceipts > 0 && <p className="text-sm font-semibold text-amber-800">{t.rep.missingReceipts.replace("{n}", String(state.ok.missingReceipts))}</p>}
          <a href={`/api/files/${state.ok.fileId}`} download={state.ok.name} className="btn-primary group w-full"><Icon name="download" className="h-4 w-4" />{state.ok.name}</a>
          {mail && <SendForm t={t} fileId={state.ok.fileId} advisorEmail={advisorEmail} />}
        </div>
      )}
    </div>
  );
}

export function SendForm({ t, fileId, advisorEmail }: { t: Dict; fileId: string; advisorEmail: string }) {
  const [state, action] = useActionState(sendPackageAction, undefined);
  if (state?.ok) return <p className="flex items-center gap-2 text-sm font-semibold text-brand-700"><Icon name="check" className="h-4 w-4" />{t.rep.sent}</p>;
  return (
    <form action={action} className="flex gap-2">
      <input type="hidden" name="fileId" value={fileId} />
      <input name="to" type="email" required defaultValue={advisorEmail} placeholder={t.rep.sendTo} dir="ltr" className="input" />
      <SubmitButton className="btn-ghost shrink-0"><Icon name="mail" className="h-4 w-4" />{t.rep.send}</SubmitButton>
      {state?.error && <span className="text-xs font-semibold text-red-600">{t.common.error}</span>}
    </form>
  );
}

export function UnlockButton({ t, month }: { t: Dict; month: string }) {
  return (
    <form action={unlockAction} onSubmit={(e) => { if (!confirm(t.rep.unlockConfirm)) e.preventDefault(); }}>
      <input type="hidden" name="month" value={month} />
      <button className="btn-ghost group text-sm"><Icon name="lock" className="h-4 w-4" />{t.rep.unlock}</button>
    </form>
  );
}
