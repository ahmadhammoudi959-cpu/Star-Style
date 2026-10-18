"use client";
import { useActionState } from "react";
import { setup } from "@/app/actions-auth";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import type { Dict } from "@/i18n/de";

export function SetupForm({ t }: { t: Dict }) {
  const [state, action] = useActionState(setup, undefined);
  const err = state?.error === "alreadyDone" ? t.setup.alreadyDone : state?.error ? t.common.required : undefined;
  return (
    <form action={action} className="card space-y-5 p-6">
      <div>
        <h2 className="text-lg font-bold">{t.setup.title}</h2>
        <p className="text-sm text-ink-soft">{t.setup.intro}</p>
      </div>
      <ErrorBox message={err} />
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-bold text-brand-700">{t.setup.account}</legend>
        <Field label={t.setup.name}><input name="name" required minLength={2} className="input" /></Field>
        <Field label={t.login.email}><input name="email" type="email" required className="input" dir="ltr" /></Field>
        <Field label={t.login.password} hint={t.setup.passwordHint}><input name="password" type="password" required minLength={10} className="input" dir="ltr" autoComplete="new-password" /></Field>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-bold text-brand-700">{t.setup.company}</legend>
        <Field label={t.setup.companyName}><input name="companyName" required minLength={2} className="input" /></Field>
        <Field label={t.setup.vatId}><input name="vatId" className="input" dir="ltr" placeholder="DE123456789" /></Field>
        <Field label={t.setup.street}><input name="street" className="input" /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t.setup.zip}><input name="zip" className="input" dir="ltr" /></Field>
          <Field label={t.setup.city} className="col-span-2"><input name="city" className="input" /></Field>
        </div>
      </fieldset>
      <SubmitButton>{t.setup.submit}</SubmitButton>
    </form>
  );
}
