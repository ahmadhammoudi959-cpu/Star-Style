"use client";
/**
 * „Löschen“ für Stammdaten, die aus Versehen angelegt wurden (Lieferant, Firma aus Ausgaben, Kunde; Wunsch Inhaber 17.11.2026).
 * Karte unten auf der Detailseite: entweder Knopf + eigenes Bestätigungsfenster (Fokus auf „Abbrechen“) oder – wenn Belege
 * darauf verweisen – warum es nicht geht und was man vorher tun kann. Der Server prüft beim Löschen noch einmal.
 * Für den Assistenten gesperrt (data-ai-block): löschen macht nur der Mensch.
 */
import { useActionState, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Icon } from "./Icon";
import { ErrorBox } from "./Forms";
import type { Dict } from "@/i18n/de";

export type DeleteState = { error?: "notFound" | "used" | "error" } | undefined;
export type DeleteBlock = { text: string; links?: { href: string; label: string }[] };

export function DeleteRecord({ texts, cancel, label, name, id, action, blocked, docs }: {
  texts: Dict["remove"]; cancel: string; label: string; name: string; id: string;
  action: (prev: DeleteState, fd: FormData) => Promise<DeleteState>;
  /** Gründe, warum nicht gelöscht werden kann (leer = darf gelöscht werden) */
  blocked: DeleteBlock[];
  /** Belege dabei → Hinweis „10 Jahre aufbewahren“ */
  docs?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [ask, setAsk] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const err = state?.error ? texts.errors[state.error] ?? texts.errors.error : undefined;

  if (blocked.length) return (
    <section data-delete-blocked className="card mt-6 animate-rise p-5">
      <h2 className="flex items-center gap-2 font-bold"><Icon name="lock" className="icon-pop h-5 w-5 text-ink-soft" />{texts.blocked}</h2>
      <ul className="mt-3 space-y-1.5 text-sm">
        {blocked.map((b) => (
          <li key={b.text} className="rounded-lg bg-slate-50 px-3 py-2">
            <span>{b.text}</span>
            {b.links && b.links.length > 0 && (
              <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {b.links.map((l) => <Link key={l.href} href={l.href} className="font-semibold text-brand-700 hover:underline">{l.label}</Link>)}
              </span>
            )}
          </li>
        ))}
      </ul>
      {docs && <p className="mt-3 text-sm text-ink-soft">{texts.keepDocs}</p>}
    </section>
  );

  return (
    <form ref={form} action={formAction} data-ai-block data-delete-record className="card mt-6 flex animate-rise flex-wrap items-center justify-between gap-3 p-5">
      <input type="hidden" name="id" value={id} />
      <p className="min-w-0 flex-1 text-sm text-ink-soft">{texts.hint}</p>
      <button type="button" onClick={() => setAsk(true)} disabled={pending} className="btn-danger group" data-delete-open>
        <Icon name="trash" className="icon-pop h-4 w-4" />{label}
      </button>
      {err && <div className="w-full"><ErrorBox message={err} /></div>}
      {ask && <AskDelete texts={texts} cancel={cancel} name={name}
        onNo={() => setAsk(false)} onYes={() => { setAsk(false); form.current?.requestSubmit(); }} />}
    </form>
  );
}

function AskDelete({ texts, cancel, name, onYes, onNo }: { texts: Dict["remove"]; cancel: string; name: string; onYes: () => void; onNo: () => void }) {
  const noRef = useRef(onNo);
  noRef.current = onNo;
  const no = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") noRef.current(); };
    document.addEventListener("keydown", esc);
    no.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  return createPortal(
    <div data-ai-block data-delete-ask className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4"
      role="dialog" aria-modal="true" aria-labelledby="delete-ask-title" onMouseDown={(e) => { if (e.target === e.currentTarget) noRef.current(); }}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-4 flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><Icon name="trash" className="icon-pop h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 id="delete-ask-title" className="text-lg font-bold leading-snug [overflow-wrap:anywhere]">{texts.ask.replace("{name}", name)}</h2>
            <p className="mt-1 text-sm text-ink-soft">{texts.askText}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onYes} data-delete-yes className="btn group w-full bg-red-600 py-3 text-base text-white shadow-card hover:bg-red-700">
            <Icon name="trash" className="h-5 w-5" />{texts.yes}
          </button>
          <button ref={no} type="button" onClick={onNo} data-delete-no className="btn-ghost w-full">{cancel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
