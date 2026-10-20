"use client";
import { useActionState, useEffect, useMemo, useState } from "react";
import { saveInvoiceAction, saveOfferAction } from "./actions";
import { ErrorBox, Field } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { VariantPicker, optionLabel, type PickerOption } from "@/components/VariantPicker";
import { bpToPercent, formatCents, parseMoney, parsePercentToBp } from "@/lib/money";
import { computeTotals, determineTaxMode, effectiveRateBp } from "@/lib/tax";
import type { Dict } from "@/i18n/de";
import { PlanEditor, fromPlanRows, toPlanRows, type PlanRow } from "./PlanEditor";

export type CustomerOpt = { id: string; number: number; name: string; city: string; type: "COMPANY" | "PERSON"; country: string; vatIdStatus: "NONE" | "PENDING" | "VALID" | "INVALID"; priceGroup: "WHOLESALE" | "RETAIL"; openCents?: number; creditLimitCents?: number | null };
export type SaleOption = PickerOption & { wholesalePriceCents: number; retailPriceCents: number; vatRateBp: number; available: number };
export type EditorLine = { variantId: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; vatRateBp: number };
export type EditorInitial = {
  id?: string; customerId: string; date: string; validUntil?: string; channel?: string; deliveryDate?: string;
  discountBp: number; notes: string; retentionOfTitle?: boolean;
  offerId?: string | null; replacesInvoiceId?: string | null; lines: EditorLine[];
  initialPaymentCents?: number; initialPaymentMethod?: "CASH" | "BANK" | "CARD" | "ONLINE" | null;
  installments?: { dueDate: string; amountCents: number }[];
};

