"use client";
import { useActionState, useState } from "react";
import { saveSupplier } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import type { Dict } from "@/i18n/de";

type Kind = "GOODS" | "EXPENSE";
type S = { id?: string; name: string; contact: string; email: string; phone: string; street: string; zip: string; city: string; country: string; vatId: string; notes: string; kind?: Kind };

export function SupplierForm({ t, initial }: { t: Dict; initial: S }) {
  const [state, action] = useActionState(saveSupplier, undefined);
  const [kind, setKind] = useState<Kind>(initial.kind ?? "GOODS");
  return (
    <form action={action} className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="md:col-span-2"><ErrorBox message={state?.error ? t.common.required : undefined} /></div>
      <Field label={t.supplier.name}><input name="name" defaultValue={initial.name} required className="input" /></Field>
      <Field label={t.supplier.contact}><input name="contact" defaultValue={initial.contact} className="input" /></Field>
      <Field label={t.supplier.email}><input name="email" type="email" defaultValue={initial.email} className="input" dir="ltr" /></Field>
      <Field label={t.supplier.phone}><input name="phone" defaultValue={initial.phone} className="input" dir="ltr" /></Field>
      <Field label={t.setup.street}><input name="street" defaultValue={initial.street} className="input" /></Field>
      <div className="grid grid-cols-[minmax(0,1fr)_2fr_1fr] gap-3">
        <Field label={t.setup.zip}><input name="zip" defaultValue={initial.zip} className="input" dir="ltr" /></Field>
        <Field label={t.setup.city}><input name="city" defaultValue={initial.city} className="input" /></Field>
        <Field label={t.supplier.country}><input name="country" defaultValue={initial.country} maxLength={2} className="input uppercase" dir="ltr" /></Field>
      </div>
      <Field label={t.supplier.vatId}><input name="vatId" defaultValue={initial.vatId} className="input" dir="ltr" /></Field>
      <Field label={t.common.note}><input name="notes" defaultValue={initial.notes} className="input" /></Field>
      {/* Warenlieferant oder Firma aus Ausgaben: entscheidet nur, wo die Firma in der Oberfläche steht */}
      <fieldset className="md:col-span-2">
        <legend className="label">{t.supplier.kind}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["GOODS", "EXPENSE"] as const).map((k) => (
            <label key={k} className={`flex cursor-pointer items-start gap-3 rounded-xl p-3 ring-1 transition ${kind === k ? "bg-brand-50 ring-brand-300" : "ring-slate-200 hover:bg-slate-50"}`}>
              <input type="radio" name="kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="mt-1 h-4 w-4 accent-brand-600" />
              <span className="min-w-0">
                <span className="block font-semibold">{t.supplier.kinds[k]}</span>
                <span className="block text-xs text-ink-soft">{t.supplier.kindHints[k]}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-ink-soft">{t.supplier.kindNote}</p>
      </fieldset>
      <div className="flex justify-end md:col-span-2"><SubmitButton className="btn-primary px-8">{t.common.save}</SubmitButton></div>
    </form>
  );
}
