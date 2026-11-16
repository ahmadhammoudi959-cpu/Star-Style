"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { saveWaAction, testWaAction, type WaSaveResult } from "./actions";

type Initial = { phoneNumberId: string; wabaId: string; apiVersion: string; hasToken: boolean; hasSecret: boolean; displayPhone: string; verifiedName: string };
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** Zugang zur WhatsApp Cloud API + Webhook-Angaben zum Eintragen bei Meta */
export function WaForm({ t, initial, ready, webhookUrl, verifyToken }: { t: Dict; initial: Initial; ready: boolean; webhookUrl: string; verifyToken: string }) {
  const S = t.waSet;
  const [v, setV] = useState({ phoneNumberId: initial.phoneNumberId, wabaId: initial.wabaId, apiVersion: initial.apiVersion, accessToken: "", appSecret: "" });
  const [busy, setBusy] = useState<"" | "save" | "test" | "off">("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [copied, setCopied] = useState("");
  const okText = (r: { displayPhone?: string; verifiedName?: string; quality?: string }) => fill(S.connected, { phone: r.displayPhone || "?", name: r.verifiedName || "?", quality: r.quality || "?" });
  const errText = (r: Exclude<WaSaveResult, { ok: true }>) => {
    const key = r.error.replace(/^saved_/, "");
    return (r.error.startsWith("saved_") ? `${S.savedButFailed} ` : "") + ((S.errors as Record<string, string>)[key] ?? S.errors.error) + (r.detail && key !== "auth" ? ` (${r.detail})` : "");
  };
  const run = async (kind: "save" | "test" | "off") => {
    if (busy) return;
    setBusy(kind); setMsg(null);
    let r: WaSaveResult;
    try { r = kind === "test" ? await testWaAction() : await saveWaAction({ ...v, disconnect: kind === "off" }); } catch { r = { ok: false, error: "error" }; }
    setBusy("");
    if (!r.ok) { setMsg({ tone: r.error.startsWith("saved_") ? "warn" : "err", text: errText(r) }); if (r.error.startsWith("saved_")) window.setTimeout(() => window.location.reload(), 2500); return; }
    if (kind === "off" || kind === "save") { window.location.assign("/settings/whatsapp?saved=1"); return; }
    setMsg({ tone: "ok", text: okText(r) });
  };
  const copy = async (k: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(k); window.setTimeout(() => setCopied(""), 1500); } catch { /* ohne Zwischenablage */ } };
  const field = (k: "phoneNumberId" | "wabaId", label: string, hint: string) => (
    <div className="col-span-2 md:col-span-1">
      <label htmlFor={`wa-${k}`} className="mb-1 block text-xs font-bold text-ink-soft">{label}</label>
      <input id={`wa-${k}`} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value.replace(/\D/g, "") })} inputMode="numeric" dir="ltr" autoComplete="off" className="input num" />
      <p className="mt-1 text-[0.6875rem] text-ink-soft">{hint}</p>
    </div>
  );
  const secret = (k: "accessToken" | "appSecret", label: string, has: boolean, hint: string) => (
    <div className="col-span-2 md:col-span-1">
      <label htmlFor={`wa-${k}`} className="mb-1 block text-xs font-bold text-ink-soft">{label}</label>
      <input id={`wa-${k}`} type="password" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} dir="ltr" autoComplete="new-password" placeholder={has ? S.kept : ""} className="input" />
      <p className="mt-1 text-[0.6875rem] text-ink-soft">{has ? S.keptHint : hint}</p>
    </div>
  );
  const Copy = ({ k, label, value }: { k: string; label: string; value: string }) => (
    <div>
      <div className="mb-1 text-xs font-bold text-ink-soft">{label}</div>
      <div className="flex items-center gap-2">
        <code dir="ltr" className="min-w-0 flex-1 truncate rounded-lg bg-slate-50 px-3 py-2 text-xs ring-1 ring-black/5">{value || "—"}</code>
        {value && <button type="button" onClick={() => copy(k, value)} className="btn-ghost shrink-0 px-3 py-2 text-xs"><Icon name={copied === k ? "check" : "copy"} className="h-4 w-4" />{copied === k ? S.copied : S.copy}</button>}
      </div>
    </div>
  );
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-6">
        <form onSubmit={(e) => { e.preventDefault(); run("save"); }} className="card animate-rise space-y-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="chat" className="h-5 w-5 text-emerald-600" />{S.access}</h2>
            <span className={`badge ${ready ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>{ready ? S.ready : S.notReady}</span>
          </div>
          {ready && (initial.displayPhone || initial.verifiedName) && <p className="rounded-xl bg-emerald-50 p-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">{initial.verifiedName} · <bdi dir="ltr">{initial.displayPhone}</bdi></p>}
          <div className="grid grid-cols-2 gap-3">
            {field("phoneNumberId", S.phoneNumberId, S.phoneNumberIdHint)}
            {field("wabaId", S.wabaId, S.wabaIdHint)}
            {secret("accessToken", S.accessToken, initial.hasToken, S.accessTokenHint)}
            {secret("appSecret", S.appSecret, initial.hasSecret, S.appSecretHint)}
            <div className="col-span-1">
              <label htmlFor="wa-v" className="mb-1 block text-xs font-bold text-ink-soft">{S.apiVersion}</label>
              <input id="wa-v" value={v.apiVersion} onChange={(e) => setV({ ...v, apiVersion: e.target.value.trim() })} dir="ltr" className="input num" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={Boolean(busy)} className="btn-primary group">{busy === "save" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="check" className="h-4 w-4" />}{S.save}</button>
            {ready && <button type="button" disabled={Boolean(busy)} onClick={() => run("test")} className="btn-ghost group">{busy === "test" ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" /> : <Icon name="link" className="h-4 w-4" />}{S.test}</button>}
            {ready && <a href="/whatsapp" className="btn-ghost group"><Icon name="chat" className="h-4 w-4" />{S.open}</a>}
            {ready && <button type="button" disabled={Boolean(busy)} onClick={() => { if (window.confirm(S.disconnectConfirm)) run("off"); }} className="btn-ghost group ms-auto text-red-700"><Icon name="x" className="h-4 w-4" />{S.disconnect}</button>}
          </div>
          {msg && <p role={msg.tone === "ok" ? "status" : "alert"} className={`rounded-xl p-3 text-sm font-semibold ring-1 [overflow-wrap:anywhere] ${msg.tone === "ok" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : msg.tone === "warn" ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-red-50 text-red-800 ring-red-200"}`}>{msg.text}</p>}
        </form>
        <section className="card animate-rise space-y-3 p-5">
          <h2 className="flex items-center gap-2 font-bold"><Icon name="link" className="h-5 w-5 text-emerald-600" />{S.webhook}</h2>
          <p className="text-xs text-ink-soft">{S.webhookHint}</p>
          <Copy k="url" label={S.callbackUrl} value={webhookUrl} />
          <Copy k="token" label={S.verifyToken} value={verifyToken} />
          {!verifyToken && <p className="text-xs text-amber-800">{S.verifyTokenLater}</p>}
        </section>
      </div>
      <aside className="card h-fit animate-rise space-y-3 p-5 text-sm">
        <h3 className="flex items-center gap-2 font-bold"><Icon name="bulb" className="h-4 w-4 text-emerald-600" />{S.howTitle}</h3>
        <ol className="list-decimal space-y-1.5 ps-5 text-ink-soft">{S.how.map((x) => <li key={x}>{x}</li>)}</ol>
        <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">{S.numberNote}</p>
        <p className="rounded-xl bg-slate-50 p-3 text-xs text-ink-soft ring-1 ring-black/5">{S.costNote}</p>
      </aside>
    </div>
  );
}
