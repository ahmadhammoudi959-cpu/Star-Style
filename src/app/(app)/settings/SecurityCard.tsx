"use client";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import {
  cancelTwoFactorAction, changePasswordAction, confirmTwoFactorAction, disableTwoFactorAction, logoutOthersAction,
  newRecoveryCodesAction, startTwoFactorAction, type SecResult,
} from "./security-actions";

export type LogKey = "success" | "recovery" | "needCode" | "invalid" | "code" | "locked" | "changed";
export type SecurityView = {
  twoOn: boolean; twoSince: string | null; codesLeft: number;
  passwordChanged: string | null; dbInternal: boolean;
  log: { at: string; ok: boolean; key: LogKey; device: string; ip: string }[];
};

type S = Dict["security"];
const errText = (S: S, fallback: string, r?: SecResult) =>
  r?.error ? ((S.errors as Record<string, string>)[r.error] ?? fallback).replace("{min}", String(r.minutes ?? 15)) : undefined;

function Ok({ children }: { children: React.ReactNode }) {
  return <div role="status" className="flex animate-rise items-start gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />{children}</div>;
}

/** Sicherheit: Zwei-Schritt-Anmeldung, Passwort, andere Geräte abmelden, letzte Anmeldungen */
export function SecurityCard({ t, v }: { t: Dict; v: SecurityView }) {
  const S = t.security;
  const checks: { ok: boolean; text: string }[] = [
    { ok: true, text: S.checks.https },
    { ok: true, text: S.checks.guard },
    { ok: true, text: S.checks.headers },
    { ok: true, text: S.checks.sessions },
    { ok: v.dbInternal, text: v.dbInternal ? S.checks.dbInternal : S.checks.dbExternal },
    { ok: v.twoOn, text: v.twoOn ? S.checks.twoOn : S.checks.twoOff },
  ];
  return (
    <section id="security" className="card mt-5 scroll-mt-20 animate-rise p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Icon name="shield" className="icon-pop h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{S.title}</h2>
          <p className="text-sm text-ink-soft">{S.hint}</p>
        </div>
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {checks.map((c) => (
          <li key={c.text} className={`flex min-w-0 items-start gap-2 rounded-xl px-3 py-2 text-sm font-semibold ring-1 ${c.ok ? "bg-emerald-50/70 text-emerald-900 ring-emerald-100" : "bg-amber-50 text-amber-900 ring-amber-200"}`}>
            <Icon name={c.ok ? "check" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0">{c.text}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <TwoFactor t={t} v={v} />
        <div className="space-y-5">
          <Password t={t} v={v} />
          <Others t={t} />
        </div>
      </div>
      <Log t={t} v={v} />
    </section>
  );
}

function TwoFactor({ t, v }: { t: Dict; v: SecurityView }) {
  const S = t.security, T = S.two;
  const router = useRouter();
  const [setup, setSetup] = useState<SecResult | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"none" | "disable" | "newCodes">("none");
  const [startErr, setStartErr] = useState<string>();
  const [justOn, setJustOn] = useState(false);
  const [pending, start] = useTransition();
  const [conf, confirmAction] = useActionState(confirmTwoFactorAction, undefined);
  const [dis, disableAction] = useActionState(disableTwoFactorAction, undefined);
  const [nc, newCodesAction] = useActionState(newRecoveryCodesAction, undefined);

  useEffect(() => { if (conf?.ok && conf.codes) { setCodes(conf.codes); setSetup(null); setJustOn(true); } }, [conf]);
  useEffect(() => { if (dis?.ok) { setMode("none"); router.refresh(); } }, [dis, router]);
  useEffect(() => { if (nc?.ok && nc.codes) { setCodes(nc.codes); setMode("none"); } }, [nc]);

  const begin = () => start(async () => {
    setStartErr(undefined);
    const r = await startTwoFactorAction();
    if (r.qr) setSetup(r); else setStartErr(errText(S, t.common.error, r));
  });
  const cancel = () => start(async () => { await cancelTwoFactorAction(); setSetup(null); });

  if (codes) return <RecoveryCodes t={t} codes={codes} justOn={justOn} onDone={() => { setCodes(null); setJustOn(false); router.refresh(); }} />;

  return (
    <div className="rounded-2xl bg-slate-50/80 p-4 ring-1 ring-black/[0.04]">
      <h3 className="flex items-center gap-2 font-bold"><Icon name="phone" className="h-5 w-5 text-brand-600" />{T.title}</h3>
      <p className="mt-1 text-sm text-ink-soft">{T.why}</p>
      <p className={`mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${v.twoOn ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
        <Icon name={v.twoOn ? "check" : "alert"} className="h-4 w-4" />{v.twoOn ? T.on.replace("{date}", v.twoSince ?? "") : T.off}
      </p>

      {!v.twoOn && !setup && (
        <div className="mt-4 space-y-3">
          <button type="button" onClick={begin} disabled={pending} className="btn-primary group w-full sm:w-auto"><Icon name="shield" className="icon-pop h-4 w-4" />{T.enable}</button>
          <ErrorBox message={startErr} />
        </div>
      )}

      {!v.twoOn && setup?.qr && (
        <div className="mt-4 space-y-4">
          <ol className="space-y-3 text-sm">
            <li className="flex gap-2"><span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">1</span><span>{T.step1}</span></li>
            <li className="flex gap-2"><span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">2</span><span>{T.step2}</span></li>
          </ol>
          <div className="flex flex-col items-center gap-2">
            <svg viewBox={`-4 -4 ${setup.qr.size + 8} ${setup.qr.size + 8}`} className="h-52 w-52 rounded-xl bg-white shadow-card ring-1 ring-black/5" shapeRendering="crispEdges" role="img" aria-label="QR">
              <rect x={-4} y={-4} width={setup.qr.size + 8} height={setup.qr.size + 8} fill="#fff" />
              <path d={setup.qr.d} fill="#000" />
            </svg>
            {setup.uri && <a href={setup.uri} className="text-sm font-semibold text-brand-700 underline underline-offset-2 md:hidden">{T.openApp}</a>}
          </div>
          <div className="text-sm">
            <div className="text-ink-soft">{T.manual}</div>
            <div dir="ltr" className="mt-1 select-all break-all rounded-lg bg-white px-3 py-2 font-mono text-sm font-semibold tracking-wider ring-1 ring-black/10">{setup.secret}</div>
          </div>
          <form action={confirmAction} className="space-y-3">
            <div className="flex gap-2 text-sm"><span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white">3</span><span>{T.step3}</span></div>
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required dir="ltr"
              className="input text-center text-2xl font-bold tracking-[0.4em]" placeholder="000000" />
            <ErrorBox message={errText(S, t.common.error, conf)} />
            <div className="flex flex-wrap gap-2">
              <SubmitButton className="btn-primary group"><Icon name="check" className="icon-pop h-4 w-4" />{T.confirm}</SubmitButton>
              <button type="button" onClick={cancel} disabled={pending} className="btn-ghost">{T.cancel}</button>
            </div>
          </form>
        </div>
      )}

      {v.twoOn && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-semibold">{T.codesLeft.replace("{n}", String(v.codesLeft))}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost group" onClick={() => setMode(mode === "newCodes" ? "none" : "newCodes")}><Icon name="key" className="icon-pop h-4 w-4" />{T.newCodes}</button>
            <button type="button" className="btn-danger group" onClick={() => setMode(mode === "disable" ? "none" : "disable")}><Icon name="x" className="icon-pop h-4 w-4" />{T.disable}</button>
          </div>
          {mode === "newCodes" && (
            <form action={newCodesAction} className="space-y-3 rounded-xl bg-white p-3 ring-1 ring-black/5">
              <p className="text-sm text-ink-soft">{T.newCodesHint}</p>
              <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required dir="ltr" className="input text-center text-xl font-bold tracking-[0.3em]" placeholder="000000" />
              <ErrorBox message={errText(S, t.common.error, nc)} />
              <SubmitButton className="btn-primary">{T.newCodes}</SubmitButton>
            </form>
          )}
          {mode === "disable" && (
            <form action={disableAction} className="space-y-3 rounded-xl bg-white p-3 ring-1 ring-red-100">
              <p className="text-sm text-ink-soft">{T.disableHint}</p>
              <Field label={S.password.current}><input name="password" type="password" autoComplete="current-password" required className="input" dir="ltr" /></Field>
              <Field label={T.code}><input name="code" autoComplete="one-time-code" maxLength={20} required dir="ltr" className="input" /></Field>
              <ErrorBox message={errText(S, t.common.error, dis)} />
              <SubmitButton className="btn-danger">{T.disable}</SubmitButton>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function RecoveryCodes({ t, codes, justOn, onDone }: { t: Dict; codes: string[]; justOn: boolean; onDone: () => void }) {
  const T = t.security.two;
  const [copied, setCopied] = useState(false);
  const text = `Star Style – ${T.codesTitle}\n\n${codes.join("\n")}\n`;
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* Kopieren nicht erlaubt */ } };
  const save = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = "star-style-codes.txt"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="rounded-2xl bg-amber-50/70 p-4 ring-1 ring-amber-200">
      {justOn && <div className="mb-3"><Ok>{T.enabled}</Ok></div>}
      <h3 className="flex items-center gap-2 font-bold"><Icon name="key" className="h-5 w-5 text-amber-700" />{T.codesTitle}</h3>
      <p className="mt-1 text-sm text-amber-900">{T.codesHint}</p>
      <ol dir="ltr" className="mt-3 grid grid-cols-2 gap-2">
        {codes.map((c) => <li key={c} className="rounded-lg bg-white px-2 py-1.5 text-center font-mono text-sm font-bold tracking-wider ring-1 ring-black/10">{c}</li>)}
      </ol>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className="btn-ghost group"><Icon name="copy" className="icon-pop h-4 w-4" />{copied ? T.copied : T.copy}</button>
        <button type="button" onClick={save} className="btn-ghost group"><Icon name="download" className="icon-pop h-4 w-4" />{T.save}</button>
        <button type="button" onClick={onDone} className="btn-primary group"><Icon name="check" className="icon-pop h-4 w-4" />{T.done}</button>
      </div>
    </div>
  );
}

function Password({ t, v }: { t: Dict; v: SecurityView }) {
  const S = t.security, P = S.password;
  const router = useRouter();
  const [st, action] = useActionState(changePasswordAction, undefined);
  useEffect(() => { if (st?.ok) router.refresh(); }, [st, router]);
  return (
    <form action={action} className="space-y-3 rounded-2xl bg-slate-50/80 p-4 ring-1 ring-black/[0.04]">
      <h3 className="flex items-center gap-2 font-bold"><Icon name="lock" className="h-5 w-5 text-brand-600" />{P.title}</h3>
      <p className="text-xs text-ink-soft">{v.passwordChanged ? P.last.replace("{date}", v.passwordChanged) : P.never}</p>
      {st?.ok && <Ok>{P.changed}</Ok>}
      <Field label={P.current}><input name="current" type="password" autoComplete="current-password" required className="input" dir="ltr" /></Field>
      <Field label={P.next} hint={P.hint}><input name="next" type="password" autoComplete="new-password" required minLength={10} className="input" dir="ltr" /></Field>
      <Field label={P.repeat}><input name="repeat" type="password" autoComplete="new-password" required minLength={10} className="input" dir="ltr" /></Field>
      <ErrorBox message={errText(S, t.common.error, st)} />
      <SubmitButton className="btn-primary group"><Icon name="lock" className="icon-pop h-4 w-4" />{P.save}</SubmitButton>
    </form>
  );
}

function Others({ t }: { t: Dict }) {
  const O = t.security.others;
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-3 rounded-2xl bg-slate-50/80 p-4 ring-1 ring-black/[0.04]">
      <h3 className="flex items-center gap-2 font-bold"><Icon name="logout" className="h-5 w-5 text-brand-600" />{O.title}</h3>
      <p className="text-sm text-ink-soft">{O.hint}</p>
      {done && <Ok>{O.done}</Ok>}
      <button type="button" disabled={pending} className="btn-ghost group"
        onClick={() => start(async () => { const r = await logoutOthersAction(); if (r.ok) { setDone(true); router.refresh(); } })}>
        <Icon name="logout" className="icon-pop h-4 w-4" />{O.button}
      </button>
    </div>
  );
}

function Log({ t, v }: { t: Dict; v: SecurityView }) {
  const L = t.security.log;
  const tone = (ok: boolean, key: LogKey) => key === "locked" ? "bg-red-100 text-red-800" : ok ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900";
  return (
    <div className="mt-5">
      <h3 className="mb-2 flex items-center gap-2 font-bold"><Icon name="history" className="h-5 w-5 text-brand-600" />{L.title}</h3>
      {v.log.length === 0 ? <p className="text-sm text-ink-soft">{L.empty}</p> : (
        <>
          <ul className="space-y-2 md:hidden">
            {v.log.map((r, i) => (
              <li key={i} className="rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-black/[0.03]">
                <div className="flex items-center justify-between gap-2"><span className={`badge ${tone(r.ok, r.key)}`}>{L.reasons[r.key]}</span><span className="num text-xs text-ink-soft">{r.at}</span></div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-xs text-ink-soft"><span>{r.device}</span><span dir="ltr" className="break-all">{r.ip}</span></div>
              </li>
            ))}
          </ul>
          <table className="tbl-fit hidden w-full text-sm md:table">
            <thead><tr className="text-start text-xs text-ink-soft"><th className="py-1 text-start">{L.when}</th><th className="text-start">{L.result}</th><th className="text-start">{L.device}</th><th className="text-start">{L.ip}</th></tr></thead>
            <tbody>
              {v.log.map((r, i) => (
                <tr key={i} className="border-t border-black/5">
                  <td className="num whitespace-nowrap py-1.5">{r.at}</td>
                  <td><span className={`badge ${tone(r.ok, r.key)}`}>{L.reasons[r.key]}</span></td>
                  <td>{r.device}</td>
                  <td className="break-all"><bdi dir="ltr">{r.ip}</bdi></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
