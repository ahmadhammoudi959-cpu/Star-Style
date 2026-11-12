"use client";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorBox, Field } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { ALL_PERMS, PERMISSION_GROUPS, PRESETS, effectivePerms, isPerm, type Perm, type PermGroup } from "@/lib/permissions";
import { resetPasswordAction, saveUserAction, setActiveAction, type UserResult } from "../actions";

export type UserView = {
  id: string; name: string; email: string; locale: string; admin: boolean; perms: string[];
  active: boolean; mustChange: boolean; twoOn: boolean; self: boolean;
};

const LANGS = { de: "Deutsch", ar: "العربية", en: "English", ku: "Kurdî" } as const;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const closure = (p: Perm) => effectivePerms([p], false);

/** Gespeichert wird die aufgefüllte Liste; im Formular zählen nur die selbst gewählten (was ein anderes Recht mitbringt, fällt weg) */
function minimal(list: string[]): Set<Perm> {
  const s = new Set(list.filter(isPerm));
  const implied = new Set<Perm>();
  for (const p of s) for (const q of closure(p)) if (q !== p) implied.add(q);
  return new Set([...s].filter((p) => !implied.has(p)));
}

type Shown = { name: string; email: string; password: string; id?: string; created?: boolean };

export function UserForm({ t, u, loginUrl }: { t: Dict; u: UserView; loginUrl: string }) {
  const U = t.users;
  const [state, dispatch, pending] = useActionState(saveUserAction, undefined);
  const [name, setName] = useState(u.name);
  const [email, setEmail] = useState(u.email);
  const [locale, setLocale] = useState(u.locale);
  const [admin, setAdmin] = useState(u.admin);
  const [chosen, setChosen] = useState<Set<Perm>>(() => minimal(u.perms));
  const [shown, setShown] = useState<Shown | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const eff = useMemo(() => effectivePerms([...chosen], false), [chosen]);
  const locked = useMemo(() => {
    const s = new Set<Perm>();
    for (const p of chosen) for (const q of closure(p)) if (q !== p) s.add(q);
    return s;
  }, [chosen]);

  // Ergebnis der Action: neues Konto → Einmal-Passwort zeigen; Fehler → getippte Werte bleiben (kommen zurück)
  useEffect(() => {
    if (!state) return;
    if (state.created && state.password) setShown({ name: state.name ?? name, email: state.email ?? email, password: state.password, id: state.id, created: true });
    else if (state.ok) setSavedAt(state.at ?? Date.now());
    if (state.values) {
      setName(state.values.name); setEmail(state.values.email); setLocale(state.values.locale);
      setAdmin(state.values.admin); setChosen(minimal(state.values.perms));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const dirty = () => setSavedAt(null);
  const toggle = (p: Perm) => {
    if (locked.has(p)) return;
    dirty();
    setChosen((c) => { const n = new Set(c); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  };
  const preset = (list: readonly Perm[]) => { dirty(); setChosen(minimal([...list])); };

  if (shown?.created) return <PasswordPanel t={t} s={shown} loginUrl={loginUrl} />;

  const err = state?.error ? ((U.errors as Record<string, string>)[state.error] ?? U.errors.error) : undefined;
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd)); // nicht über <form action>: React würde das Formular danach zurücksetzen
  };

  return (
    <div className="space-y-5">
      {shown && <PasswordPanel t={t} s={shown} loginUrl={loginUrl} onClose={() => setShown(null)} />}
      <form onSubmit={submit} className="space-y-5" onChange={dirty}>
        <input type="hidden" name="id" value={u.id} />
        <input type="hidden" name="admin" value={admin ? "1" : "0"} />
        <input type="hidden" name="perms" value={JSON.stringify([...chosen])} />

        <section className="card animate-rise space-y-4 p-5">
          {u.id && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`badge ${!u.active ? "bg-red-100 text-red-800" : u.mustChange ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"}`}>
                {!u.active ? U.inactive : u.mustChange ? U.waiting : U.active}
              </span>
              {u.twoOn && <span className="badge bg-emerald-50 text-emerald-800"><Icon name="shield" className="me-1 h-3 w-3" />{U.twoFactor}</span>}
            </div>
          )}
          {u.self && (
            <p className="flex items-start gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-800 ring-1 ring-brand-100">
              <Icon name="users" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{U.selfNote} <Link href="/account" className="underline underline-offset-2">{t.account.title}</Link></span>
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={U.name} className="col-span-2 md:col-span-1">
              <input name="name" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={100} className="input" dir="auto" autoComplete="off" />
            </Field>
            <Field label={U.email} className="col-span-2 md:col-span-1">
              <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required={!u.self} disabled={u.self} maxLength={200}
                className="input disabled:opacity-60" dir="ltr" autoComplete="off" />
            </Field>
            <Field label={t.common.language}>
              <select name="locale" value={locale} onChange={(e) => setLocale(e.target.value)} className="input">
                {(Object.keys(LANGS) as (keyof typeof LANGS)[]).map((l) => <option key={l} value={l} lang={l}>{LANGS[l]}</option>)}
              </select>
            </Field>
          </div>
          <button type="button" role="switch" aria-checked={admin} disabled={u.self} onClick={() => { dirty(); setAdmin((a) => !a); }}
            className={`group flex w-full items-start gap-3 rounded-2xl p-4 text-start ring-1 transition disabled:cursor-not-allowed ${admin ? "bg-accent-50 ring-accent-200" : "bg-slate-50 ring-black/5 hover:ring-brand-200"}`}>
            <span className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition ${admin ? "bg-accent-500" : "bg-slate-300"}`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${admin ? "start-[1.375rem]" : "start-0.5"}`} />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 font-bold"><Icon name="shield" className="icon-pop h-4 w-4 text-accent-600" />{U.admin}</span>
              <span className="block text-sm text-ink-soft">{U.adminHint}</span>
            </span>
          </button>
        </section>

        {!admin && (
          <section className="card animate-rise p-5">
            <div className="mb-3">
              <h2 className="text-lg font-bold">{U.rightsTitle}</h2>
              <p className="text-sm text-ink-soft">{U.rightsHint}</p>
            </div>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink-soft">{U.presets}:</span>
              {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => (
                <button key={k} type="button" onClick={() => preset(PRESETS[k])} className="btn-ghost group gap-1.5 px-3 py-1.5 text-sm ring-1 ring-brand-100">
                  <Icon name="bolt" className="icon-pop h-3.5 w-3.5 text-brand-600" />{U.presetNames[k]}
                </button>
              ))}
              <button type="button" onClick={() => preset(ALL_PERMS)} className="btn-ghost px-3 py-1.5 text-sm">{U.all}</button>
              <button type="button" onClick={() => preset([])} className="btn-ghost px-3 py-1.5 text-sm">{U.none}</button>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {(Object.keys(PERMISSION_GROUPS) as PermGroup[]).map((g) => (
                <fieldset key={g} className="rounded-2xl bg-slate-50/70 p-3 ring-1 ring-black/5">
                  <legend className="sr-only">{U.groups[g]}</legend>
                  <div aria-hidden className="mb-2 px-1 text-sm font-bold text-brand-700">{U.groups[g]}</div>
                  <ul className="space-y-1">
                    {(PERMISSION_GROUPS[g] as readonly Perm[]).map((p) => {
                      const on = eff.has(p), lock = locked.has(p);
                      return (
                        <li key={p}>
                          <label className={`flex items-start gap-2.5 rounded-xl px-2 py-1.5 text-sm transition ${lock ? "cursor-default text-ink-soft" : "cursor-pointer hover:bg-white"} ${on && !lock ? "bg-white font-semibold shadow-card" : ""}`}>
                            <input type="checkbox" checked={on} disabled={lock} onChange={() => toggle(p)} data-perm={p}
                              className="mt-0.5 h-4 w-4 shrink-0 rounded accent-brand-600" />
                            <span className="min-w-0">
                              {U.perms[p]}
                              {lock && <span className="ms-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-brand-700">{U.implied}</span>}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              ))}
            </div>
          </section>
        )}

        <div className="sticky bottom-20 z-10 lg:bottom-4">
          <div className="card flex flex-wrap items-center justify-between gap-3 p-3 shadow-lift">
            <div className="min-w-0 text-sm">
              <ErrorBox message={err} />
              {!err && savedAt && <span role="status" className="flex items-center gap-1.5 font-semibold text-emerald-700"><Icon name="check" className="h-4 w-4" />{U.saved}</span>}
              {!err && !savedAt && !admin && <span className="text-ink-soft">{fill(U.rights, { n: eff.size })}</span>}
            </div>
            <button type="submit" disabled={pending} className="btn-primary group">
              {pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Icon name={u.id ? "check" : "plus"} className="h-4 w-4" />}
              {u.id ? U.save : U.create}
            </button>
          </div>
        </div>
      </form>

      {u.id && !u.self && <Access t={t} u={u} onPassword={(s) => setShown(s)} />}
    </div>
  );
}

/** Zugang: neues Einmal-Passwort, sperren / wieder freischalten (nicht für das eigene Konto) */
function Access({ t, u, onPassword }: { t: Dict; u: UserView; onPassword: (s: Shown) => void }) {
  const U = t.users;
  const [active, setActive] = useState(u.active);
  const [ask, setAsk] = useState<null | "reset" | "deactivate">(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const run = async (fn: () => Promise<UserResult>, then: (r: UserResult) => void) => {
    setBusy(true); setErr(undefined);
    try {
      const r = await fn();
      if (r.error) setErr((U.errors as Record<string, string>)[r.error] ?? U.errors.error);
      else then(r);
    } catch { setErr(U.errors.error); } finally { setBusy(false); setAsk(null); }
  };
  const reset = () => run(() => resetPasswordAction(u.id), (r) => r.password && onPassword({ name: r.name ?? u.name, email: r.email ?? u.email, password: r.password }));
  const toggle = (on: boolean) => run(() => setActiveAction(u.id, on), () => setActive(on));
  return (
    <section className="card animate-rise space-y-3 p-5">
      <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="key" className="icon-pop h-5 w-5 text-brand-600" />{t.account.cardTitle}</h2>
      <ErrorBox message={err} />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => setAsk("reset")} className="btn-ghost group gap-2 ring-1 ring-brand-100">
          <Icon name="key" className="icon-pop h-4 w-4 text-brand-600" />{U.resetPassword}
        </button>
        {active ? (
          <button type="button" disabled={busy} onClick={() => setAsk("deactivate")} className="btn group gap-2 bg-red-50 text-red-700 ring-1 ring-red-200 hover:bg-red-100">
            <Icon name="lock" className="icon-pop h-4 w-4" />{U.deactivate}
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => toggle(true)} className="btn group gap-2 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100">
            <Icon name="check" className="icon-pop h-4 w-4" />{U.activate}
          </button>
        )}
        {!active && <span className="badge self-center bg-red-100 text-red-800">{U.inactive}</span>}
      </div>
      {ask && (
        <Ask t={t} title={ask === "reset" ? U.resetPassword : U.deactivate} text={ask === "reset" ? U.resetConfirm : fill(U.deactivateConfirm, { name: u.name })}
          yes={ask === "reset" ? U.resetPassword : U.deactivate} danger={ask === "deactivate"} busy={busy}
          onYes={() => (ask === "reset" ? reset() : toggle(false))} onNo={() => setAsk(null)} />
      )}
    </section>
  );
}

function Ask({ t, title, text, yes, danger, busy, onYes, onNo }: {
  t: Dict; title: string; text: string; yes: string; danger: boolean; busy: boolean; onYes: () => void; onNo: () => void;
}) {
  const noRef = useRef(onNo);
  noRef.current = onNo;
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") noRef.current(); };
    document.addEventListener("keydown", esc);
    cancel.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="user-ask-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) noRef.current(); }}>
      <div className="w-full max-w-md rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-4 flex items-start gap-3">
          <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${danger ? "bg-red-50 text-red-600" : "bg-brand-50 text-brand-600"}`}><Icon name={danger ? "lock" : "key"} className="icon-pop h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 id="user-ask-title" className="text-lg font-bold leading-snug">{title}</h2>
            <p className="mt-1 text-sm text-ink-soft">{text}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <button type="button" disabled={busy} onClick={onYes} className={`btn group w-full py-3 text-base text-white shadow-card ${danger ? "bg-red-600 hover:bg-red-700" : "bg-brand-600 hover:bg-brand-700"}`}>
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}{yes}
          </button>
          <button ref={cancel} type="button" onClick={onNo} className="btn-ghost w-full">{t.common.cancel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Einmal-Passwort: nur jetzt sichtbar. Ein Knopf kopiert die ganze Nachricht (Adresse, E-Mail, Passwort) z. B. für WhatsApp. */
function PasswordPanel({ t, s, loginUrl, onClose }: { t: Dict; s: Shown; loginUrl: string; onClose?: () => void }) {
  const U = t.users;
  const [copied, setCopied] = useState(false);
  const text = fill(U.message, { url: loginUrl, email: s.email, password: s.password });
  const box = useRef<HTMLTextAreaElement>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { box.current?.select(); }
  };
  return (
    <section ref={ref} className="card animate-rise space-y-4 p-5 ring-2 ring-emerald-300">
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Icon name="key" className="icon-pop h-6 w-6" /></span>
        <div className="min-w-0">
          {s.created && <div className="text-sm font-bold text-emerald-700">{U.created}</div>}
          <h2 className="text-lg font-bold">{fill(U.passwordTitle, { name: s.name })}</h2>
          <p className="text-sm text-ink-soft">{U.passwordHint}</p>
        </div>
      </div>
      <dl className="grid gap-2 rounded-2xl bg-slate-50 p-4 text-sm ring-1 ring-black/5 sm:grid-cols-[auto_1fr] sm:gap-x-4">
        <dt className="text-ink-soft">{U.loginAt}</dt><dd className="break-all font-semibold" dir="ltr">{loginUrl}</dd>
        <dt className="text-ink-soft">{U.email}</dt><dd className="break-all font-semibold" dir="ltr">{s.email}</dd>
        <dt className="text-ink-soft">{t.login.password}</dt>
        <dd><span data-temp-password className="select-all rounded-lg bg-white px-3 py-1.5 font-mono text-xl font-bold tracking-wider text-brand-800 ring-1 ring-brand-100" dir="ltr">{s.password}</span></dd>
      </dl>
      <textarea ref={box} readOnly value={text} rows={4} aria-label={U.copy} className="input font-mono text-xs" dir="auto" />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={copy} className="btn-primary group">
          <Icon name={copied ? "check" : "copy"} className="h-4 w-4" />{copied ? U.copied : U.copy}
        </button>
        {s.created && s.id && <Link href={`/settings/users/${s.id}`} className="btn-ghost group gap-2"><Icon name="eye" className="h-4 w-4" />{t.product.open}</Link>}
        <Link href="/settings/users" className="btn-ghost group gap-2"><Icon name="users" className="h-4 w-4" />{U.back}</Link>
        {onClose && <button type="button" onClick={onClose} className="btn-ghost">{t.common.close}</button>}
      </div>
    </section>
  );
}
