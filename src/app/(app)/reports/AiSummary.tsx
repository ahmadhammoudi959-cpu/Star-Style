"use client";
import { useState, useTransition } from "react";
import { summaryAction } from "../ai-actions";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

export function AiSummary({ t, month }: { t: Dict; month: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (text) return <div className="mt-4 animate-rise whitespace-pre-wrap rounded-xl bg-violet-50 p-4 text-sm leading-relaxed text-violet-950 ring-1 ring-violet-200" dir="auto">{text}</div>;
  return (
    <div className="mt-4">
      <button type="button" disabled={pending} onClick={() => start(async () => {
        setError(null);
        const r = await summaryAction(month);
        if ("text" in r) setText(r.text); else setError((t.ai.errors as Record<string, string>)[r.error] ?? t.ai.errors.other);
      })} className="btn group bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-card hover:shadow-lift disabled:opacity-60">
        {pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="search" className="h-4 w-4" />}
        {pending ? t.ai.summaryLoading : t.ai.summaryAi}
      </button>
      {error && <p className="mt-2 text-sm font-semibold text-red-600">{error}</p>}
    </div>
  );
}
