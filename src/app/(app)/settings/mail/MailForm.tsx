"use client";
import { useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { saveMailAction, testMailAction, type MailSaveResult } from "./actions";
import { SignaturePreview } from "@/components/SignaturePreview";
import { DEFAULT_DOC_TEXTS, DOC_TEXT_KEYS, DOC_TEXT_MAX } from "@/lib/mail-rules";

type Initial = { imapHost: string; imapPort: number; smtpHost: string; smtpPort: number; user: string; fromName: string; signature: string; signatureHtml: string; invoiceText: string; offerText: string; hasPassword: boolean };
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** Zugang zum Postfach: Adresse + App-Passwort (Hostinger), Server sind vorbelegt; „Speichern“ prüft gleich die Anmeldung */
export function MailForm({ t, initial, ready }: { t: Dict; initial: Initial; ready: boolean }) {
  const M = t.mailSet;
  const [v, setV] = useState({ ...initial, password: "", invoiceText: initial.invoiceText || DEFAULT_DOC_TEXTS.invoice, offerText: initial.offerText || DEFAULT_DOC_TEXTS.offer });
  const docRefs = { invoice: useRef<HTMLTextAreaElement>(null), offer: useRef<HTMLTextAreaElement>(null) };
  /** Platzhalter an der Schreibmarke einfügen */
  const insertKey = (kind: "invoice" | "offer", key: string) => {
    const el = docRefs[kind].current, field = kind === "invoice" ? "invoiceText" : "offerText";
    const cur = v[field], token = `{${key}}`;
    const a = el?.selectionStart ?? cur.length, b = el?.selectionEnd ?? cur.length;
    setV({ ...v, [field]: (cur.slice(0, a) + token + cur.slice(b)).slice(0, DOC_TEXT_MAX) });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + token.length, a + token.length); });
  };
  const docText = (kind: "invoice" | "offer") => {
    const field = kind === "invoice" ? "invoiceText" : "offerText";
    return (
      <div className="col-span-2 md:col-span-1 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`m-${field}`} className="block text-xs font-bold text-ink-soft">{kind === "invoice" ? M.invoiceText : M.offerText}</label>
          {v[field] !== DEFAULT_DOC_TEXTS[kind] && (
            <button type="button" className="text-[0.6875rem] font-semibold text-brand-700 hover:underline" onClick={() => setV({ ...v, [field]: DEFAULT_DOC_TEXTS[kind] })}>↺ {M.docTextReset}</button>
          )}
        </div>
        <textarea id={`m-${field}`} ref={docRefs[kind]} value={v[field]} onChange={(e) => setV({ ...v, [field]: e.target.value })} rows={7} dir="ltr" className="input text-sm" maxLength={DOC_TEXT_MAX} />
        <div className="flex flex-wrap gap-1.5">
          {DOC_TEXT_KEYS[kind].map((k) => (
            <button key={k} type="button" onClick={() => insertKey(kind, k)} className="rounded-full bg-brand-50 px-2.5 py-1 text-[0.6875rem] font-semibold text-brand-800 ring-1 ring-brand-100 hover:bg-brand-100" title={`{${k}}`}>
              + {(M.docKeys as Record<string, string>)[k]}
            </button>
          ))}
        </div>
      </div>
    );
  };
  const [busy, setBusy] = useState<"" | "save" | "test" | "off">("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const errText = (r: Exclude<MailSaveResult, { ok: true }>) => {
    const key = r.error.replace(/^saved_/, "");
    const m = (M.errors as Record<string, string>)[key] ?? M.errors.error;
    return (r.error.startsWith("saved_") ? `${M.savedButFailed} ` : "") + m + (r.detail && key !== "auth" ? ` (${r.detail})` : "");
  };
  const okText = (r: { total?: number; unseen?: number }) => fill(M.connected, { total: r.total ?? 0, unseen: r.unseen ?? 0 });
  const run = async (kind: "save" | "test" | "off") => {
    if (busy) return;
    setBusy(kind); setMsg(null);
    let r: MailSaveResult;
    try {
      r = kind === "test" ? await testMailAction() : await saveMailAction({ ...v, invoiceText: v.invoiceText.trim() === DEFAULT_DOC_TEXTS.invoice ? "" : v.invoiceText, offerText: v.offerText.trim() === DEFAULT_DOC_TEXTS.offer ? "" : v.offerText, disconnect: kind === "off" });
    } catch { r = { ok: false, error: "error" }; }
    setBusy("");
    if (!r.ok) { setMsg({ tone: r.error.startsWith("saved_") ? "warn" : "err", text: errText(r) }); if (r.error.startsWith("saved_")) setV((x) => ({ ...x, password: "" })); return; }
    if (kind === "off") { window.location.assign("/settings/mail"); return; }
    setV((x) => ({ ...x, password: "" }));
    setMsg({ tone: "ok", text: okText(r) });
  };
  const field = (k: "user" | "fromName" | "imapHost" | "smtpHost", label: string, hint = "", wide = false) => (
    <div className={wide ? "col-span-2" : "col-span-2 md:col-span-1"}>
      <label htmlFor={`m-${k}`} className="mb-1 block text-xs font-bold text-ink-soft">{label}</label>
      <input id={`m-${k}`} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} dir={k === "fromName" ? "auto" : "ltr"} autoComplete="off" spellCheck={false} className="input"
        inputMode={k === "user" ? "email" : "text"} />
      {hint && <p className="mt-1 text-[0.6875rem] text-ink-soft">{hint}</p>}
    </div>
  );
  const port = (k: "imapPort" | "smtpPort", label: string) => (
    <div className="col-span-1">
      <label htmlFor={`m-${k}`} className="mb-1 block text-xs font-bold text-ink-soft">{label}</label>
      <input id={`m-${k}`} value={String(v[k])} onChange={(e) => setV({ ...v, [k]: Number(e.target.value.replace(/\D/g, "")) || 0 })} inputMode="numeric" dir="ltr" className="input num" />
    </div>
  );
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <form onSubmit={(e) => { e.preventDefault(); run("save"); }} className="card animate-rise space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="inbox" className="h-5 w-5 text-brand-600" />{M.access}</h2>
          <span className={`badge ${ready ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{ready ? M.ready : M.notReady}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {field("user", M.user, M.userHint)}
          <div className="col-span-2 md:col-span-1">
            <label htmlFor="m-password" className="mb-1 block text-xs font-bold text-ink-soft">{M.password}</label>
            <input id="m-password" type="password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} dir="ltr" autoComplete="new-password"
              placeholder={initial.hasPassword ? M.passwordKept : ""} className="input" />
            <p className="mt-1 text-[0.6875rem] text-ink-soft">{initial.hasPassword ? M.passwordKeptHint : M.passwordHint}</p>
          </div>
          {field("fromName", M.fromName, M.fromNameHint, true)}
          <div className="col-span-2">
            <label htmlFor="m-signature" className="mb-1 block text-xs font-bold text-ink-soft">{M.signature}</label>
            <textarea id="m-signature" value={v.signature} onChange={(e) => setV({ ...v, signature: e.target.value })} rows={4} dir="auto" className="input" maxLength={2000} />
            <p className="mt-1 text-[0.6875rem] text-ink-soft">{M.signatureHint}</p>
          </div>
          <div className="col-span-2 space-y-2">
            <label htmlFor="m-signatureHtml" className="block text-xs font-bold text-ink-soft">{M.signatureHtml}</label>
            <textarea id="m-signatureHtml" value={v.signatureHtml} onChange={(e) => setV({ ...v, signatureHtml: e.target.value })} rows={5} dir="ltr" spellCheck={false}
              className="input font-mono text-xs" maxLength={40000} placeholder="<table …>…</table>" />
            <p className="text-[0.6875rem] text-ink-soft">{M.signatureHtmlHint}</p>
            {v.signatureHtml.trim() && <><p className="text-xs font-bold text-ink-soft">{M.signaturePreview}</p><SignaturePreview html={v.signatureHtml} title={M.signaturePreview} /></>}
          </div>
          <div className="col-span-2 border-t border-black/5 pt-4">
            <h3 className="text-sm font-bold">{M.docTextsTitle}</h3>
            <p className="text-[0.6875rem] text-ink-soft">{M.docTextsHint}</p>
          </div>
          {docText("invoice")}
          {docText("offer")}
        </div>
        <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)} className="rounded-xl bg-slate-50 p-3 ring-1 ring-black/5">
          <summary className="cursor-pointer text-sm font-semibold text-ink-soft">{M.servers}</summary>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-[minmax(0,1fr)_7rem]">
            <div className="col-span-1"><label htmlFor="m-imapHost" className="mb-1 block text-xs font-bold text-ink-soft">{M.imapHost}</label>
              <input id="m-imapHost" value={v.imapHost} onChange={(e) => setV({ ...v, imapHost: e.target.value })} dir="ltr" className="input" spellCheck={false} /></div>
            {port("imapPort", M.port)}
            <div className="col-span-1"><label htmlFor="m-smtpHost" className="mb-1 block text-xs font-bold text-ink-soft">{M.smtpHost}</label>
              <input id="m-smtpHost" value={v.smtpHost} onChange={(e) => setV({ ...v, smtpHost: e.target.value })} dir="ltr" className="input" spellCheck={false} /></div>
            {port("smtpPort", M.port)}
          </div>
          <p className="mt-2 text-[0.6875rem] text-ink-soft">{M.serversHint}</p>
        </details>
        <div className="flex flex-wrap gap-2">
          <button disabled={Boolean(busy)} className="btn-primary group">
            {busy === "save" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="check" className="h-4 w-4" />}{M.save}
          </button>
          {ready && (
            <button type="button" disabled={Boolean(busy)} onClick={() => run("test")} className="btn-ghost group">
              {busy === "test" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" /> : <Icon name="link" className="h-4 w-4" />}{M.test}
            </button>
          )}
          {ready && <a href="/mail" className="btn-ghost group"><Icon name="inbox" className="h-4 w-4" />{M.open}</a>}
          {ready && (
            <button type="button" disabled={Boolean(busy)} onClick={() => { if (window.confirm(M.disconnectConfirm)) run("off"); }} className="btn-ghost group ms-auto text-red-700">
              <Icon name="x" className="h-4 w-4" />{M.disconnect}
            </button>
          )}
        </div>
        {msg && <p role={msg.tone === "ok" ? "status" : "alert"} className={`rounded-xl p-3 text-sm font-semibold ring-1 [overflow-wrap:anywhere] ${msg.tone === "ok" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : msg.tone === "warn" ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-red-50 text-red-800 ring-red-200"}`}>{msg.text}</p>}
      </form>
      <aside className="card h-fit animate-rise space-y-3 p-5 text-sm">
        <h3 className="flex items-center gap-2 font-bold"><Icon name="bulb" className="h-4 w-4 text-brand-600" />{M.howTitle}</h3>
        <ol className="list-decimal space-y-1.5 ps-5 text-ink-soft">{M.how.map((x) => <li key={x}>{x}</li>)}</ol>
        <p className="rounded-xl bg-brand-50/70 p-3 text-xs text-brand-900 ring-1 ring-brand-100">{M.sameInbox}</p>
      </aside>
    </div>
  );
}
