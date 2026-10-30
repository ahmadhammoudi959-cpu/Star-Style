"use client";
import { useActionState } from "react";
import { resetTestDataAction } from "./actions";
import { ErrorBox, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import type { ResetPreview } from "@/lib/test-reset-sql";

const MAX_NAMES = 8;

/** „Testdaten löschen“ – nur sichtbar, solange der Echtbetrieb nicht begonnen hat und es Testdaten gibt */
export function ResetTestData({ t, p, fingerprint, syncOn }: { t: Dict; p: ResetPreview; fingerprint: string; syncOn: boolean }) {
  const [state, action] = useActionState(resetTestDataAction, undefined);
  const r = t.reset;
  const err = state?.error ? ((r as Record<string, unknown>)[state.error] as string | undefined) ?? t.common.error : undefined;
  const names = (l: string[]) => (l.length > MAX_NAMES ? [...l.slice(0, MAX_NAMES), "…"] : l).join(" · ");
  const rows: { label: string; n: number; names?: string }[] = [
    { label: r.invoices, n: p.invoices }, { label: r.cancellations, n: p.cancellations }, { label: r.drafts, n: p.drafts },
    { label: r.offers, n: p.offers }, { label: r.payments, n: p.payments }, { label: r.receipts, n: p.receipts },
    { label: r.writeOffs, n: p.writeOffs }, { label: r.expenses, n: p.expenses },
    { label: r.customers, n: p.customers, names: names(p.customerNames) },
    { label: r.products, n: p.products.length, names: names(p.products) },
    { label: r.suppliers, n: p.suppliers.length, names: names(p.suppliers) },
    { label: r.units, n: p.units },
  ].filter((x) => x.n > 0);

  return (
    <section id="reset" className="card mt-5 scroll-mt-6 animate-rise p-5 ring-1 ring-red-100">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><Icon name="trash" className="icon-pop h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{r.title}</h2>
          <p className="text-sm text-ink-soft">{r.hint}</p>
        </div>
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {rows.map((x) => (
          <li key={x.label} className="min-w-0 rounded-xl bg-slate-50 px-3 py-2 text-sm ring-1 ring-black/[0.03]">
            <div className="flex items-baseline justify-between gap-3"><span>{x.label}</span><span className="num font-bold">{x.n}</span></div>
            {x.names && <div className="mt-0.5 break-words text-xs text-ink-soft">{x.names}</div>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-ink-soft">{r.keeps}</p>
      {syncOn ? (
        <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">{r.syncOn}</p>
      ) : (
        <form action={action} onSubmit={(e) => { if (!confirm(r.confirm)) e.preventDefault(); }} className="mt-4 space-y-3">
          <input type="hidden" name="expect" value={fingerprint} />
          <label className="flex cursor-pointer items-start gap-2 text-sm font-semibold">
            <input type="checkbox" name="confirm" required className="mt-0.5 h-5 w-5 shrink-0 accent-red-600" />{r.understand}
          </label>
          <SubmitButton className="btn-danger group"><Icon name="trash" className="icon-pop h-4 w-4" />{r.button}</SubmitButton>
          <ErrorBox message={err} />
        </form>
      )}
    </section>
  );
}
