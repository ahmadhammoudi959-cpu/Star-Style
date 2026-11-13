"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { saveGlsAction, testGlsAction, type GlsSaveResult } from "./actions";

type Initial = { endpoint: string; user: string; contactId: string; flex: boolean; hasPassword: boolean };

/** Formular GLS-Zugangsdaten + „Verbindung testen“ (prüft eine Beispielsendung bei GLS, legt nichts an) */
export function GlsForm({ t, initial, ready }: { t: Dict; initial: Initial; ready: boolean }) {
  const G = t.gls;
  const [v, setV] = useState({ endpoint: initial.endpoint, user: initial.user, contactId: initial.contactId, password: "", flex: initial.flex });
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const errText = (r: Exclude<GlsSaveResult, { ok: true }>) => {
    const m = (G.errors as Record<string, string>)[r.error] ?? G.errors.error;
    return r.detail ? `${m} (${r.detail})` : m;
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy("save"); setMsg(null);
    let r: GlsSaveResult;
    try { r = await saveGlsAction(v); } catch { r = { ok: false, error: "error" }; }
    setBusy("");
    if (!r.ok) { setMsg({ tone: "err", text: errText(r) }); return; }
    window.location.assign("/settings/gls?saved=1");
  };
  const test = async () => {
    if (busy) return;
    setBusy("test"); setMsg(null);
    let r: GlsSaveResult;
    try { r = await testGlsAction(); } catch { r = { ok: false, error: "error" }; }
    setBusy("");
    setMsg(r.ok ? { tone: "ok", text: G.testOk } : { tone: "err", text: errText(r) });
  };
  const field = (k: "endpoint" | "user" | "contactId", label: string, hint: string, ph: string) => (
    <div className={k === "endpoint" ? "col-span-2" : "col-span-2 md:col-span-1"}>
      <label htmlFor={`gls-${k}`} className="mb-1 block text-xs font-bold text-ink-soft">{label}</label>
      <input id={`gls-${k}`} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} dir="ltr" autoComplete="off" spellCheck={false}
        placeholder={ph} className="input" inputMode={k === "endpoint" ? "url" : "text"} />
      {hint && <p className="mt-1 text-[0.6875rem] text-ink-soft">{hint}</p>}
    </div>
  );
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <form onSubmit={save} className="card animate-rise space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="truck" className="h-5 w-5 text-brand-600" />{G.access}</h2>
          <span className={`badge ${ready ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{ready ? G.ready : G.notReady}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {field("endpoint", G.endpoint, G.endpointHint, "https://shipit-wbm-de01.gls-group.eu:443/backend/rs")}
          {field("user", G.user, "", "")}
          <div className="col-span-2 md:col-span-1">
            <label htmlFor="gls-password" className="mb-1 block text-xs font-bold text-ink-soft">{G.password}</label>
            <input id="gls-password" type="password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} dir="ltr" autoComplete="new-password"
              placeholder={initial.hasPassword ? G.passwordKept : ""} className="input" />
            <p className="mt-1 text-[0.6875rem] text-ink-soft">{initial.hasPassword ? G.passwordKeptHint : G.passwordHint}</p>
          </div>
          {field("contactId", G.contactId, G.contactIdHint, "276a…")}
        </div>
        <label className="flex items-start gap-2 rounded-xl bg-brand-50/60 p-3 text-sm ring-1 ring-brand-100">
          <input type="checkbox" checked={v.flex} onChange={(e) => setV({ ...v, flex: e.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600" />
          <span><span className="font-semibold">{G.flex}</span><span className="block text-xs text-ink-soft">{G.flexHint}</span></span>
        </label>
        <div className="flex flex-wrap gap-2">
          <button disabled={Boolean(busy)} className="btn-primary group">
            {busy === "save" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="check" className="h-4 w-4" />}{G.save}
          </button>
          {ready && (
            <button type="button" disabled={Boolean(busy)} onClick={test} className="btn-ghost group">
              {busy === "test" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" /> : <Icon name="link" className="h-4 w-4" />}{G.test}
            </button>
          )}
        </div>
        {msg && <p role={msg.tone === "err" ? "alert" : "status"} className={`rounded-xl p-3 text-sm font-semibold ring-1 [overflow-wrap:anywhere] ${msg.tone === "ok" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-red-50 text-red-800 ring-red-200"}`}>{msg.text}</p>}
      </form>
      <aside className="card h-fit animate-rise space-y-3 p-5 text-sm">
        <h3 className="flex items-center gap-2 font-bold"><Icon name="bulb" className="h-4 w-4 text-brand-600" />{G.howTitle}</h3>
        <ol className="list-decimal space-y-1.5 ps-5 text-ink-soft">
          {G.how.map((x) => <li key={x}>{x}</li>)}
        </ol>
        <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">{G.heavyHint}</p>
      </aside>
    </div>
  );
}
