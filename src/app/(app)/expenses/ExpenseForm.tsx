"use client";
import { useActionState, useMemo, useState } from "react";
import { deleteExpenseAction, saveExpenseAction } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { formatCents, parseMoney } from "@/lib/money";
import { EU_COUNTRIES, EXPENSE_CATEGORIES, expenseAmounts, suggestTaxCase, type ExpenseCategory, type ExpenseTaxCase, type PayMethod } from "@/lib/accounts";
import type { Dict } from "@/i18n/de";

export type ExpenseFormData = {
  id?: string; date: string; vendorName: string; vendorCountry: string; vendorVatId: string; invoiceNo: string;
  category: ExpenseCategory; taxCase: ExpenseTaxCase; channel: string; amount: string; vatRateBp: number;
  paid: boolean; paidAt: string; paymentMethod: PayMethod | ""; note: string; fileId: string | null;
};
type Supplier = { name: string; country: string; vatId: string };

const OTHER_COUNTRIES = ["CH", "GB", "US", "TR", "CN", "AE", "NO"];
const TAX_CASES: ExpenseTaxCase[] = ["DOMESTIC", "EU_SERVICE", "EU_GOODS", "NON_EU_SERVICE", "NO_VAT"];

export function ExpenseForm({ t, intl, locale, initial, suppliers, locked }: {
  t: Dict; intl: string; locale: string; initial: ExpenseFormData; suppliers: Supplier[]; locked: boolean;
}) {
  const [state, action] = useActionState(saveExpenseAction, undefined);
  const [delState, delAction] = useActionState(deleteExpenseAction, undefined);
  const [vendor, setVendor] = useState(initial.vendorName);
  const [country, setCountry] = useState(initial.vendorCountry);
  const [vatId, setVatId] = useState(initial.vendorVatId);
  const [category, setCategory] = useState<ExpenseCategory>(initial.category);
  const [taxCase, setTaxCase] = useState<ExpenseTaxCase>(initial.taxCase);
  const [taxTouched, setTaxTouched] = useState(Boolean(initial.id));
  const [rate, setRate] = useState(initial.vatRateBp);
  const [amount, setAmount] = useState(initial.amount);
  const [paid, setPaid] = useState(initial.paid);
  const [date, setDate] = useState(initial.date);
  const [paidAt, setPaidAt] = useState(initial.paidAt || initial.date);
  const [paidAtTouched, setPaidAtTouched] = useState(Boolean(initial.id));

  const regions = useMemo(() => {
    let dn: Intl.DisplayNames | null = null;
    try { dn = new Intl.DisplayNames([locale], { type: "region" }); } catch { /* alter Browser */ }
    return ["DE", ...EU_COUNTRIES, ...OTHER_COUNTRIES].map((c) => ({ code: c, name: dn?.of(c) ?? c }));
  }, [locale]);

  const apply = (next: { country?: string; category?: ExpenseCategory }) => {
    if (taxTouched) return;
    const tc = suggestTaxCase(next.country ?? country, next.category ?? category);
    setTaxCase(tc);
    if (tc === "NO_VAT") setRate(0); else if (rate === 0) setRate(1900);
  };
  const pickVendor = (name: string) => {
    setVendor(name);
    const s = suppliers.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
    if (s) { setCountry(s.country || "DE"); setVatId(s.vatId); apply({ country: s.country || "DE" }); }
  };

  const cents = parseMoney(amount);
  const calc = cents && cents > 0 ? expenseAmounts(taxCase, cents, taxCase === "NO_VAT" ? 0 : rate) : null;
  const err = (code?: string) => (code ? (t.exp.errors as Record<string, string>)[code] ?? t.common.error : undefined);
  const rates = taxCase === "DOMESTIC" ? [1900, 700, 0] : taxCase === "NO_VAT" ? [] : [1900, 700];

  return (
    <div className="space-y-4">
      {locked && <div className="flex animate-rise items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200"><Icon name="lock" className="h-4 w-4" />{t.exp.lockedInfo}</div>}
      <form action={action} className="space-y-5">
        <ErrorBox message={err(state?.error)} />
        {initial.id && <input type="hidden" name="id" value={initial.id} />}
        <fieldset disabled={locked} className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
            <section className="card animate-rise grid gap-4 p-5 sm:grid-cols-2 lg:col-start-1">
              <Field label={t.exp.vendor} hint={t.exp.vendorHint} className="sm:col-span-2">
                <input name="vendorName" value={vendor} onChange={(e) => pickVendor(e.target.value)} list="vendors" required autoComplete="off" className="input" />
                <datalist id="vendors">{suppliers.map((s) => <option key={s.name} value={s.name} />)}</datalist>
              </Field>
              <Field label={t.exp.country}>
                <select name="vendorCountry" value={country} onChange={(e) => { setCountry(e.target.value); apply({ country: e.target.value }); }} className="input">
                  {regions.map((r) => <option key={r.code} value={r.code}>{r.name} ({r.code})</option>)}
                </select>
              </Field>
              <Field label={`${t.exp.vatId}${taxCase === "EU_GOODS" ? "" : ` (${t.common.optional})`}`}>
                <input name="vendorVatId" value={vatId} onChange={(e) => setVatId(e.target.value)} dir="ltr" className="input uppercase" placeholder={country !== "DE" && EU_COUNTRIES.includes(country) ? `${country}…` : ""} />
              </Field>
              <Field label={t.exp.date}><input name="date" type="date" value={date} onChange={(e) => { setDate(e.target.value); if (!paidAtTouched) setPaidAt(e.target.value); }} required className="input" /></Field>
              <Field label={`${t.exp.invoiceNo} (${t.common.optional})`}><input name="invoiceNo" defaultValue={initial.invoiceNo} dir="ltr" className="input" /></Field>
            </section>
            <aside className="space-y-4 lg:sticky lg:top-6 lg:col-start-2 lg:row-span-4 lg:row-start-1">
              <section className="card animate-rise space-y-4 p-5">
                <Field label={taxCase === "DOMESTIC" ? t.exp.amountGross : t.exp.amountNet}>
                  <input name="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" required placeholder="0,00" className="input num text-xl font-bold" />
                </Field>
                <input type="hidden" name="vatRateBp" value={taxCase === "NO_VAT" ? 0 : rate} />
                {rates.length > 0 && (
                  <div>
                    <span className="label">{t.exp.rate}</span>
                    <div className="flex gap-2">
                      {rates.map((r) => (
                        <button type="button" key={r} onClick={() => setRate(r)} className={`btn flex-1 py-2 ${rate === r ? "bg-brand-600 text-white shadow-card" : "bg-white ring-1 ring-black/10"}`}>{r / 100} %</button>
                      ))}
                    </div>
                  </div>
                )}
                {calc && (
                  <dl className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-sm ring-1 ring-black/5">
                    <div className="flex justify-between"><dt className="text-ink-soft">{t.exp.net}</dt><dd className="num font-semibold">{formatCents(calc.netCents, intl)}</dd></div>
                    {taxCase === "DOMESTIC" && <div className="flex justify-between"><dt className="text-ink-soft">{t.exp.vat}</dt><dd className="num font-semibold">{formatCents(calc.vatCents, intl)}</dd></div>}
                    <div className="flex justify-between border-t border-black/5 pt-1.5"><dt className="font-bold">{t.exp.gross}</dt><dd className="num font-bold">{formatCents(calc.grossCents, intl)}</dd></div>
                    {calc.selfAssessedVatCents > 0 && <p className="pt-1 text-xs text-sky-800">{t.exp.rcInfo.replace("{vat}", formatCents(calc.selfAssessedVatCents, intl))}</p>}
                  </dl>
                )}
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" name="paid" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="h-5 w-5 accent-brand-600" />{t.exp.paid}
                </label>
                {paid && (
                  <div className="grid animate-rise grid-cols-2 gap-2">
                    <Field label={t.exp.paidAt}><input name="paidAt" type="date" value={paidAt} onChange={(e) => { setPaidAt(e.target.value); setPaidAtTouched(true); }} className="input" /></Field>
                    <Field label={t.exp.method}>
                      <select name="paymentMethod" defaultValue={initial.paymentMethod || "BANK"} className="input">
                        {(["BANK", "CARD", "ONLINE", "CASH"] as const).map((m) => <option key={m} value={m}>{t.pay.methods[m]}</option>)}
                      </select>
                    </Field>
                  </div>
                )}
                {!locked && <SubmitButton className="btn-primary hidden w-full py-3 lg:flex"><Icon name="check" className="h-4 w-4" />{t.common.save}</SubmitButton>}
              </section>
            </aside>

            <section className="lg:col-start-1 card animate-rise p-5">
              <span className="label">{t.exp.category}</span>
              <input type="hidden" name="category" value={category} />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {EXPENSE_CATEGORIES.map((c) => (
                  <button type="button" key={c} onClick={() => { setCategory(c); apply({ category: c }); }}
                    className={`rounded-xl px-3 py-2.5 text-start text-sm font-semibold transition ${category === c ? "bg-brand-600 text-white shadow-card" : "bg-white ring-1 ring-black/10 hover:-translate-y-0.5 hover:shadow-card"}`}>
                    {t.exp.categories[c]}
                  </button>
                ))}
              </div>
              <div className="mt-4 max-w-sm">
                <Field label={t.exp.channel}>
                  <select name="channel" defaultValue={initial.channel} className="input">
                    <option value="">{t.exp.general}</option>
                    {(["STORE", "BRAND_SHOP", "GENERAL_SHOP"] as const).map((c) => <option key={c} value={c}>{t.sales.channels[c]}</option>)}
                  </select>
                </Field>
              </div>
            </section>

            <section className="lg:col-start-1 card animate-rise space-y-3 p-5">
              <span className="label">{t.exp.taxCase}</span>
              <input type="hidden" name="taxCase" value={taxCase} />
              <div className="grid gap-2">
                {TAX_CASES.map((c) => (
                  <button type="button" key={c} onClick={() => { setTaxCase(c); setTaxTouched(true); if (c === "NO_VAT") setRate(0); else if (rate === 0) setRate(1900); }}
                    className={`rounded-xl px-4 py-3 text-start transition ${taxCase === c ? "bg-sky-600 text-white shadow-card" : "bg-white ring-1 ring-black/10 hover:shadow-card"}`}>
                    <div className="text-sm font-bold">{t.exp.taxCases[c]}</div>
                    <div className={`text-xs ${taxCase === c ? "text-white/85" : "text-ink-soft"}`}>{t.exp.taxHints[c]}</div>
                  </button>
                ))}
              </div>
            </section>

            <section className="lg:col-start-1 card animate-rise grid gap-4 p-5 sm:grid-cols-2">
              <Field label={t.exp.receipt} className="sm:col-span-2">
                <input type="file" name="file" accept="image/*,application/pdf" capture="environment" className="input file:me-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:font-semibold file:text-brand-700" />
                {initial.fileId && <a href={`/api/files/${initial.fileId}`} target="_blank" className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-brand-700 hover:underline"><Icon name="file" className="h-4 w-4" />{t.exp.receiptShow}</a>}
              </Field>
              <Field label={t.exp.note} className="sm:col-span-2"><textarea name="note" rows={2} defaultValue={initial.note} className="input" /></Field>
            </section>
            {!locked && <div className="lg:hidden"><SubmitButton className="btn-primary w-full py-3"><Icon name="check" className="h-4 w-4" />{t.common.save}</SubmitButton></div>}
        </fieldset>
      </form>
      {initial.id && !locked && (
        <form action={delAction} onSubmit={(e) => { if (!confirm(t.exp.deleteConfirm)) e.preventDefault(); }} className="flex justify-end">
          <input type="hidden" name="id" value={initial.id} /><input type="hidden" name="month" value={initial.date.slice(0, 7)} />
          <ErrorBox message={err(delState?.error)} />
          <button className="btn-danger group"><Icon name="trash" className="h-4 w-4" />{t.common.delete}</button>
        </form>
      )}
    </div>
  );
}
