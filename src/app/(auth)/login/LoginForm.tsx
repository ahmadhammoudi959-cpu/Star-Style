"use client";
import { useActionState } from "react";
import { login } from "@/app/actions-auth";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import type { Dict } from "@/i18n/de";

export function LoginForm({ t }: { t: Dict }) {
  const [state, action] = useActionState(login, undefined);
  return (
    <form action={action} className="card space-y-4 p-6">
      <h2 className="text-lg font-bold">{t.login.title}</h2>
      <ErrorBox message={state?.error ? t.login.invalid : undefined} />
      <Field label={t.login.email}><input name="email" type="email" autoComplete="username" required className="input" dir="ltr" /></Field>
      <Field label={t.login.password}><input name="password" type="password" autoComplete="current-password" required className="input" dir="ltr" /></Field>
      <SubmitButton>{t.login.submit}</SubmitButton>
    </form>
  );
}
