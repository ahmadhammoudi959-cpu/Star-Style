"use client";
import { useActionState, useState } from "react";
import { saveCustomer } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import type { Dict } from "@/i18n/de";
import { validEmail } from "@/lib/shopify/b2b-email";

export type CustomerData = {
  id?: string; type: "COMPANY" | "PERSON"; name: string; contact: string; email: string; phone: string; street: string; zip: string;
  city: string; country: string; vatId: string; vatIdStatus: string; priceGroup: "WHOLESALE" | "RETAIL"; creditLimit: string; paymentTermDays: string; notes: string;
  /** sieht im allgemeinen Shop die جملة الجملة-Preise (Shopify B2B, Wunsch Inhaber 12.11.2026) */
  shopReseller?: boolean;
};

/** credit = Kreditlimit/Zahlungsziel, reseller = Großhandelspreise im Shop freischalten (ohne Recht: Feld weg, Server behält den alten Wert) */
export function CustomerForm({ t, initial, rights = { credit: true, reseller: true }, returnTo }: { t: Dict; initial: CustomerData; rights?: { credit: boolean; reseller: boolean }; returnTo?: string }) {
  const [state, action] = useActionState(saveCustomer, undefined);
  const [type, setType] = useState(initial.type);
  const [country, setCountry] = useState(initial.country);
  const [vatId, setVatId] = useState(initial.vatId);
  const [email, setEmail] = useState(initial.email);
  const [group, setGroup] = useState(initial.priceGroup);
  const [reseller, setReseller] = useState(Boolean(initial.shopReseller));
  const emailOk = validEmail(email);
  const foreignEu = country.toUpperCase() !== "DE";
  // nach einem Fehler die getippten Werte behalten (React 19 setzt das Formular zurück, dann gilt defaultValue)
  const v = (k: "name" | "contact" | "phone" | "street" | "zip" | "city" | "creditLimit" | "paymentTermDays" | "notes") => state?.values?.[k] ?? initial[k];
  const errors: Record<string, string> = {
    vatFormat: `${t.customer.vatId}: DE123456789 / NL123456789B01`, vatDe: t.customer.vatDe, zipDe: t.customer.zipDe, resellerEmail: t.customer.resellerEmail,
  };
  return (
    <form action={action} className="card grid grid-cols-2 gap-3 p-4 animate-rise sm:p-5 md:gap-4">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
      <input type="hidden" name="type" value={type} />
      <div className="col-span-2"><ErrorBox message={state?.error ? errors[state.error] ?? t.common.required : undefined} /></div>
      <div className="col-span-2 flex gap-2">
        {(["COMPANY", "PERSON"] as const).map((k) => (
          <button type="button" key={k} onClick={() => setType(k)}
            className={`btn ${type === k ? "bg-brand-600 text-white shadow-card" : "bg-white ring-1 ring-black/10 hover:bg-brand-50"}`}>{t.customer[k]}</button>
        ))}
      </div>
      <Field label={t.customer.name} className="col-span-2 md:col-span-1"><input name="name" defaultValue={v("name")} required className="input" /></Field>
      <Field label={t.customer.contact} className="col-span-2 md:col-span-1"><input name="contact" defaultValue={v("contact")} className="input" /></Field>
      <Field label={t.supplier.email}><input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="input" dir="ltr" /></Field>
      <Field label={t.supplier.phone}><input name="phone" defaultValue={v("phone")} className="input" dir="ltr" /></Field>
      <Field label={t.setup.street} className="col-span-2 md:col-span-1"><input name="street" defaultValue={v("street")} className="input" /></Field>
      <div className="col-span-2 grid grid-cols-[minmax(0,1fr)_2fr_1fr] gap-3 md:col-span-1">
        <Field label={t.setup.zip}><input name="zip" defaultValue={v("zip")} inputMode={foreignEu ? undefined : "numeric"} className="input" dir="ltr" /></Field>
        <Field label={t.setup.city}><input name="city" defaultValue={v("city")} className="input" /></Field>
        <Field label={t.supplier.country}><input name="country" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} required maxLength={2} className="input uppercase" dir="ltr" /></Field>
      </div>
      {type === "COMPANY" && (
        <div className="col-span-2 space-y-2 md:col-span-1">
          <Field label={t.customer.vatId}><input name="vatId" value={vatId} onChange={(e) => setVatId(e.target.value)} className="input" dir="ltr" placeholder={foreignEu ? "NL123456789B01" : "DE123456789"} /></Field>
          {foreignEu && !vatId && (
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input type="checkbox" name="vatPending" defaultChecked={initial.vatIdStatus === "PENDING"} className="h-5 w-5 accent-brand-600" />{t.customer.vatPending}
            </label>
          )}
        </div>
      )}
      <Field label={t.customer.priceGroup}>
        <select name="priceGroup" value={group} onChange={(e) => setGroup(e.target.value as "WHOLESALE" | "RETAIL")} className="input">
          <option value="WHOLESALE">{t.customer.WHOLESALE}</option><option value="RETAIL">{t.customer.RETAIL}</option>
        </select>
      </Field>
      {rights.credit && <>
        <Field label={`${t.customer.creditLimit} (€, ${t.common.optional})`}><input name="creditLimit" defaultValue={v("creditLimit")} inputMode="decimal" className="input num" dir="ltr" /></Field>
        <Field label={`${t.customer.paymentDays} (${t.common.optional})`}><input name="paymentTermDays" type="number" min={0} defaultValue={v("paymentTermDays")} className="input num" /></Field>
      </>}
      {/* جملة الجملة-Kunde sieht im allgemeinen Shop seine Preise – verbunden über die E-Mail (Wunsch Inhaber 12.11.2026) */}
      {rights.reseller && group === "WHOLESALE" && (
        <label className={`col-span-2 flex items-start gap-2 rounded-xl p-3 text-sm ring-1 ${emailOk ? "cursor-pointer bg-brand-50/60 ring-brand-100" : "bg-slate-50 ring-black/5"}`}>
          <input type="checkbox" name="shopReseller" checked={reseller && emailOk} disabled={!emailOk} onChange={(e) => setReseller(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600" />
          <span className="min-w-0">
            <span className="font-semibold">{t.customer.shopReseller}</span>
            <span className="block text-xs text-ink-soft [overflow-wrap:anywhere]">{emailOk ? t.customer.shopResellerHint.replace("{email}", email.trim().toLowerCase()) : t.customer.shopResellerNoEmail}</span>
          </span>
        </label>
      )}
      <Field label={t.common.note} className="col-span-2"><textarea name="notes" rows={2} defaultValue={v("notes")} className="input" /></Field>
      <div className="col-span-2 flex justify-end"><SubmitButton className="btn-primary px-8">{t.common.save}</SubmitButton></div>
    </form>
  );
}
