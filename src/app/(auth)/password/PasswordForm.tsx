"use client";
import { useActionState } from "react";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { logout } from "@/app/actions-auth";
import type { Dict } from "@/i18n/de";
import { setFirstPasswordAction } from "./actions";

export function PasswordForm({ t, name }: { t: Dict; name: string }) {
  const P = t.password;
  const [state, action] = useActionState(setFirstPasswordAction, undefined);
  const err = state?.error === "long" ? t.security.errors.long : state?.error ? ((P.errors as Record<string, string>)[state.error] ?? P.errors.error) : undefined;
  return (
    <div className="space-y-3">
      <form action={action} className="card space-y-5 p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="key" className="icon-pop h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{P.title}</h2>
            <p className="text-sm font-semibold" dir="auto">{name}</p>
            <p className="text-sm text-ink-soft">{P.hint}</p>
          </div>
        </div>
        <ErrorBox message={err} />
        <Field label={P.new} hint={t.security.password.hint}>
          <input name="next" type="password" required minLength={10} className="input" dir="ltr" autoComplete="new-password" autoFocus />
        </Field>
        <Field label={P.repeat}>
          <input name="repeat" type="password" required minLength={10} className="input" dir="ltr" autoComplete="new-password" />
        </Field>
        <SubmitButton>{P.save}</SubmitButton>
      </form>
      <form action={logout} className="text-center">
        <button className="btn-ghost group gap-2 text-sm"><Icon name="logout" className="h-4 w-4" />{t.common.logout}</button>
      </form>
    </div>
  );
}
