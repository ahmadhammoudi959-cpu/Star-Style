"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { askAction } from "../ai-actions";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

type Msg = { role: "user" | "assistant"; text: string; error?: boolean };

export function Chat({ t }: { t: Dict }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs, pending]);

  const send = (text: string) => {
    const q = text.trim();
    if (!q || pending) return;
    const next = [...msgs.filter((m) => !m.error), { role: "user" as const, text: q }];
    setMsgs(next); setInput("");
    start(async () => {
      const r = await askAction(next.map(({ role, text }) => ({ role, text })));
      setMsgs((m) => [...m, "answer" in r ? { role: "assistant", text: r.answer } : { role: "assistant", text: (t.ai.errors as Record<string, string>)[r.error] ?? t.ai.errors.other, error: true }]);
    });
  };

  return (
    <div className="card animate-rise flex min-h-[60vh] flex-col overflow-hidden">
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {msgs.length === 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {t.ai.examples.map((e) => (
              <button key={e} type="button" onClick={() => send(e)} className="card-hover group rounded-xl bg-brand-50/60 p-4 text-start text-sm font-semibold ring-1 ring-brand-100">
                <Icon name="search" className="mb-1 h-4 w-4 text-brand-600" />{e}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex animate-rise ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-card ${m.role === "user" ? "bg-brand-600 text-white" : m.error ? "bg-red-50 text-red-700 ring-1 ring-red-200" : "bg-white ring-1 ring-black/5"}`} dir="auto">
              {m.text}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <span className="flex gap-1">{[0, 1, 2].map((d) => <span key={d} className="h-2 w-2 animate-bounce rounded-full bg-brand-500" style={{ animationDelay: `${d * 150}ms` }} />)}</span>{t.ai.thinking}
          </div>
        )}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-end gap-2 border-t border-black/5 bg-slate-50/80 p-3">
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} placeholder={t.ai.placeholder} dir="auto"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
          className="input max-h-40 min-h-[2.75rem] flex-1 resize-y" />
        <button disabled={pending || !input.trim()} className="btn-primary group h-11 shrink-0"><Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" />{t.ai.send}</button>
      </form>
      <div className="flex items-center justify-between px-4 pb-2 text-xs text-ink-soft">
        <span>{t.ai.notStored}</span>
        {msgs.length > 0 && <button type="button" onClick={() => setMsgs([])} className="font-semibold text-brand-700 hover:underline">{t.ai.clear}</button>}
      </div>
    </div>
  );
}
