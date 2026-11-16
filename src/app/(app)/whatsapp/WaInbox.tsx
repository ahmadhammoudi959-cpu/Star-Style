"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { waLinkAction, waOpenChatAction, waReadAction, waSendFileAction, waSendTemplateAction, waSendTextAction, waTemplatesAction } from "./actions";

export type ChatRow = {
  id: string; waId: string; phone: string; name: string; unread: number; lastText: string; lastMessageAt: string | null;
  lastInboundAt: string | null; customerId: string | null; customerName: string | null;
};
export type Msg = {
  id: string; direction: string; type: string; body: string; mediaId: string | null; mediaFileId: string | null; mediaMime: string; mediaName: string;
  status: string; error: string; at: string;
};
export type Thread = { chat: { id: string; waId: string; phone: string; name: string; unread?: number; customerId: string | null; customer: { id: string; name: string; number: number } | null; windowOpen: boolean; lastInboundAt: string | null }; messages: Msg[] };
type Tpl = { name: string; language: string; category: string; body: string; params: number };
type Customer = { id: string; name: string; number: number; phone: string };

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const WINDOW = 24 * 3600 * 1000;

/** WhatsApp im System: Chats links, Verlauf rechts (Handy: eins von beiden), Senden im 24-Stunden-Fenster, sonst Vorlage */
export function WaInbox({ t, intl, initialChats, initialThread, customers, canCustomers }: {
  t: Dict; intl: string; initialChats: ChatRow[]; initialThread: Thread | null; customers: Customer[]; canCustomers: boolean;
}) {
  const W = t.wa;
  const [chats, setChats] = useState(initialChats);
  const [thread, setThread] = useState<Thread | null>(initialThread);
  const [q, setQ] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, start] = useTransition();
  const [modal, setModal] = useState<"" | "new" | "template" | "link">("");
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const chatId = thread?.chat.id ?? null;
  const errText = useCallback((code: string, detail?: string) => ((W.errors as Record<string, string>)[code] ?? W.errors.error) + (detail && code === "rejected" ? ` (${detail})` : ""), [W]);

  const loadChats = useCallback(async () => {
    try { const r = await fetch(`/api/whatsapp/chats?${new URLSearchParams({ q })}`, { cache: "no-store" }); if (r.ok) setChats((await r.json()).chats); } catch { /* nächster Versuch */ }
  }, [q]);
  const loadThread = useCallback(async (id: string) => {
    try { const r = await fetch(`/api/whatsapp/thread?c=${encodeURIComponent(id)}`, { cache: "no-store" }); if (r.ok) setThread(await r.json()); } catch { /* nächster Versuch */ }
  }, []);

  // Liste alle 10 s, offener Chat alle 4 s (nur wenn die Seite sichtbar ist)
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === "visible") loadChats(); }, 10_000);
    return () => clearInterval(id);
  }, [loadChats]);
  useEffect(() => { const h = setTimeout(loadChats, 300); return () => clearTimeout(h); }, [q, loadChats]);
  useEffect(() => {
    if (!chatId) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") loadThread(chatId); }, 4_000);
    return () => clearInterval(id);
  }, [chatId, loadThread]);
  const count = thread?.messages.length ?? 0;
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [chatId, count]);

  // Offener Chat = gelesen – auch beim Öffnen über einen Link (?c=, Kundenseite, Neuladen)
  // und wenn neue Nachrichten kommen, während der Chat offen ist (nur bei sichtbarer Seite)
  const reading = useRef(false);
  useEffect(() => {
    const id = thread?.chat.id;
    if (!id || !thread?.chat.unread || reading.current || document.visibilityState !== "visible") return;
    reading.current = true;
    waReadAction(id).catch(() => null).then(() => {
      reading.current = false;
      setChats((cs) => cs.map((x) => (x.id === id ? { ...x, unread: 0 } : x)));
      setThread((th) => (th && th.chat.id === id ? { ...th, chat: { ...th.chat, unread: 0 } } : th));
      window.dispatchEvent(new Event("ss:badges")); // Zahl im Menü gleich neu
    });
  }, [thread]);

  const open = async (c: ChatRow) => {
    setError(""); setText("");
    window.history.replaceState(null, "", `/whatsapp?c=${c.id}`);
    await loadThread(c.id);
  };
  const close = () => { setThread(null); window.history.replaceState(null, "", "/whatsapp"); };

  const send = () => {
    if (!chatId || !text.trim() || busy) return;
    const body = text;
    start(async () => {
      setError("");
      let r;
      try { r = await waSendTextAction({ chatId, text: body }); } catch { r = { ok: false as const, error: "network" }; }
      if (!r.ok) { setError(errText(r.error, r.detail)); return; }
      setText(""); await loadThread(chatId); loadChats();
    });
  };
  const sendFile = (f: File | undefined) => {
    if (!chatId || !f) return;
    start(async () => {
      setError("");
      const fd = new FormData(); fd.set("chatId", chatId); fd.set("file", f, f.name); fd.set("caption", text);
      let r;
      try { r = await waSendFileAction(fd); } catch { r = { ok: false as const, error: "network" }; }
      if (fileRef.current) fileRef.current.value = "";
      if (!r.ok) { setError(errText(r.error, r.detail)); return; }
      setText(""); await loadThread(chatId); loadChats();
    });
  };

  const time = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(x);
    return day(d) === day(new Date()) ? new Intl.DateTimeFormat(intl, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(d)
      : new Intl.DateTimeFormat(intl, { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" }).format(d);
  };
  const title = (c: { customerName?: string | null; customer?: { name: string } | null; name: string; phone: string }) => ("customer" in c && c.customer?.name) || c.customerName || c.name || c.phone;
  const left = thread?.chat.lastInboundAt ? Math.max(0, WINDOW - (Date.now() - new Date(thread.chat.lastInboundAt).getTime())) : 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[21rem_minmax(0,1fr)]">
      {/* Chats */}
      <section className={`${thread ? "hidden lg:flex" : "flex"} card min-h-[60vh] min-w-0 flex-col overflow-hidden animate-rise`}>
        <div className="flex gap-2 border-b border-black/5 p-3">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={W.search} className="input min-w-0 flex-1 py-2" aria-label={W.search} />
          <button type="button" onClick={() => setModal("new")} className="btn-primary shrink-0 px-3" aria-label={W.newChat}><Icon name="plus" className="h-4 w-4" /><span className="hidden sm:inline">{W.newChat}</span></button>
        </div>
        {chats.length === 0 ? <p className="p-5 text-sm text-ink-soft">{q ? W.noMatch : W.empty}</p> : (
          <ul className="flex-1 divide-y divide-black/5 overflow-y-auto">
            {chats.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => open(c)} className={`flex w-full items-center gap-3 px-3 py-3 text-start transition ${c.id === chatId ? "bg-emerald-50" : "hover:bg-slate-50"}`}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-green-700 text-sm font-bold text-white">{(title(c).trim()[0] ?? "#").toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm ${c.unread ? "font-bold" : "font-semibold"}`} dir="auto">{title(c)}</span>
                      <span className="num shrink-0 text-[0.6875rem] text-ink-soft">{time(c.lastMessageAt)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-soft" dir="auto">{c.lastText || c.phone}</span>
                      {c.unread > 0 && <span className="shrink-0 rounded-full bg-emerald-600 px-1.5 text-[0.6875rem] font-bold leading-5 text-white">{c.unread}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Verlauf */}
      <section className={`${thread ? "flex" : "hidden lg:flex"} card min-h-[60vh] min-w-0 flex-col overflow-hidden animate-rise`}>
        {!thread ? (
          <div className="grid flex-1 place-items-center p-8 text-center text-sm text-ink-soft"><div><Icon name="chat" className="mx-auto mb-2 h-9 w-9 text-emerald-400" />{W.pick}</div></div>
        ) : (
          <>
            <header className="flex flex-wrap items-center gap-3 border-b border-black/5 p-3">
              <button type="button" onClick={close} className="btn-ghost px-2.5 py-1.5 lg:hidden" aria-label={W.back}><Icon name="arrowLeft" className="h-4 w-4 rtl:rotate-180" /></button>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-green-700 font-bold text-white">{(title(thread.chat).trim()[0] ?? "#").toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold" dir="auto">{title(thread.chat)}</div>
                <bdi dir="ltr" className="num block truncate text-xs text-ink-soft">{thread.chat.phone}</bdi>
              </div>
              {/* Handy: Kunde + Verknüpfen in eigener Zeile, damit Name und Nummer nicht überdeckt werden */}
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                {thread.chat.customer ? (
                  canCustomers ? <Link href={`/customers/${thread.chat.customer.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100"><Icon name="users" className="h-3.5 w-3.5" />{W.customer} {thread.chat.customer.number}</Link>
                    : <span className="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">{W.customer} {thread.chat.customer.number}</span>
                ) : null}
                <button type="button" onClick={() => setModal("link")} className="btn-ghost px-2.5 py-1.5 text-xs"><Icon name="link" className="h-3.5 w-3.5" />{thread.chat.customer ? W.changeCustomer : W.linkCustomer}</button>
              </div>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto bg-[#f0f4f1] p-3 sm:p-4" style={{ maxHeight: "62vh" }}>
              {thread.messages.length === 0 && <p className="py-8 text-center text-sm text-ink-soft">{W.noMessages}</p>}
              {thread.messages.map((m) => <Bubble key={m.id} m={m} t={t} time={time} />)}
              <div ref={endRef} />
            </div>
            <footer className="space-y-2 border-t border-black/5 p-3">
              {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 ring-1 ring-red-200 [overflow-wrap:anywhere]">{error}</p>}
              {thread.chat.windowOpen ? (
                <>
                  <p className="text-[0.6875rem] text-ink-soft">{fill(W.windowLeft, { h: Math.floor(left / 3600000), m: Math.floor((left % 3600000) / 60000) })}</p>
                  <div className="flex items-end gap-2">
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="btn-ghost shrink-0 px-3 py-2.5" aria-label={W.attach}><Icon name="clip" className="h-5 w-5" /></button>
                    <input ref={fileRef} type="file" hidden accept="image/jpeg,image/png,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(e) => sendFile(e.target.files?.[0])} />
                    <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} dir="auto" placeholder={W.typeHere} aria-label={W.typeHere}
                      onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                      className="input max-h-40 min-h-[2.75rem] min-w-0 flex-1 resize-y py-2.5" />
                    <button type="button" onClick={send} disabled={busy || !text.trim()} className="btn shrink-0 bg-emerald-600 px-4 py-2.5 text-white shadow-card hover:bg-emerald-700" aria-label={W.send}>
                      {busy ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="send" className="h-5 w-5 rtl:-scale-x-100" />}
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 p-3 ring-1 ring-amber-200">
                  <p className="text-xs font-semibold text-amber-900">{W.windowClosed}</p>
                  <button type="button" onClick={() => setModal("template")} className="btn shrink-0 bg-emerald-600 px-3 py-2 text-sm text-white shadow-card hover:bg-emerald-700"><Icon name="send" className="h-4 w-4 rtl:-scale-x-100" />{W.sendTemplate}</button>
                </div>
              )}
              {thread.chat.windowOpen && <button type="button" onClick={() => setModal("template")} className="text-xs font-semibold text-emerald-700 hover:underline">{W.sendTemplate}</button>}
            </footer>
          </>
        )}
      </section>

      {modal === "new" && <NewChat t={t} customers={customers} onClose={() => setModal("")} onOpen={async (id) => { setModal(""); await loadChats(); await loadThread(id); window.history.replaceState(null, "", `/whatsapp?c=${id}`); }} />}
      {modal === "template" && chatId && <TemplatePicker t={t} chatId={chatId} onClose={() => setModal("")} onSent={async () => { setModal(""); await loadThread(chatId); loadChats(); }} />}
      {modal === "link" && thread && <LinkCustomer t={t} customers={customers} current={thread.chat.customerId} chatId={thread.chat.id} onClose={() => setModal("")} onDone={async () => { setModal(""); await loadThread(thread.chat.id); loadChats(); }} />}
    </div>
  );
}

function Ticks({ s, error, t }: { s: string; error: string; t: Dict }) {
  if (s === "failed") return <span title={error} className="inline-flex items-center gap-0.5 text-red-600"><Icon name="alert" className="h-3.5 w-3.5" />{t.wa.failed}</span>;
  if (s === "read") return <span className="font-bold tracking-[-0.2em] text-sky-500" aria-label={t.wa.status.read}>✓✓</span>;
  if (s === "delivered") return <span className="font-bold tracking-[-0.2em] text-ink-soft" aria-label={t.wa.status.delivered}>✓✓</span>;
  if (s === "sent") return <span className="font-bold text-ink-soft" aria-label={t.wa.status.sent}>✓</span>;
  return <Icon name="clock" className="h-3 w-3 text-ink-soft" aria-label={t.wa.status.pending} />;
}

function Bubble({ m, t, time }: { m: Msg; t: Dict; time: (s: string) => string }) {
  const out = m.direction === "out";
  const src = m.mediaFileId ? `/api/files/${m.mediaFileId}` : null;
  if (m.type === "reaction") {
    return <div className={`flex ${out ? "justify-end" : "justify-start"}`}><span className="rounded-full bg-white px-2 py-0.5 text-sm shadow-card">{m.body || "♡"}</span></div>;
  }
  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-card sm:max-w-[70%] ${out ? "rounded-ee-md bg-[#d9fdd3]" : "rounded-es-md bg-white"}`}>
        {m.type === "template" && <div className="mb-1 text-[0.625rem] font-bold uppercase tracking-wide text-emerald-700">{t.wa.template}</div>}
        {(m.type === "image" || m.type === "sticker") && (src
          ? <a href={src} target="_blank" rel="noopener"><img src={src} alt={m.body || t.wa.image} className={`${m.type === "sticker" ? "h-28 w-28" : "max-h-72"} mb-1 rounded-lg object-contain`} /></a>
          : <Pending m={m} t={t} />)}
        {m.type === "video" && (src ? <video src={src} controls className="mb-1 max-h-72 rounded-lg" /> : <Pending m={m} t={t} />)}
        {m.type === "audio" && (src ? <audio src={src} controls className="mb-1 max-w-full" /> : <Pending m={m} t={t} />)}
        {m.type === "document" && (src
          ? <a href={src} target="_blank" rel="noopener" className="mb-1 flex items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2 font-semibold hover:bg-black/10"><Icon name="file" className="h-4 w-4 shrink-0" /><span className="truncate" dir="auto">{m.mediaName || t.wa.document}</span></a>
          : <Pending m={m} t={t} />)}
        {m.type === "unsupported" && <div className="italic text-ink-soft">{t.wa.unsupported}</div>}
        {m.body && <div className="whitespace-pre-wrap [overflow-wrap:anywhere]" dir="auto">{m.body}</div>}
        <div className="mt-0.5 flex items-center justify-end gap-1.5 text-[0.625rem] text-ink-soft">
          <span className="num">{time(m.at)}</span>
          {out && <Ticks s={m.status} error={m.error} t={t} />}
        </div>
        {out && m.status === "failed" && m.error && <div className="mt-1 text-[0.6875rem] text-red-700 [overflow-wrap:anywhere]">{m.error}</div>}
      </div>
    </div>
  );
}

function Pending({ m, t }: { m: Msg; t: Dict }) {
  return <div className="mb-1 flex items-center gap-2 rounded-lg bg-black/5 px-2.5 py-2 text-xs text-ink-soft"><Icon name="clip" className="h-4 w-4" />{m.error ? t.wa.mediaFailed : t.wa.mediaLoading}</div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") ref.current(); };
    document.addEventListener("keydown", esc);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) ref.current(); }}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={() => ref.current()} className="btn-ghost px-2 py-1.5" aria-label="×"><Icon name="x" className="h-4 w-4" /></button></div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function NewChat({ t, customers, onClose, onOpen }: { t: Dict; customers: Customer[]; onClose: () => void; onOpen: (id: string) => void }) {
  const W = t.wa;
  const [phone, setPhone] = useState("");
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [busy, start] = useTransition();
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return customers.filter((c) => c.phone && (!s || c.name.toLowerCase().includes(s) || c.phone.replace(/\D/g, "").includes(s.replace(/\D/g, "") || "§"))).slice(0, 30);
  }, [customers, q]);
  const go = (p: string, customerId?: string) => start(async () => {
    setErr("");
    const r = await waOpenChatAction({ phone: p, customerId: customerId ?? null }).catch(() => ({ ok: false as const, error: "network" }));
    if (!r.ok || !r.data) { setErr((W.errors as Record<string, string>)[r.ok ? "error" : r.error] ?? W.errors.error); return; }
    onOpen(r.data);
  });
  return (
    <Modal title={W.newChat} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); go(phone); }} className="space-y-2">
        <label htmlFor="wa-phone" className="block text-xs font-bold text-ink-soft">{W.phone}</label>
        <div className="flex gap-2">
          <input id="wa-phone" value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" inputMode="tel" placeholder="+49 178 1234567" className="input min-w-0 flex-1" autoFocus />
          <button disabled={busy || !phone.trim()} className="btn-primary shrink-0">{W.open}</button>
        </div>
        <p className="text-[0.6875rem] text-ink-soft">{W.phoneHint}</p>
      </form>
      {customers.length > 0 && (
        <div className="mt-4 space-y-2">
          <label htmlFor="wa-cust" className="block text-xs font-bold text-ink-soft">{W.orCustomer}</label>
          <input id="wa-cust" value={q} onChange={(e) => setQ(e.target.value)} placeholder={W.searchCustomer} className="input" />
          <ul className="max-h-64 divide-y divide-black/5 overflow-y-auto rounded-xl ring-1 ring-black/5">
            {list.map((c) => (
              <li key={c.id}><button type="button" disabled={busy} onClick={() => go(c.phone, c.id)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-emerald-50">
                <span className="truncate font-semibold" dir="auto">{c.name}</span><bdi dir="ltr" className="num shrink-0 text-xs text-ink-soft">{c.phone}</bdi></button></li>
            ))}
            {list.length === 0 && <li className="px-3 py-2 text-xs text-ink-soft">{W.noCustomerPhone}</li>}
          </ul>
        </div>
      )}
      {err && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{err}</p>}
    </Modal>
  );
}

function TemplatePicker({ t, chatId, onClose, onSent }: { t: Dict; chatId: string; onClose: () => void; onSent: () => void }) {
  const W = t.wa;
  const [list, setList] = useState<Tpl[] | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<Tpl | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [busy, start] = useTransition();
  useEffect(() => {
    waTemplatesAction().then((r) => { if (r.ok) setList(r.data ?? []); else { setList([]); setErr((W.errors as Record<string, string>)[r.error] ?? W.errors.error); } }).catch(() => { setList([]); setErr(W.errors.network); });
  }, [W]);
  const preview = pick ? pick.body.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, i) => params[Number(i) - 1] || `{{${i}}}`) : "";
  const send = () => pick && start(async () => {
    setErr("");
    const r = await waSendTemplateAction({ chatId, name: pick.name, language: pick.language, params }).catch(() => ({ ok: false as const, error: "network" }));
    if (!r.ok) { setErr((W.errors as Record<string, string>)[r.error] ?? W.errors.error); return; }
    onSent();
  });
  return (
    <Modal title={W.sendTemplate} onClose={onClose}>
      <p className="mb-3 text-xs text-ink-soft">{W.templateHint}</p>
      {list === null ? <p className="text-sm text-ink-soft">{W.loading}</p> : list.length === 0 ? <p className="text-sm text-ink-soft">{W.noTemplates}</p> : (
        <ul className="mb-3 max-h-56 divide-y divide-black/5 overflow-y-auto rounded-xl ring-1 ring-black/5">
          {list.map((x) => (
            <li key={`${x.name}:${x.language}`}><button type="button" onClick={() => { setPick(x); setParams(Array(x.params).fill("")); }}
              className={`w-full px-3 py-2 text-start text-sm ${pick === x ? "bg-emerald-50" : "hover:bg-slate-50"}`}>
              <span className="font-semibold">{x.name}</span> <span className="text-xs text-ink-soft">· {x.language} · {x.category}</span>
              <span className="block truncate text-xs text-ink-soft" dir="auto">{x.body}</span></button></li>
          ))}
        </ul>
      )}
      {pick && (
        <div className="space-y-2">
          {params.map((p, i) => (
            <input key={i} value={p} onChange={(e) => setParams(params.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`{{${i + 1}}}`} dir="auto" className="input" aria-label={`{{${i + 1}}}`} />
          ))}
          <div className="whitespace-pre-wrap rounded-xl bg-[#d9fdd3] p-3 text-sm" dir="auto">{preview}</div>
          <button type="button" onClick={send} disabled={busy || params.some((p) => !p.trim())} className="btn w-full bg-emerald-600 py-2.5 text-white shadow-card hover:bg-emerald-700">
            {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="send" className="h-4 w-4 rtl:-scale-x-100" />}{W.send}
          </button>
        </div>
      )}
      {err && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{err}</p>}
    </Modal>
  );
}