type L = { key: string; variantId: string | null; description: string; qty: string; price: string; disc: string; vatRateBp: number; available?: number };
const toInput = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export function DocEditor({ t, kind, customers, options, initial, intl }: {
  t: Dict; kind: "offer" | "invoice"; customers: CustomerOpt[]; options: SaleOption[]; initial: EditorInitial; intl: string;
}) {
  const [state, action, pending] = useActionState(kind === "offer" ? saveOfferAction : saveInvoiceAction, undefined);
  const [customerId, setCustomerId] = useState(initial.customerId);
  const [cq, setCq] = useState("");
  const customer = customers.find((c) => c.id === customerId);
  const optById = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const [lines, setLines] = useState<L[]>(initial.lines.map((l) => ({
    key: crypto.randomUUID(), variantId: l.variantId, description: l.description, qty: String(l.qty), price: toInput(l.unitPriceCents),
    disc: l.discountBp ? bpToPercent(l.discountBp) : "", vatRateBp: l.variantId ? optById.get(l.variantId)?.vatRateBp ?? l.vatRateBp : l.vatRateBp,
    available: l.variantId ? optById.get(l.variantId)?.available : undefined,
  })));
  const [docDisc, setDocDisc] = useState(initial.discountBp ? bpToPercent(initial.discountBp) : "");
  // Welcher Knopf gedrückt wurde – nur für die Lade-Anzeige (Wert kommt über name/value des Knopfs ins Formular)
  const [clicked, setClicked] = useState<"save" | "issue" | null>(null);
  // Gedrückter Knopf als kontrolliertes Feld: React rendert synchron vor dem Absenden,
  // daher landet der richtige Wert sicher im Formular (name/value am Knopf ging verloren).
  const choose = (v: "save" | "issue") => setClicked(v);
  useEffect(() => { if (state) setClicked(null); }, [state]);

  const mode = customer ? determineTaxMode(customer) : "DOMESTIC";
  const parsed = lines.map((l) => ({
    variantId: l.variantId, description: l.description.trim(), qty: parseInt(l.qty) || 0, unitPriceCents: parseMoney(l.price) ?? -1,
    discountBp: parsePercentToBp(l.disc) ?? -1, vatRateBp: effectiveRateBp(mode, l.vatRateBp, { country: customer?.country ?? "DE", ossExceeded: false }),
  }));
  const valid = parsed.every((l) => l.qty > 0 && l.unitPriceCents >= 0 && l.discountBp >= 0 && l.description) && (parsePercentToBp(docDisc) ?? -1) >= 0;
  const totals = valid ? computeTotals(parsed, parsePercentToBp(docDisc) ?? 0) : null;
  const gross = totals?.grossCents ?? 0;

  // Zahlung bei Ausstellung + Ratenplan (nur Rechnungen)
  const [payMode, setPayMode] = useState<"none" | "full" | "partial">(initial.initialPaymentCents ? "partial" : "none");
  const [partial, setPartial] = useState(initial.initialPaymentCents ? toInput(initial.initialPaymentCents) : "");
  const [payMethod, setPayMethod] = useState<"CASH" | "BANK" | "CARD" | "ONLINE">(initial.initialPaymentMethod ?? "CASH");
  const [planOn, setPlanOn] = useState(Boolean(initial.installments?.length));
  const [planRows, setPlanRows] = useState<PlanRow[]>(toPlanRows(initial.installments ?? []));
  const initialPaid = payMode === "full" ? gross : payMode === "partial" ? Math.min(parseMoney(partial) ?? 0, gross) : 0;
  const plan = planOn ? fromPlanRows(planRows) : [];
  const planOk = !planOn || (plan.length > 0 && plan.every((r) => r.amountCents > 0 && r.dueDate) && plan.reduce((s, r) => s + r.amountCents, 0) === gross);
  const overLimit = kind === "invoice" && customer?.creditLimitCents != null && (customer.openCents ?? 0) + gross - initialPaid > customer.creditLimitCents;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());

  const pick = (o: PickerOption) => {
    const s = o as SaleOption;
    const price = customer?.priceGroup === "RETAIL" ? s.retailPriceCents : s.wholesalePriceCents;
    setLines((ls) => {
      const ex = ls.find((l) => l.variantId === s.id);
      if (ex) return ls.map((l) => (l === ex ? { ...l, qty: String((parseInt(l.qty) || 0) + 1) } : l));
      return [...ls, { key: crypto.randomUUID(), variantId: s.id, description: optionLabel(s), qty: "1", price: toInput(price), disc: "", vatRateBp: s.vatRateBp, available: s.available }];
    });
  };
  const upd = (k: string, p: Partial<L>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));
  const move = (i: number, d: number) => setLines((ls) => { const c = [...ls]; const [x] = c.splice(i, 1); c.splice(i + d, 0, x); return c; });

  const filteredCustomers = cq.trim() ? customers.filter((c) => `${c.name} ${c.city} ${c.number}`.toLowerCase().includes(cq.toLowerCase())) : customers;
  const err = state?.error ? ((t.sales as Record<string, unknown>)[state.error] as string | undefined) ?? t.common.error : undefined;

  return (
    <form action={action} className="space-y-5">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      {initial.offerId && <input type="hidden" name="offerId" value={initial.offerId} />}
      {initial.replacesInvoiceId && <input type="hidden" name="replacesInvoiceId" value={initial.replacesInvoiceId} />}
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="intent" value={clicked ?? "save"} readOnly />
      <input type="hidden" name="discountBp" value={parsePercentToBp(docDisc) ?? 0} />
      {kind === "invoice" && <>
        <input type="hidden" name="initialPaymentCents" value={initialPaid} />
        <input type="hidden" name="initialPaymentMethod" value={payMethod} />
        <input type="hidden" name="installments" value={JSON.stringify(plan)} />
      </>}
      <input type="hidden" name="lines" value={JSON.stringify(parsed.map((l, i) => ({ ...l, vatRateBp: lines[i].vatRateBp })))} />
      <ErrorBox message={err ? `${err}${state?.detail ? `: ${state.detail}` : ""}` : undefined} />

      {initial.replacesInvoiceId && (
        <div className="flex animate-rise items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">
          <Icon name="history" className="mt-0.5 h-4 w-4 shrink-0" />{t.sales.correctHint}
        </div>
      )}

      <section className="card grid gap-4 p-5 md:grid-cols-[1.4fr_1fr] animate-rise">
        <div>
          <span className="label">{t.sales.customer}</span>
          {customer ? (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-brand-50 p-3 ring-1 ring-brand-100">
              <div>
                <div className="font-bold">{customer.name}</div>
                <div className="text-xs text-ink-soft">{t.customer.number} {customer.number} · {customer.city} {customer.country} · {t.customer[customer.priceGroup]}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="badge bg-white text-brand-700 ring-1 ring-brand-100">{t.taxMode[mode]}</span>
                {!initial.replacesInvoiceId && <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setCustomerId("")}>{t.common.edit}</button>}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder={t.sales.pickCustomer} className="input" />
              <div className="max-h-56 overflow-auto rounded-xl ring-1 ring-black/5">
                {filteredCustomers.slice(0, 30).map((c) => (
                  <button type="button" key={c.id} onClick={() => setCustomerId(c.id)} className="flex w-full items-center justify-between px-3 py-2 text-start text-sm hover:bg-brand-50">
                    <span className="font-semibold">{c.name}</span><span className="text-xs text-ink-soft">{c.city} {c.country}</span>
                  </button>
                ))}
                <a href="/customers/new" className="flex items-center gap-2 px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50"><Icon name="plus" className="h-4 w-4" />{t.customer.new}</a>
              </div>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {kind === "offer" ? (
            <>
              <Field label={t.common.date}><input type="date" name="date" defaultValue={initial.date} required className="input" /></Field>
              <Field label={t.sales.validUntil}><input type="date" name="validUntil" defaultValue={initial.validUntil} required className="input" /></Field>
            </>
          ) : (
            <>
              <Field label={t.sales.channel}>
                <select name="channel" defaultValue={initial.channel ?? "STORE"} className="input">
                  {(["STORE", "BRAND_SHOP", "GENERAL_SHOP"] as const).map((c) => <option key={c} value={c}>{t.sales.channels[c]}</option>)}
                </select>
              </Field>
              <Field label={`${t.sales.deliveryDate} (${t.common.optional})`}><input type="date" name="deliveryDate" defaultValue={initial.deliveryDate} className="input" /></Field>
            </>
          )}
        </div>
      </section>

      <section className="card p-5 animate-rise">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">{t.sales.lines}</h2>
          <button type="button" className="btn-ghost group px-3 py-2 text-xs"
            onClick={() => setLines((ls) => [...ls, { key: crypto.randomUUID(), variantId: null, description: "", qty: "1", price: "", disc: "", vatRateBp: 1900 }])}>
            <Icon name="plus" className="h-4 w-4" />{t.sales.freeText}
          </button>
        </div>
        <VariantPicker options={options} placeholder={t.receive.pickProduct} onPick={pick} stockLabel={t.sales.available} />
        <div className="mt-4 space-y-2">
          {lines.length === 0 && <p className="py-6 text-center text-sm text-ink-soft">{t.sales.noLines}</p>}
          {lines.map((l, i) => {
            const qty = parseInt(l.qty) || 0;
            const short = l.available != null && qty > l.available;
            const net = totals?.lines[i]?.netCents;
            return (
              <div key={l.key} className="grid animate-rise grid-cols-6 items-end gap-2 rounded-xl bg-brand-50/40 p-3 ring-1 ring-black/5 md:grid-cols-[2rem_1fr_5rem_7rem_5rem_6rem_7rem_auto]">
                <div className="hidden flex-col md:flex">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="text-ink-soft hover:text-brand-700 disabled:opacity-20" aria-label="up">▲</button>
                  <button type="button" disabled={i === lines.length - 1} onClick={() => move(i, 1)} className="text-ink-soft hover:text-brand-700 disabled:opacity-20" aria-label="down">▼</button>
                </div>
                <div className="col-span-6 flex items-start gap-2 md:col-span-1">
                  {l.variantId && <Thumb id={optById.get(l.variantId)?.imageId} size={44} />}
                  <div className="min-w-0 flex-1">
                  <input value={l.description} onChange={(e) => upd(l.key, { description: e.target.value })} className="input" placeholder={t.sales.freeText} aria-label={t.product.nameDe} />
                  {l.available != null && <span className={`mt-1 inline-block text-xs ${short ? "font-semibold text-red-600" : "text-ink-soft"}`}>{short ? t.sales.notEnough + " · " : ""}{t.sales.available}: {l.available}</span>}
                  </div>
                </div>
                <Field label={t.common.qty} className="col-span-2 md:col-span-1"><input type="number" min={1} value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} className={`input num ${short ? "border-red-400" : ""}`} /></Field>
                <Field label={t.sales.price} className="col-span-2 md:col-span-1"><input inputMode="decimal" dir="ltr" value={l.price} onChange={(e) => upd(l.key, { price: e.target.value })} className={`input num ${parseMoney(l.price) == null ? "border-red-400" : ""}`} /></Field>
                <Field label={t.sales.lineDiscount} className="col-span-2 md:col-span-1"><input inputMode="decimal" dir="ltr" value={l.disc} onChange={(e) => upd(l.key, { disc: e.target.value })} className="input num" placeholder="0" /></Field>
                <Field label={t.sales.vat} className="col-span-2 md:col-span-1">
                  <select value={l.vatRateBp} disabled={!!l.variantId} onChange={(e) => upd(l.key, { vatRateBp: Number(e.target.value) })} className="input">
                    <option value={1900}>19 %</option><option value={700}>7 %</option><option value={0}>0 %</option>
                  </select>
                </Field>
                <div className="col-span-3 text-end md:col-span-1">
                  <div className="text-xs text-ink-soft">{t.sales.net}</div>
                  <div className="num font-bold">{net != null ? formatCents(net, intl) : "—"}</div>
                </div>
                <button type="button" aria-label={t.common.remove} className="btn-danger group col-span-1 h-11 w-11 justify-self-end p-0" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="card grid h-fit gap-4 p-5 sm:grid-cols-2 animate-rise">
          <Field label={t.sales.docDiscount}><input inputMode="decimal" dir="ltr" value={docDisc} onChange={(e) => setDocDisc(e.target.value)} className="input num" placeholder="0" /></Field>
          {kind === "invoice" && (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                <input type="checkbox" name="retentionOfTitle" defaultChecked={initial.retentionOfTitle ?? true} className="h-5 w-5 accent-brand-600" />{t.sales.retention}
              </label>
            </>
          )}
          <Field label={t.sales.notes} className="sm:col-span-2"><textarea name="notes" rows={2} defaultValue={initial.notes} className="input" /></Field>
          {kind === "invoice" && (
            <div className="space-y-4 rounded-xl bg-sky-50/50 p-4 ring-1 ring-sky-100 sm:col-span-2">
              <div>
                <span className="label">{t.pay.atIssue}</span>
                <div className="flex flex-wrap gap-2">
                  {(["none", "full", "partial"] as const).map((m) => (
                    <button type="button" key={m} onClick={() => setPayMode(m)}
                      className={`btn px-3 py-2 ${payMode === m ? "bg-sky-600 text-white shadow-card" : "bg-white ring-1 ring-black/10 hover:bg-sky-50"}`}>{t.pay[m]}</button>
                  ))}
                </div>
              </div>
              {payMode !== "none" && (
                <div className="grid animate-rise grid-cols-2 gap-3">
                  {payMode === "partial"
                    ? <Field label={t.pay.amount}><input value={partial} onChange={(e) => setPartial(e.target.value)} inputMode="decimal" dir="ltr" className="input num" placeholder="0,00" /></Field>
                    : <div><span className="label">{t.pay.amount}</span><div className="num py-2.5 font-bold">{formatCents(gross, intl)}</div></div>}
                  <Field label={t.pay.method}>
                    <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as "CASH")} className="input">
                      {(["CASH", "BANK", "CARD", "ONLINE"] as const).map((m) => <option key={m} value={m}>{t.pay.methods[m]}</option>)}
                    </select>
                  </Field>
                </div>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={planOn} onChange={(e) => setPlanOn(e.target.checked)} className="h-5 w-5 accent-sky-600" />{t.pay.planOn}
              </label>
              {planOn && <PlanEditor t={t} grossCents={gross} rows={planRows} setRows={setPlanRows} today={today} intl={intl} />}
            </div>
          )}
        </div>
        <div className="card h-fit p-5 animate-rise">
          {totals ? (
            <dl className="space-y-1.5 text-sm">
              {totals.discountCents > 0 && <>
                <Row k={t.sales.subtotal} v={formatCents(totals.subtotalCents, intl)} />
                <Row k={`${t.sales.discount} ${docDisc} %`} v={`- ${formatCents(totals.discountCents, intl)}`} />
              </>}
              <Row k={t.sales.net} v={formatCents(totals.netCents, intl)} />
              {totals.vatByRate.map((g) => <Row key={g.rateBp} k={`${t.sales.vat} ${bpToPercent(g.rateBp)} %`} v={formatCents(g.vatCents, intl)} />)}
              <div className="mt-2 flex items-center justify-between rounded-xl bg-brand-600 px-4 py-3 text-white shadow-card">
                <span className="font-bold">{t.sales.gross}</span><span className="num text-xl font-bold">{formatCents(totals.grossCents, intl)}</span>
              </div>
              {mode === "EU_B2C" && <p className="pt-2 text-xs text-ink-soft">{t.sales.oss}</p>}
              {initialPaid > 0 && <Row k={`${t.pay.paid} (${t.pay.methods[payMethod]})`} v={formatCents(initialPaid, intl)} />}
              {initialPaid > 0 && <Row k={t.pay.open} v={formatCents(gross - initialPaid, intl)} />}
            </dl>
          ) : <p className="text-sm text-ink-soft">{t.sales.noLines}</p>}
          {overLimit && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">{t.pay.creditWarn} {t.pay.openNow}: {formatCents(customer?.openCents ?? 0, intl)} · {t.pay.creditLimit}: {formatCents(customer?.creditLimitCents ?? 0, intl)}</p>}
          {!planOk && <p className="mt-3 text-xs font-semibold text-red-600">{t.pay.planSum}</p>}
          <div className="mt-4 grid gap-2">
            <button type="submit" onClick={(e) => { if (pending) e.preventDefault(); else choose("save"); }}
              disabled={!customer || !valid || !lines.length || !planOk} className={`${kind === "offer" ? "btn-primary py-3" : "btn-ghost py-3"} ${pending ? "opacity-60" : ""}`}>
              {pending && clicked === "save" && <Spinner />}{t.sales.saveDraft}
            </button>
            {kind === "invoice" && (
              <button type="submit" disabled={!customer || !valid || !lines.length || !planOk} className={`btn-primary py-3 ${pending ? "opacity-60" : ""}`}
                onClick={(e) => { if (pending || !confirm(t.sales.issueConfirm)) e.preventDefault(); else choose("issue"); }}>
                {pending && clicked === "issue" && <Spinner />}<Icon name="receipt" className="h-4 w-4" />{t.sales.issue}
              </button>
            )}
          </div>
        </div>
      </section>
    </form>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4"><dt className="text-ink-soft">{k}</dt><dd className="num font-semibold">{v}</dd></div>;
}
function Spinner() {
  return <span className="h-4 w-4 animate-spin rounded-full border-2 border-current/30 border-t-current" />;
}
