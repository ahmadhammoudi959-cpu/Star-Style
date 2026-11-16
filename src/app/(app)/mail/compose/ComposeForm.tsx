"use client";
import { useRef, useState, useTransition } from "react";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { humanSize, parseAddressList } from "@/lib/mail-rules";
import { sendMailAction } from "../actions";
import { SignaturePreview } from "@/components/SignaturePreview";

type Initial = { mode: "new" | "reply" | "all" | "fwd"; f: string; u: number; to: string; cc: string; subject: string; text: string; originalAttachments: number };
const MAX = 20 * 1024 * 1024;

export function ComposeForm({ t, from, initial, signatureHtml = "" }: { t: Dict; intl: string; from: string; initial: Initial; signatureHtml?: string }) {
  const M = t.mail;
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [showCc, setShowCc] = useState(Boolean(initial.cc));
  const [subject, setSubject] = useState(initial.subject);
  const [text, setText] = useState(initial.text);
  const [files, setFiles] = useState<File[]>([]);
  const [withOriginal, setWithOriginal] = useState(initial.originalAttachments > 0);
  const [error, setError] = useState("");
  const [withSig, setWithSig] = useState(Boolean(signatureHtml));
  const [busy, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const total = files.reduce((n, f) => n + f.size, 0);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files, ...Array.from(list)].slice(0, 20);
    if (next.reduce((n, f) => n + f.size, 0) > MAX) { setError(M.errors.tooLarge); return; }
    setError(""); setFiles(next);
    if (fileRef.current) fileRef.current.value = "";
  };
  const send = () => {
    setError("");
    const a = parseAddressList(to), b = parseAddressList(cc);
    if (a.bad.length || b.bad.length) { setError(`${M.errors.address} ${[...a.bad, ...b.bad].join(", ")}`); return; }
    if (!a.ok.length) { setError(M.errors.noTo); return; }
    const fd = new FormData();
    fd.set("to", to); fd.set("cc", showCc ? cc : ""); fd.set("subject", subject); fd.set("text", text);
    fd.set("mode", initial.mode); fd.set("f", initial.f); fd.set("u", String(initial.u)); fd.set("withOriginal", withOriginal ? "1" : "0"); fd.set("withSignature", withSig ? "1" : "0");
    files.forEach((f) => fd.append("files", f, f.name));
    start(async () => {
      let r;
      try { r = await sendMailAction(fd); } catch { r = { ok: false as const, error: "network" }; }
      if (!r.ok) { setError(((M.errors as Record<string, string>)[r.error] ?? M.errors.network) + (r.error === "address" && r.detail ? ` ${r.detail}` : "")); return; }
      window.location.assign(`/mail?${new URLSearchParams({ f: "INBOX", sent: "1" })}`);
    });
  };
  const row = "grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 border-b border-black/5 px-4 py-2 sm:grid-cols-[6rem_minmax(0,1fr)]";
  return (
    <form onSubmit={(e) => { e.preventDefault(); send(); }} className="card animate-rise overflow-hidden">
      <div className={row}><span className="text-xs font-bold text-ink-soft">{M.from}</span><bdi dir="ltr" className="truncate text-sm text-ink-soft">{from}</bdi></div>
      <div className={row}>
        <label htmlFor="c-to" className="text-xs font-bold text-ink-soft">{M.to}</label>
        <div className="flex items-center gap-2">
          <input id="c-to" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" inputMode="email" autoComplete="off" className="input min-w-0 flex-1 border-0 py-1.5 shadow-none ring-0" placeholder="kunde@example.de" />
          {!showCc && <button type="button" onClick={() => setShowCc(true)} className="text-xs font-semibold text-brand-700 hover:underline">{M.cc}</button>}
        </div>
      </div>
      {showCc && <div className={row}><label htmlFor="c-cc" className="text-xs font-bold text-ink-soft">{M.cc}</label>
        <input id="c-cc" value={cc} onChange={(e) => setCc(e.target.value)} dir="ltr" inputMode="email" autoComplete="off" className="input border-0 py-1.5 shadow-none ring-0" /></div>}
      <div className={row}><label htmlFor="c-subject" className="text-xs font-bold text-ink-soft">{M.subject}</label>
        <input id="c-subject" value={subject} onChange={(e) => setSubject(e.target.value)} dir="auto" maxLength={250} className="input border-0 py-1.5 font-semibold shadow-none ring-0" /></div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} dir="auto" rows={16} aria-label={M.body} autoFocus={initial.mode !== "new" || Boolean(initial.to)}
        className="block min-h-[18rem] w-full resize-y border-0 px-4 py-3 text-[0.9375rem] leading-relaxed outline-none focus:ring-0" />
      <div className="space-y-3 border-t border-black/5 p-4">
        {signatureHtml && (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={withSig} onChange={(e) => setWithSig(e.target.checked)} className="h-4 w-4 accent-brand-600" />{M.withSignature}</label>
            {withSig && <SignaturePreview html={signatureHtml} title={M.withSignature} className="max-w-2xl" />}
          </div>
        )}
        {initial.originalAttachments > 0 && (
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withOriginal} onChange={(e) => setWithOriginal(e.target.checked)} className="h-4 w-4 accent-brand-600" />
            {M.withOriginal.replace("{n}", String(initial.originalAttachments))}</label>
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-2">{files.map((f, i) => (
            <li key={i} className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-1.5 text-xs ring-1 ring-black/5">
              <Icon name="clip" className="h-3.5 w-3.5 text-brand-600" /><span className="max-w-[12rem] truncate font-semibold" dir="auto">{f.name}</span><span className="num text-ink-soft">{humanSize(f.size)}</span>
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={t.common.delete} className="text-ink-soft hover:text-red-600"><Icon name="x" className="h-3.5 w-3.5" /></button>
            </li>))}
            <li className="num self-center text-xs text-ink-soft">{humanSize(total)} / 20 MB</li>
          </ul>
        )}
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800 ring-1 ring-red-200 [overflow-wrap:anywhere]">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={busy} className="btn-primary group">
            {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="send" className="h-4 w-4 rtl:-scale-x-100" />}{busy ? M.sending : M.send}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="btn-ghost group"><Icon name="clip" className="h-4 w-4" />{M.attach}</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        </div>
      </div>
    </form>
  );
}