function LinkCustomer({ t, customers, current, chatId, onClose, onDone }: { t: Dict; customers: Customer[]; current: string | null; chatId: string; onClose: () => void; onDone: () => void }) {
  const W = t.wa;
  const [q, setQ] = useState("");
  const [busy, start] = useTransition();
  const [err, setErr] = useState("");
  const list = useMemo(() => { const s = q.trim().toLowerCase(); return customers.filter((c) => !s || c.name.toLowerCase().includes(s) || String(c.number) === s).slice(0, 40); }, [customers, q]);
  const set = (customerId: string | null) => start(async () => {
    const r = await waLinkAction({ chatId, customerId }).catch(() => ({ ok: false as const, error: "network" }));
    if (!r.ok) { setErr((W.errors as Record<string, string>)[r.error] ?? W.errors.error); return; }
    onDone();
  });
  return (
    <Modal title={W.linkCustomer} onClose={onClose}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={W.searchCustomer} className="input mb-2" autoFocus />
      <ul className="max-h-72 divide-y divide-black/5 overflow-y-auto rounded-xl ring-1 ring-black/5">
        {list.map((c) => (
          <li key={c.id}><button type="button" disabled={busy} onClick={() => set(c.id)} className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm ${c.id === current ? "bg-emerald-50" : "hover:bg-slate-50"}`}>
            <span className="truncate font-semibold" dir="auto">{c.name}</span><span className="num shrink-0 text-xs text-ink-soft">{c.number}</span></button></li>
        ))}
      </ul>
      {current && <button type="button" disabled={busy} onClick={() => set(null)} className="btn-ghost mt-3 w-full text-red-700"><Icon name="x" className="h-4 w-4" />{W.unlink}</button>}
      {err && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{err}</p>}
    </Modal>
  );
}
