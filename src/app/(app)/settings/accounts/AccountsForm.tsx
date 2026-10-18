"use client";
import { useActionState, useState } from "react";
import { saveAccountsAction } from "../actions";
import { ErrorBox, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

export function AccountsForm({ t, rows }: { t: Dict; rows: { key: string; label: string; standard: number; value: number | null }[] }) {
  const [state, action] = useActionState(saveAccountsAction, undefined);
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(rows.map((r) => [r.key, r.value ? String(r.value) : ""])));
  return (
    <form action={action} className="space-y-4">
      <ErrorBox message={state?.error ? t.common.error : undefined} />
      {state?.ok && <p className="flex animate-rise items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700"><Icon name="check" className="h-4 w-4" />{t.common.saved}</p>}
      <div className="card animate-rise overflow-hidden"><div className="table-wrap"><table className="tbl">
        <thead><tr><th></th><th className="text-end">{t.settings.standard}</th><th className="w-40"></th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key}>
            <td dir="ltr" className="text-start">{r.label}</td>
            <td className="num text-end text-ink-soft">{r.standard}</td>
            <td><input name={`acc_${r.key}`} value={vals[r.key]} onChange={(e) => setVals({ ...vals, [r.key]: e.target.value.replace(/\D/g, "") })} inputMode="numeric" maxLength={8} placeholder={String(r.standard)} dir="ltr" className={`input num py-1.5 ${vals[r.key] ? "ring-2 ring-amber-300" : ""}`} /></td>
          </tr>
        ))}</tbody>
      </table></div></div>
      <div className="flex justify-between">
        <button type="button" onClick={() => setVals(Object.fromEntries(rows.map((r) => [r.key, ""])))} className="btn-ghost">{t.settings.resetAll}</button>
        <SubmitButton className="btn-primary px-8">{t.common.save}</SubmitButton>
      </div>
    </form>
  );
}
