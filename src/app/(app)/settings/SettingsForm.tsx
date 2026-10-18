"use client";
import { useActionState } from "react";
import { saveSettings } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

export function SettingsForm({ t, s }: { t: Dict; s: Record<string, string | number | null> }) {
  const [state, action] = useActionState(saveSettings, undefined);
  const v = (k: string) => String(s[k] ?? "");
  return (
    <form action={action} className="space-y-5">
      <ErrorBox message={state?.error ? t.common.required : undefined} />
      {state?.ok && <p className="flex animate-rise items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700"><Icon name="check" className="h-4 w-4" />{t.common.saved}</p>}
      <section className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
        <h2 className="text-lg font-bold md:col-span-2">{t.settings.company}</h2>
        <Field label={t.setup.companyName}><input name="name" defaultValue={v("name")} required className="input" /></Field>
        <Field label={t.settings.owner}><input name="owner" defaultValue={v("owner")} className="input" /></Field>
        <Field label={t.setup.street}><input name="street" defaultValue={v("street")} className="input" /></Field>
        <div className="grid grid-cols-[1fr_2fr_1fr] gap-3">
          <Field label={t.setup.zip}><input name="zip" defaultValue={v("zip")} className="input" dir="ltr" /></Field>
          <Field label={t.setup.city}><input name="city" defaultValue={v("city")} className="input" /></Field>
          <Field label={t.supplier.country}><input name="country" defaultValue={v("country") || "DE"} maxLength={2} className="input uppercase" dir="ltr" /></Field>
        </div>
        <Field label={t.supplier.email}><input name="email" type="email" defaultValue={v("email")} className="input" dir="ltr" /></Field>
        <Field label={t.supplier.phone}><input name="phone" defaultValue={v("phone")} className="input" dir="ltr" /></Field>
        <Field label={t.settings.website}><input name="website" defaultValue={v("website")} className="input" dir="ltr" /></Field>
        <Field label={t.setup.vatId}><input name="vatId" defaultValue={v("vatId")} className="input" dir="ltr" /></Field>
        <Field label={t.settings.taxNumber}><input name="taxNumber" defaultValue={v("taxNumber")} className="input" dir="ltr" /></Field>
      </section>
      <section className="card grid gap-4 p-5 md:grid-cols-3 animate-rise">
        <h2 className="text-lg font-bold md:col-span-3">{t.settings.bank}</h2>
        <Field label={t.settings.bankName}><input name="bankName" defaultValue={v("bankName")} className="input" /></Field>
        <Field label={t.settings.iban}><input name="iban" defaultValue={v("iban")} className="input" dir="ltr" /></Field>
        <Field label={t.settings.bic}><input name="bic" defaultValue={v("bic")} className="input" dir="ltr" /></Field>
      </section>
      <section className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
        <h2 className="text-lg font-bold md:col-span-2">{t.settings.invoice}</h2>
        <Field label={t.settings.paymentDays}><input name="defaultPaymentDays" type="number" min={0} defaultValue={v("defaultPaymentDays") || "14"} className="input num" /></Field>
        <Field label={t.settings.offerDays}><input name="offerValidityDays" type="number" min={1} defaultValue={v("offerValidityDays") || "14"} className="input num" /></Field>
        <Field label={t.settings.footer} className="md:col-span-2"><textarea name="invoiceFooter" rows={3} defaultValue={v("invoiceFooter")} className="input" /></Field>
      </section>
      <div className="flex justify-end"><SubmitButton className="btn-primary px-8 py-3">{t.common.save}</SubmitButton></div>
    </form>
  );
}
