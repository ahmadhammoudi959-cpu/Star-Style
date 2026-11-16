"use client";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { formatCents, parseMoney } from "@/lib/money";
import { planReturn, RETURN_REASONS, type PlanInvoice, type ReturnReason } from "@/lib/returns-plan";
import { bookReturnAction } from "../actions";

type Line = PlanInvoice["lines"][number] & { code: string };
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
type Method = "CASH" | "BANK" | "CARD";

/**
 * Retoure erfassen (Wunsch Inhaber 16.11.2026): je Position „zurück ins Lager“ und „beschädigt“, Grund, Erstattung.
 * Die Vorschau rechnet wie der Server (planReturn); gebucht wird erst nach der Rückfrage.
 */
export function ReturnForm({ t, intl, invoice, canRefund }: {
  t: Dict; intl: string; canRefund: boolean;
  invoice: { id: string; number: string; custName: string; issueDate: string; plan: Omit<PlanInvoice, "lines"> & { lines: Line[] } };
}) {
  const R = t.ret;
  const inv = invoice.plan;
  const [qty, setQty] = useState<Record<string, { restock: number; damaged: number }>>({});
  const [reason, setReason] = useState<ReturnReason | "">("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"now" | "keep">("now");
  const [method, setMethod] = useState<Method>("CASH");
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState(false);
  const [busy, start] = useTransition();

  const picks = inv.lines.map((l) => ({ lineId: l.id, restock: qty[l.id]?.restock ?? 0, damaged: qty[l.id]?.damaged ?? 0 }));
  const plan = useMemo(() => planReturn(inv, picks), [inv, JSON.stringify(picks)]); // eslint-disable-line react-hooks/exhaustive-deps
  const refundable = plan.ok ? plan.refundableCents : 0;
  const money = (c: number) => formatCents(c, intl);

  // Betrag folgt dem Guthaben, bis man selbst etwas einträgt
  useEffect(() => { if (!amountTouched) setAmount(refundable > 0 ? (refundable / 100).toFixed(2).replace(".", ",") : ""); }, [refundable, amountTouched]);
  const amountCents = parseMoney(amount);
  const refundOn = canRefund && refundable > 0 && mode === "now";
  const amountBad = refundOn && (amountCents == null || amountCents <= 0 || amountCents > refundable);

  const set = (id: string, k: "restock" | "damaged", v: number, max: number) => {
    setError("");
    setQty((q) => {
      const cur = q[id] ?? { restock: 0, damaged: 0 };
      const other = k === "restock" ? cur.damaged : cur.restock;
      const val = Math.max(0, Math.min(Math.round(Number.isFinite(v) ? v : 0), max - other));
      return { ...q, [id]: { ...cur, [k]: val } };
    });
  };
  const allBack = () => { setError(""); setQty(Object.fromEntries(inv.lines.map((l) => [l.id, { restock: l.qty, damaged: 0 }]))); };
  const clear = () => { setError(""); setQty({}); };

  const errText = (code: string, detail?: string) => {
    const m = (R.errors as Record<string, string>)[code] ?? R.errors.error;
    return fill(m, { max: detail && /^\d+$/.test(detail) ? money(Number(detail)) : "" });
  };

  const tryBook = () => {
    setError("");
    if (!plan.ok) { setError(errText(plan.error)); return; }
    if (!reason) { setError(R.errors.reason); return; }
    if (amountBad) { setError(fill(R.errors.refundTooHigh, { max: money(refundable) })); return; }
    setAsk(true);
  };
  const book = () => {
    setAsk(false);
    start(async () => {
      let r;
      try {
        r = await bookReturnAction({
          invoiceId: invoice.id, reason, note, picks: picks.filter((p) => p.restock > 0 || p.damaged > 0),
          refund: refundOn && amountCents ? { method, amountCents } : null,
        });
      } catch { r = { ok: false as const, error: "error" }; }
      if (!r.ok) { setError(errText(r.error, r.detail)); return; }
      window.location.assign(`/returns/${r.id}?booked=1`);
    });
  };

  const damagedUnits = plan.ok ? plan.lines.filter((x) => x.condition === "DAMAGED").reduce((s, x) => s + x.qty, 0) : 0;
  const facts = plan.ok ? [
    fill(R.doCancel, { n: invoice.number }),
    !plan.full && fill(R.doNewInvoice, { amount: money(plan.newGrossCents) }),
    plan.units - damagedUnits > 0 && fill(R.doRestock, { n: plan.units - damagedUnits }),
    damagedUnits > 0 && fill(R.doLoss, { n: damagedUnits }),
    refundOn && amountCents ? fill(R.doRefund, { amount: money(amountCents), method: R.refundMethods[method] }) : false,
    refundable > 0 && (!refundOn || (amountCents ?? 0) < refundable) ? fill(R.doKeepCredit, { amount: money(refundable - (refundOn ? amountCents ?? 0 : 0)) }) : false,
  ].filter(Boolean) as string[] : [];

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        <section className="card animate-rise overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/5 p-5">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="undo" className="h-5 w-5 text-brand-600" />{R.goods}</h2>
              <p className="text-sm text-ink-soft"><bdi dir="ltr" className="font-semibold">{invoice.number}</bdi> · {invoice.custName}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={allBack} className="btn-ghost group px-3 py-2 text-sm"><Icon name="history" className="h-4 w-4" />{R.allBack}</button>
              <button type="button" onClick={clear} className="btn-ghost group px-3 py-2 text-sm"><Icon name="x" className="h-4 w-4" />{R.clear}</button>
            </div>
          </div>
          <ul className="divide-y divide-black/5">
            {[...inv.lines].sort((a, b) => a.position - b.position).map((l) => {
              const q = qty[l.id] ?? { restock: 0, damaged: 0 };
              const active = q.restock + q.damaged > 0;
              return (
                <li key={l.id} className={`grid gap-3 p-4 transition md:grid-cols-[minmax(0,1fr)_auto] md:items-center ${active ? "bg-brand-50/50" : ""}`}>
                  <div className="min-w-0">
                    <div className="font-semibold [overflow-wrap:anywhere]">{l.description}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-soft">
                      {l.code && <bdi dir="ltr" className="num">{l.code}</bdi>}
                      <span>{R.sold}: <b className="num">{l.qty}</b> × <span className="num">{money(l.unitPriceCents)}</span></span>
                      {!l.variantId && <span className="badge bg-slate-100 text-slate-600">{R.creditOnly}</span>}
                    </div>
                  </div>
                  <div className={`grid gap-2 ${l.variantId ? "grid-cols-2" : "grid-cols-1"} md:w-[19rem]`}>
                    <Stepper label={l.variantId ? R.restock : R.credit} value={q.restock} max={l.qty - q.damaged} onChange={(v) => set(l.id, "restock", v, l.qty)} tone="brand" />
                    {l.variantId && <Stepper label={R.damaged} value={q.damaged} max={l.qty - q.restock} onChange={(v) => set(l.id, "damaged", v, l.qty)} tone="amber" />}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="card animate-rise grid gap-4 p-5 md:grid-cols-2">
          <div>
            <label htmlFor="ret-reason" className="mb-1 block text-xs font-bold text-ink-soft">{R.reason}</label>
            <select id="ret-reason" value={reason} onChange={(e) => { setError(""); setReason(e.target.value as ReturnReason); }} className="input">
              <option value="">{R.reasonPick}</option>
              {RETURN_REASONS.map((r) => <option key={r} value={r}>{R.reasons[r]}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ret-note" className="mb-1 block text-xs font-bold text-ink-soft">{R.note}</label>
            <textarea id="ret-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} className="input" dir="auto" />
          </div>
        </section>
      </div>

      <aside className="card h-fit animate-rise space-y-4 p-5 xl:sticky xl:top-4">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="receipt" className="h-5 w-5 text-brand-600" />{R.summary}</h2>
        {!plan.ok ? <p className="rounded-xl bg-slate-50 p-3 text-sm text-ink-soft ring-1 ring-black/5">{R.pickHintLines}</p> : (
          <>
            <dl className="space-y-1.5 text-sm">
              <Row k={R.units} v={String(plan.units)} sub={damagedUnits ? `${R.ofDamaged}: ${damagedUnits}` : ""} />
              <Row k={R.creditAmount} v={money(plan.creditCents)} strong />
              <Row k={R.paidSoFar} v={money(inv.paidCents)} />
            </dl>
            <p className="rounded-xl bg-brand-50/70 p-3 text-sm font-semibold text-brand-900 ring-1 ring-brand-100">
              {plan.full ? R.fullCancel : fill(R.newInvoice, { new: money(plan.newGrossCents), old: money(inv.grossCents) })}
            </p>
            {refundable > 0 && (
              <div className="space-y-2 rounded-xl bg-violet-50/70 p-3 ring-1 ring-violet-100">
                <div className="flex items-center justify-between gap-2 text-sm"><span className="font-bold text-violet-900">{R.customerCredit}</span><b className="num text-violet-900">{money(refundable)}</b></div>
                {canRefund ? (
                  <>
                    <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={R.refundTitle}>
                      {(["now", "keep"] as const).map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                          className={`rounded-lg px-2 py-2 text-xs font-bold ring-1 transition ${mode === m ? "bg-violet-600 text-white ring-violet-600" : "bg-white text-violet-900 ring-violet-200 hover:bg-violet-100"}`}>
                          {m === "now" ? R.refundNow : R.refundKeep}
                        </button>
                      ))}
                    </div>
                    {mode === "now" && (
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2 flex gap-1.5">
                          {(["CASH", "BANK", "CARD"] as const).map((m) => (
                            <button key={m} type="button" onClick={() => setMethod(m)} aria-pressed={method === m}
                              className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold ring-1 transition ${method === m ? "bg-white text-violet-900 ring-2 ring-violet-500" : "bg-white/60 text-ink-soft ring-violet-100 hover:bg-white"}`}>
                              {R.refundMethods[m]}
                            </button>
                          ))}
                        </div>
                        <label className="col-span-2 block">
                          <span className="mb-1 block text-xs font-bold text-violet-900">{R.refundAmount}</span>
                          <input value={amount} onChange={(e) => { setAmountTouched(true); setAmount(e.target.value); }} inputMode="decimal" dir="ltr"
                            className={`input num ${amountBad ? "ring-2 ring-red-400" : ""}`} aria-invalid={amountBad} />
                        </label>
                      </div>
                    )}
                  </>
                ) : <p className="text-xs text-violet-900">{R.creditStays}</p>}
              </div>
            )}
            {refundable === 0 && inv.paidCents > 0 && <p className="text-xs text-ink-soft">{R.nothingToRefund}</p>}
          </>
        )}
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800 ring-1 ring-red-200">{error}</p>}
        <button type="button" onClick={tryBook} disabled={busy || !plan.ok} className="btn-primary group w-full py-3 text-base">
          {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="check" className="h-5 w-5" />}{R.submit}
        </button>
        <p className="text-xs text-ink-soft">{R.gobdHint}</p>
      </aside>

      {ask && <Confirm title={R.confirmTitle} facts={facts} yes={R.confirm} no={t.common.cancel} note={R.gobdHint} onYes={book} onNo={() => setAsk(false)} />}
    </div>
  );
}

function Row({ k, v, sub, strong }: { k: string; v: string; sub?: string; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-ink-soft">{k}{sub && <span className="block text-xs text-amber-700">{sub}</span>}</dt>
      <dd className={`num ${strong ? "text-base font-bold text-brand-700" : "font-semibold"}`}>{v}</dd>
    </div>
  );
}

function Stepper({ label, value, max, onChange, tone }: { label: string; value: number; max: number; onChange: (v: number) => void; tone: "brand" | "amber" }) {
  const ring = tone === "amber" ? (value > 0 ? "ring-amber-300 bg-amber-50" : "ring-black/10 bg-white") : value > 0 ? "ring-brand-300 bg-white" : "ring-black/10 bg-white";
  return (
    <div className="min-w-0">
      <div className={`mb-1 truncate text-[0.6875rem] font-bold ${tone === "amber" ? "text-amber-800" : "text-brand-800"}`}>{label}</div>
      <div className={`flex items-center overflow-hidden rounded-xl ring-1 ${ring}`}>
        <button type="button" onClick={() => onChange(value - 1)} disabled={value <= 0} aria-label="−" className="grid h-10 w-10 shrink-0 place-items-center text-lg font-bold text-ink-soft transition hover:bg-black/5 disabled:opacity-30">−</button>
        <input value={value || ""} onChange={(e) => onChange(Number(e.target.value.replace(/\D/g, "") || 0))} inputMode="numeric" dir="ltr" placeholder="0" aria-label={label}
          className="num h-10 w-full min-w-0 bg-transparent text-center font-bold outline-none" />
        <button type="button" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label="+" className="grid h-10 w-10 shrink-0 place-items-center text-lg font-bold text-ink-soft transition hover:bg-black/5 disabled:opacity-30">+</button>
      </div>
    </div>
  );
}

function Confirm({ title, facts, yes, no, note, onYes, onNo }: { title: string; facts: string[]; yes: string; no: string; note: string; onYes: () => void; onNo: () => void }) {
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
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="ret-ask-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) noRef.current(); }}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700"><Icon name="undo" className="icon-pop h-6 w-6" /></span>
          <div className="min-w-0"><h2 id="ret-ask-title" className="text-lg font-bold leading-snug">{title}</h2><p className="mt-1 text-xs text-ink-soft">{note}</p></div>
        </div>
        <ul className="space-y-1.5 text-sm">
          {facts.map((f) => <li key={f} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />{f}</li>)}
        </ul>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" onClick={onYes} className="btn-primary group w-full py-3 text-base"><Icon name="check" className="h-5 w-5" />{yes}</button>
          <button ref={cancel} type="button" onClick={onNo} className="btn-ghost w-full">{no}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
