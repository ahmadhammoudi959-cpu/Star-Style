"use client";
import { useActionState } from "react";
import Link from "next/link";
import { saveSettings } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

export function SettingsForm({ t, s }: { t: Dict; s: Record<string, string | number | null> }) {
  const [state, action] = useActionState(saveSettings, undefined);
  const v = (k: string) => String(s[k] ?? "");
  return (
    <form action={action} className="space-y-5">
      <ErrorBox message={state?.error === "logoType" ? t.settings.logoType : state?.error === "datev" ? `${t.settings.consultant} / ${t.settings.client}` : state?.error ? t.common.required : undefined} />
      {state?.ok && <p className="flex animate-rise items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700"><Icon name="check" className="h-4 w-4" />{t.common.saved}</p>}
      <section className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
        <h2 className="text-lg font-bold md:col-span-2">{t.settings.company}</h2>
        <div className="flex flex-wrap items-center gap-4 rounded-xl bg-brand-50/50 p-4 ring-1 ring-brand-100 md:col-span-2">
          <div className="grid h-20 w-40 place-items-center overflow-hidden rounded-lg bg-white ring-1 ring-black/5">
            {s.logoFileId ? <img src={`/api/files/${s.logoFileId}`} alt="Logo" className="max-h-full max-w-full object-contain" /> : <Icon name="receipt" className="h-8 w-8 text-ink-soft/40" />}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <Field label={t.settings.logo}><input type="file" name="logo" accept="image/png,image/jpeg" className="input file:me-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:font-semibold file:text-brand-700" /></Field>
            <p className="text-xs text-ink-soft">{t.settings.logoHint}</p>
            {s.logoFileId && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="removeLogo" className="h-4 w-4 accent-red-600" />{t.settings.removeLogo}</label>}
          </div>
        </div>
        <Field label={t.setup.companyName}><input name="name" defaultValue={v("name")} required className="input" /></Field>
        <Field label={t.settings.owner}><input name="owner" defaultValue={v("owner")} className="input" /></Field>
        <Field label={t.setup.street}><input name="street" defaultValue={v("street")} className="input" /></Field>
        <div className="grid grid-cols-[minmax(0,1fr)_2fr_1fr] gap-3">
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
      <section id="datev" className="card grid scroll-mt-6 gap-4 p-5 md:grid-cols-3 animate-rise">
        <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-3">
          <h2 className="text-lg font-bold">{t.settings.datev}</h2>
          <Link href="/settings/accounts" className="text-sm font-semibold text-brand-700 hover:underline">{t.settings.accounts} →</Link>
        </div>
        <Field label={t.settings.consultant} hint={t.settings.datevHint}><input name="datevConsultant" inputMode="numeric" defaultValue={v("datevConsultant")} maxLength={7} className="input num" dir="ltr" /></Field>
        <Field label={t.settings.client}><input name="datevClient" inputMode="numeric" defaultValue={v("datevClient")} maxLength={5} className="input num" dir="ltr" /></Field>
        <Field label={t.settings.chart}>
          <select name="chartOfAccounts" defaultValue={v("chartOfAccounts") || "SKR03"} className="input"><option value="SKR03">SKR 03</option><option value="SKR04">SKR 04</option></select>
        </Field>
        <Field label={t.settings.fyStart}>
          <select name="fiscalYearStartMonth" defaultValue={v("fiscalYearStartMonth") || "1"} className="input">
            {t.rep.months.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </Field>
        <Field label={t.settings.advisorEmail} className="md:col-span-2"><input name="advisorEmail" type="email" defaultValue={v("advisorEmail")} className="input" dir="ltr" /></Field>
      </section>
      <div className="flex justify-end"><SubmitButton className="btn-primary px-8 py-3">{t.common.save}</SubmitButton></div>
    </form>
  );
}
