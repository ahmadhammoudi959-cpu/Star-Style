"use client";
import { useActionState, useState } from "react";
import { saveCustomer } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import type { Dict } from "@/i18n/de";

export type CustomerData = {
  id?: string; type: "COMPANY" | "PERSON"; name: string; contact: string; email: string; phone: string; street: string; zip: string;
  city: string; country: string; vatId: string; vatIdStatus: string; priceGroup: "WHOLESALE" | "RETAIL"; creditLimit: string; paymentTermDays: string; notes: string;
};

export function CustomerForm({ t, initial }: { t: Dict; initial: CustomerData }) {
  const [state, action] = useActionState(saveCustomer, undefined);
  const [type, setType] = useState(initial.type);
  const [country, setCountry] = useState(initial.country);
  const [vatId, setVatId] = useState(initial.vatId);
  const foreignEu = country.toUpperCase() !== "DE";
  return (
    <form action={action} className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="type" value={type} />
      <div className="md:col-span-2"><ErrorBox message={state?.error === "vatFormat" ? `${t.customer.vatId}: DE123456789 / NL123456789B01` : state?.error ? t.common.required : undefined} /></div>
      <div className="flex gap-2 md:col-span-2">
        {(["COMPANY", "PERSON"] as const).map((k) => (
          <button type="button" key={k} onClick={() => setType(k)}
            className={`btn ${type === k ? "bg-brand-600 text-white shadow-card" : "bg-white ring-1 ring-black/10 hover:bg-brand-50"}`}>{t.customer[k]}</button>
        ))}
      </div>
      <Field label={t.customer.name}><input name="name" defaultValue={initial.name} required className="input" /></Field>
      <Field label={t.customer.contact}><input name="contact" defaultValue={initial.contact} className="input" /></Field>
      <Field label={t.supplier.email}><input name="email" type="email" defaultValue={initial.email} className="input" dir="ltr" /></Field>
      <Field label={t.supplier.phone}><input name="phone" defaultValue={initial.phone} className="input" dir="ltr" /></Field>
      <Field label={t.setup.street}><input name="street" defaultValue={initial.street} className="input" /></Field>
      <div className="grid grid-cols-[minmax(0,1fr)_2fr_1fr] gap-3">
        <Field label={t.setup.zip}><input name="zip" defaultValue={initial.zip} className="input" dir="ltr" /></Field>
        <Field label={t.setup.city}><input name="city" defaultValue={initial.city} className="input" /></Field>
        <Field label={t.supplier.country}><input name="country" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} required maxLength={2} className="input uppercase" dir="ltr" /></Field>
      </div>
      {type === "COMPANY" && (
        <div className="space-y-2">
          <Field label={t.customer.vatId}><input name="vatId" value={vatId} onChange={(e) => setVatId(e.target.value)} className="input" dir="ltr" placeholder={foreignEu ? "NL123456789B01" : "DE123456789"} /></Field>
          {foreignEu && !vatId && (
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input type="checkbox" name="vatPending" defaultChecked={initial.vatIdStatus === "PENDING"} className="h-5 w-5 accent-brand-600" />{t.customer.vatPending}
            </label>
          )}
        </div>
      )}
      <Field label={t.customer.priceGroup}>
        <select name="priceGroup" defaultValue={initial.priceGroup} className="input">
          <option value="WHOLESALE">{t.customer.WHOLESALE}</option><option value="RETAIL">{t.customer.RETAIL}</option>
        </select>
      </Field>
      <Field label={`${t.customer.creditLimit} (€, ${t.common.optional})`}><input name="creditLimit" defaultValue={initial.creditLimit} inputMode="decimal" className="input num" dir="ltr" /></Field>
      <Field label={`${t.customer.paymentDays} (${t.common.optional})`}><input name="paymentTermDays" type="number" min={0} defaultValue={initial.paymentTermDays} className="input num" /></Field>
      <Field label={t.common.note} className="md:col-span-2"><textarea name="notes" rows={2} defaultValue={initial.notes} className="input" /></Field>
      <div className="flex justify-end md:col-span-2"><SubmitButton className="btn-primary px-8">{t.common.save}</SubmitButton></div>
    </form>
  );
}
