"use client";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { submitWriteOff } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { VariantPicker, optionLabel, type PickerOption } from "@/components/VariantPicker";
import type { Dict } from "@/i18n/de";

type Line = { key: string; opt: PickerOption; qty: string };
const REASONS = ["BREAKAGE", "DAMAGE", "EXPIRED", "LOSS", "OTHER"] as const;

export function WriteOffForm({ t, options, today }: { t: Dict; options: PickerOption[]; today: string }) {
  const [state, action] = useActionState(submitWriteOff, undefined);
  const [lines, setLines] = useState<Line[]>([]);
  const [reason, setReason] = useState<(typeof REASONS)[number]>("BREAKAGE");
  const [formKey, setFormKey] = useState(0);
  useEffect(() => { if (state?.ok) { setLines([]); setFormKey((k) => k + 1); } }, [state]);

  const over = lines.some((l) => (parseInt(l.qty) || 0) > l.opt.stockQty);
  const err = state?.error === "NOT_ENOUGH" ? t.writeOff.notEnough : state?.error ? t.common.error : undefined;

  return (
    <form key={formKey} action={action} className="space-y-5">
      <input type="hidden" name="lines" value={JSON.stringify(lines.map((l) => ({ variantId: l.opt.id, qty: parseInt(l.qty) || 0 })))} />
      <input type="hidden" name="reason" value={reason} />
      <ErrorBox message={err} />
      {state?.ok && (
        <div className="flex animate-rise flex-wrap items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700 ring-1 ring-brand-100">
          <Icon name="check" className="h-4 w-4" />{t.writeOff.booked}: <span dir="ltr">{state.ok.number}</span>
          <Link href={`/write-offs/${state.ok.id}`} className="underline">{t.writeOff.protocol}</Link>
        </div>
      )}
      <section className="card space-y-4 p-5">
        <div>
          <span className="label">{t.writeOff.reason}</span>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button type="button" key={r} onClick={() => setReason(r)}
                className={`btn ${reason === r ? "bg-amber-500 text-white shadow-card" : "bg-white ring-1 ring-black/10 hover:bg-amber-50"}`}>
                {t.writeOff.reasons[r]}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t.common.date}><input type="date" name="date" defaultValue={today} max={today} required className="input" /></Field>
          <Field label={`${t.writeOff.photo} (${t.common.optional})`}><input type="file" name="photo" accept="image/*,application/pdf" capture="environment" className="input file:me-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:font-semibold file:text-brand-700" /></Field>
        </div>
      </section>
      <section className="card p-5">
        <VariantPicker options={options} placeholder={t.receive.pickProduct} stockLabel={t.product.stock}
          onPick={(o) => setLines((ls) => ls.some((l) => l.opt.id === o.id) ? ls : [...ls, { key: crypto.randomUUID(), opt: o, qty: "1" }])} />
        <div className="mt-4 space-y-2">
          {lines.length === 0 && <p className="py-6 text-center text-sm text-ink-soft">{t.common.nothingYet}</p>}
          {lines.map((l) => {
            const bad = (parseInt(l.qty) || 0) > l.opt.stockQty;
            return (
              <div key={l.key} className="flex animate-rise flex-wrap items-center gap-3 rounded-xl bg-amber-50/60 p-3 ring-1 ring-black/5">
                <Thumb id={l.opt.imageId} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{optionLabel(l.opt)}</div>
                  <div className="text-xs text-ink-soft">{t.product.stock}: {l.opt.stockQty}</div>
                </div>
                <input type="number" min={1} max={l.opt.stockQty} value={l.qty} aria-label={t.common.qty}
                  onChange={(e) => setLines((ls) => ls.map((x) => x.key === l.key ? { ...x, qty: e.target.value } : x))}
                  className={`input num w-24 ${bad ? "border-red-400 ring-4 ring-red-100" : ""}`} />
                <button type="button" aria-label={t.common.remove} className="btn-danger group h-10 w-10 p-0" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      </section>
      <Field label={t.common.note}><textarea name="note" rows={2} className="input" /></Field>
      <div className="flex justify-end">
        {over && <span className="me-4 self-center text-sm font-semibold text-red-600">{t.writeOff.notEnough}</span>}
        <SubmitButton className={`btn bg-amber-500 px-8 py-3 text-white shadow-card hover:bg-amber-600 ${lines.length === 0 || over ? "pointer-events-none opacity-50" : ""}`}>{t.writeOff.submit}</SubmitButton>
      </div>
    </form>
  );
}
