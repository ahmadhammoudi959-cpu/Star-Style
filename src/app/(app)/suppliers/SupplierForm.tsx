"use client";
import { useActionState } from "react";
import { saveSupplier } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import type { Dict } from "@/i18n/de";

type S = { id?: string; name: string; contact: string; email: string; phone: string; street: string; zip: string; city: string; country: string; vatId: string; notes: string };

export function SupplierForm({ t, initial }: { t: Dict; initial: S }) {
  const [state, action] = useActionState(saveSupplier, undefined);
  return (
    <form action={action} className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <div className="md:col-span-2"><ErrorBox message={state?.error ? t.common.required : undefined} /></div>
      <Field label={t.supplier.name}><input name="name" defaultValue={initial.name} required className="input" /></Field>
      <Field label={t.supplier.contact}><input name="contact" defaultValue={initial.contact} className="input" /></Field>
      <Field label={t.supplier.email}><input name="email" type="email" defaultValue={initial.email} className="input" dir="ltr" /></Field>
      <Field label={t.supplier.phone}><input name="phone" defaultValue={initial.phone} className="input" dir="ltr" /></Field>
      <Field label={t.setup.street}><input name="street" defaultValue={initial.street} className="input" /></Field>
      <div className="grid grid-cols-[1fr_2fr_1fr] gap-3">
        <Field label={t.setup.zip}><input name="zip" defaultValue={initial.zip} className="input" dir="ltr" /></Field>
        <Field label={t.setup.city}><input name="city" defaultValue={initial.city} className="input" /></Field>
        <Field label={t.supplier.country}><input name="country" defaultValue={initial.country} maxLength={2} className="input uppercase" dir="ltr" /></Field>
      </div>
      <Field label={t.supplier.vatId}><input name="vatId" defaultValue={initial.vatId} className="input" dir="ltr" /></Field>
      <Field label={t.common.note}><input name="notes" defaultValue={initial.notes} className="input" /></Field>
      <div className="flex justify-end md:col-span-2"><SubmitButton className="btn-primary px-8">{t.common.save}</SubmitButton></div>
    </form>
  );
}
