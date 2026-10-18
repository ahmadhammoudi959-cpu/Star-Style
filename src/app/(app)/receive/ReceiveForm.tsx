"use client";
import { useActionState, useEffect, useMemo, useState } from "react";
import { submitReceipt } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { VariantPicker, optionLabel, type PickerOption } from "@/components/VariantPicker";
import { formatCents, parseMoney } from "@/lib/money";
import type { Dict } from "@/i18n/de";

type Opt = PickerOption & { tracksExpiry: boolean; purchasePriceCents: number };
type Line = { key: string; opt: Opt; qty: string; cost: string; batchNo: string; expiryDate: string };

export function ReceiveForm({ t, options, suppliers, today, intl }: {
  t: Dict; options: Opt[]; suppliers: { id: string; name: string }[]; today: string; intl: string;
}) {
  const [state, action] = useActionState(submitReceipt, undefined);
  const [lines, setLines] = useState<Line[]>([]);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => { if (state?.ok) { setLines([]); setFormKey((k) => k + 1); } }, [state]);

  const total = useMemo(() => lines.reduce((s, l) => s + (parseInt(l.qty) || 0) * (parseMoney(l.cost) ?? 0), 0), [lines]);
  const missingExpiry = lines.some((l) => l.opt.tracksExpiry && !l.expiryDate);
  const invalid = lines.some((l) => !(parseInt(l.qty) > 0) || parseMoney(l.cost) == null);

  const add = (o: PickerOption) => {
    const opt = o as Opt;
    setLines((ls) => [...ls, { key: crypto.randomUUID(), opt, qty: "1", cost: (opt.purchasePriceCents / 100).toFixed(2).replace(".", ","), batchNo: "", expiryDate: "" }]);
  };
  const upd = (k: string, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...p } : l)));

  const payload = JSON.stringify(lines.map((l) => ({
    variantId: l.opt.id, qty: parseInt(l.qty) || 0, unitCostCents: parseMoney(l.cost) ?? 0, batchNo: l.batchNo, expiryDate: l.expiryDate,
  })));

  const err = state?.error === "EXPIRY_REQUIRED" ? t.receive.expiryRequired : state?.error ? t.common.error : undefined;

  return (
    <form key={formKey} action={action} className="space-y-5">
      <input type="hidden" name="lines" value={payload} />
      <ErrorBox message={err} />
      {state?.ok && (
        <div className="flex animate-rise items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700 ring-1 ring-brand-100">
          <Icon name="check" className="h-4 w-4" />{t.receive.booked}: <span dir="ltr">{state.ok}</span>
        </div>
      )}
      <section className="card grid gap-4 p-5 md:grid-cols-4">
        <Field label={t.receive.supplier} className="md:col-span-2">
          <select name="supplierId" className="input" defaultValue="">
            <option value="">{t.common.none}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t.common.date}><input type="date" name="date" defaultValue={today} required className="input" /></Field>
        <Field label={t.receive.supplierInvoice}><input name="supplierInvoiceNo" className="input" dir="ltr" /></Field>
      </section>

      <section className="card p-5">
        <h2 className="mb-3 text-lg font-bold">{t.receive.lines}</h2>
        <VariantPicker options={options} placeholder={t.receive.pickProduct} onPick={add} stockLabel={t.product.stock} />
        <div className="mt-4 space-y-3">
          {lines.length === 0 && <p className="py-6 text-center text-sm text-ink-soft">{t.common.nothingYet}</p>}
          {lines.map((l) => (
            <div key={l.key} className="animate-rise rounded-xl bg-brand-50/50 p-3 ring-1 ring-black/5">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{optionLabel(l.opt)}</div>
                  <div className="text-xs text-ink-soft" dir="ltr">{l.opt.sku}</div>
                </div>
                <button type="button" aria-label={t.common.remove} className="btn-danger group h-9 w-9 p-0" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label={t.common.qty}><input type="number" min={1} value={l.qty} onChange={(e) => upd(l.key, { qty: e.target.value })} className="input num" /></Field>
                <Field label={t.receive.unitCost}><input inputMode="decimal" dir="ltr" value={l.cost} onChange={(e) => upd(l.key, { cost: e.target.value })}
                  className={`input num ${parseMoney(l.cost) == null ? "border-red-400" : ""}`} /></Field>
                <Field label={t.receive.batchNo}><input value={l.batchNo} onChange={(e) => upd(l.key, { batchNo: e.target.value })} className="input" dir="ltr" /></Field>
                <Field label={t.receive.expiry + (l.opt.tracksExpiry ? " *" : "")}>
                  <input type="date" value={l.expiryDate} min={today} onChange={(e) => upd(l.key, { expiryDate: e.target.value })}
                    className={`input ${l.opt.tracksExpiry && !l.expiryDate ? "border-amber-400 ring-4 ring-amber-100" : ""}`} />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </section>

      <Field label={t.common.note}><textarea name="note" rows={2} className="input" /></Field>

      <div className="sticky bottom-20 z-10 flex flex-wrap items-center justify-end gap-4 rounded-2xl bg-white/90 p-3 shadow-lift ring-1 ring-black/5 backdrop-blur lg:bottom-4">
        <div className="text-sm text-ink-soft">{t.common.total}: <span className="num text-lg font-bold text-ink">{formatCents(total, intl)}</span></div>
        {missingExpiry && <span className="text-xs font-semibold text-amber-700">{t.receive.expiryRequired}</span>}
        <SubmitButton className={`btn-primary px-8 py-3 ${lines.length === 0 || missingExpiry || invalid ? "pointer-events-none opacity-50" : ""}`}>{t.receive.submit}</SubmitButton>
      </div>
    </form>
  );
}
