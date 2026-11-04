"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { resetTestDataAction } from "./actions";
import { ErrorBox, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import type { ResetPreview } from "@/lib/test-reset-sql";

const MAX_CUSTOMERS = 8; // Kunden werden alle gelöscht → ein paar Namen reichen; Lieferanten immer vollständig
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/**
 * „System zurücksetzen und Echtbetrieb starten“ (Wunsch Inhaber 04.11.2026): alle Bewegungen und Vorgänge weg, alle Artikel bleiben.
 * Nur sichtbar, solange kein Echtbetrieb. Bestätigung: Häkchen + eigenes Fenster (Fokus auf „Abbrechen“).
 */
export function ResetTestData({ t, p, fingerprint, syncOn, empty }: { t: Dict; p: ResetPreview; fingerprint: string; syncOn: boolean; empty: boolean }) {
  const [state, action] = useActionState(resetTestDataAction, undefined);
  const [ask, setAsk] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const sure = useRef(false);
  useEffect(() => { sure.current = false; }, [state]);
  const r = t.reset;
  const err = state?.error ? ((r as Record<string, unknown>)[state.error] as string | undefined) ?? t.common.error : undefined;
  const names = (l: string[], max = Infinity) => (l.length > max ? [...l.slice(0, max), "…"] : l).join(" · ");
  const rows: { label: string; n: number; names?: string }[] = [
    { label: r.invoices, n: p.invoices }, { label: r.cancellations, n: p.cancellations }, { label: r.drafts, n: p.drafts },
    { label: r.offers, n: p.offers }, { label: r.payments, n: p.payments }, { label: r.receipts, n: p.receipts },
    { label: r.writeOffs, n: p.writeOffs }, { label: r.expenses, n: p.expenses },
    { label: r.customers, n: p.customers, names: names(p.customerNames, MAX_CUSTOMERS) },
    { label: r.suppliers, n: p.suppliers.length, names: names(p.suppliers) },
    { label: r.units, n: p.units },
  ].filter((x) => x.n > 0);

  return (
    <section id="reset" className="card mt-5 scroll-mt-6 animate-rise p-5 ring-1 ring-red-100">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><Icon name="history" className="icon-pop h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{r.title}</h2>
          <p className="text-sm text-ink-soft">{r.hint}</p>
        </div>
      </div>
      {rows.length > 0 ? (
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {rows.map((x) => (
            <li key={x.label} className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-black/[0.03]">
              <div className="flex items-baseline justify-between gap-3"><span>{x.label}</span><span className="num font-bold">{x.n}</span></div>
              {x.names && <div className="mt-0.5 break-words text-xs text-ink-soft">{x.names}</div>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-xl bg-slate-50 px-3 py-2 text-sm text-ink-soft ring-1 ring-black/[0.03]">{r.nothing}</p>
      )}
      <p className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-100">
        <Icon name="box" className="mt-0.5 h-4 w-4 shrink-0" />{fill(r.keeps, { n: p.productsKept })}
      </p>
      <p className="mt-2 rounded-xl bg-brand-50/60 px-3 py-2 text-sm font-semibold text-brand-800 ring-1 ring-brand-100">{r.order}</p>
      {syncOn ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">
          <span>{r.syncOn}</span>
          <Link href="/shops" className="btn-ghost group shrink-0 px-3 py-1.5 text-xs"><Icon name="globe" className="h-4 w-4" />{r.toShops}</Link>
        </div>
      ) : (
        <form ref={formRef} action={action} className="mt-4 space-y-3"
          onSubmit={(e) => { if (!sure.current) { e.preventDefault(); setAsk(true); } }}>
          <input type="hidden" name="expect" value={fingerprint} />
          <label className="flex cursor-pointer items-start gap-2 text-sm font-semibold">
            <input type="checkbox" name="confirm" required className="mt-0.5 h-5 w-5 shrink-0 accent-red-600" />{r.understand}
          </label>
          <SubmitButton className="btn-danger group"><Icon name="history" className="icon-pop h-4 w-4" />{r.button}</SubmitButton>
          <ErrorBox message={err} />
        </form>
      )}
      {ask && (
        <ConfirmReset t={t} empty={empty} invoices={p.invoices + p.cancellations + p.drafts} customers={p.customers} units={p.units} products={p.productsKept}
          onNo={() => setAsk(false)}
          onYes={() => { sure.current = true; setAsk(false); formRef.current?.requestSubmit(); }} />
      )}
    </section>
  );
}

/** Letzte Rückfrage als eigenes Fenster (nicht das Browser-Fenster): klar, in der Sprache des Nutzers, Enter = Abbrechen */
function ConfirmReset({ t, empty, invoices, customers, units, products, onYes, onNo }: {
  t: Dict; empty: boolean; invoices: number; customers: number; units: number; products: number; onYes: () => void; onNo: () => void;
}) {
  const r = t.reset;
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
  const facts = [
    !empty && fill(r.factDelete, { i: invoices, c: customers, u: units }),
    fill(r.factKeep, { n: products }),
    r.factLive,
  ].filter(Boolean) as string[];

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="reset-ask-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) noRef.current(); }}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><Icon name="alert" className="icon-pop h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 id="reset-ask-title" className="text-lg font-bold leading-snug">{r.confirmTitle}</h2>
            <p className="mt-1 text-sm text-ink-soft">{r.confirm}</p>
          </div>
        </div>
        <ul className="space-y-1.5 text-sm">
          {facts.map((f) => <li key={f} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />{f}</li>)}
        </ul>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" onClick={onYes} className="btn group w-full bg-red-600 py-3 text-base text-white shadow-card hover:bg-red-700">
            <Icon name="history" className="h-5 w-5" />{r.yes}
          </button>
          <button ref={cancel} type="button" onClick={onNo} className="btn-ghost w-full">{t.common.cancel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
