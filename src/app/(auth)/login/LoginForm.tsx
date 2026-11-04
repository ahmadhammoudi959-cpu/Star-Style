"use client";
import { useActionState, useEffect, useState } from "react";
import { login, verifyCode } from "@/app/actions-auth";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

/** Anmeldung in zwei Schritten: E-Mail + Passwort, dann (wenn eingeschaltet) der Code vom Handy */
export function LoginForm({ t }: { t: Dict }) {
  const L = t.login;
  const [state, action] = useActionState(login, undefined);
  const [codeState, codeAction] = useActionState(verifyCode, undefined);
  const [stage, setStage] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string>();
  const [recovery, setRecovery] = useState(false);

  useEffect(() => { if (state?.step === "code") { setStage("code"); setNotice(undefined); setRecovery(false); } }, [state]);
  useEffect(() => {
    if (codeState?.error === "expired" || codeState?.error === "locked") {
      setStage("password");
      setNotice(codeState.error === "expired" ? L.expired : L.locked.replace("{min}", String(codeState.minutes ?? 15)));
    }
  }, [codeState, L]);

  const passwordError = state?.error === "locked" ? L.locked.replace("{min}", String(state.minutes ?? 15)) : state?.error ? L.invalid : undefined;

  if (stage === "code") {
    return (
      <form action={codeAction} className="card space-y-4 p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"><Icon name="phone" className="icon-pop h-5 w-5" /></span>
          <h2 className="text-lg font-bold">{L.codeTitle}</h2>
        </div>
        <p className="text-sm text-ink-soft">{recovery ? L.recoveryHint : L.codeHint}</p>
        <ErrorBox message={codeState?.error === "code" ? L.codeInvalid : undefined} />
        <Field label={recovery ? L.recoveryLabel : L.code}>
          {recovery
            ? <input key="r" name="code" autoComplete="off" autoCapitalize="off" spellCheck={false} required maxLength={20} dir="ltr" autoFocus
                className="input text-center font-mono text-xl font-bold tracking-widest" placeholder="xxxxx-xxxxx" />
            : <input key="c" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" required maxLength={7} dir="ltr" autoFocus
                className="input text-center text-2xl font-bold tracking-[0.4em]" placeholder="000000" />}
        </Field>
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" name="remember" value="1" className="mt-0.5 h-5 w-5 shrink-0 accent-brand-600" />{L.remember}
        </label>
        <SubmitButton>{L.verify}</SubmitButton>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <button type="button" className="font-semibold text-brand-700 underline underline-offset-2" onClick={() => setRecovery(!recovery)}>{recovery ? L.useApp : L.useRecovery}</button>
          <button type="button" className="text-ink-soft underline underline-offset-2" onClick={() => setStage("password")}>{t.common.back}</button>
        </div>
      </form>
    );
  }

  return (
    <form action={action} onSubmit={() => setNotice(undefined)} className="card space-y-4 p-6">
      <h2 className="text-lg font-bold">{L.title}</h2>
      {notice && <div role="alert" className="animate-rise rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200">{notice}</div>}
      <ErrorBox message={notice ? undefined : passwordError} />
      <Field label={L.email}><input name="email" type="email" autoComplete="username" required className="input" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label={L.password}><input name="password" type="password" autoComplete="current-password" required className="input" dir="ltr" /></Field>
      <SubmitButton>{L.submit}</SubmitButton>
    </form>
  );
}
