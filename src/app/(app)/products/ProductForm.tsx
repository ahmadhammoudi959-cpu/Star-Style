"use client";
import { useActionState, useMemo, useState } from "react";
import { saveProduct } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { parseMoney } from "@/lib/money";
import type { Dict } from "@/i18n/de";

type V = { key: string; id?: string; size: string; color: string; barcode: string; minStock: number; stockQty?: number };
export type ProductFormData = {
  id?: string; sku: string; nameDe: string; nameNl: string; descriptionDe: string; descriptionNl: string; category: string;
  supplierId: string; vatRateBp: number; purchasePrice: string; wholesalePrice: string; retailPrice: string;
  tracksExpiry: boolean; inBrandShop: boolean; inGeneralShop: boolean;
  variants: Omit<V, "key">[];
};

const fmt = (c: number) => (c / 100).toFixed(2).replace(".", ",");
export const centsToInput = fmt;

export function ProductForm({ t, initial, suppliers, categories }: {
  t: Dict; initial: ProductFormData; suppliers: { id: string; name: string }[]; categories: string[];
}) {
  const [state, action] = useActionState(saveProduct, undefined);
  const [variants, setVariants] = useState<V[]>(
    (initial.variants.length ? initial.variants : [{ size: "", color: "", barcode: "", minStock: 0 }]).map((v, i) => ({ ...v, key: String(i) })),
  );
  const [prices, setPrices] = useState({ p: initial.purchasePrice, w: initial.wholesalePrice, r: initial.retailPrice });
  const margin = useMemo(() => {
    const p = parseMoney(prices.p) ?? 0;
    const calc = (s: string) => { const v = parseMoney(s) ?? 0; return v > 0 && p > 0 ? Math.round(((v - p) / v) * 100) : null; };
    return { w: calc(prices.w), r: calc(prices.r) };
  }, [prices]);

  const errorText = state?.error
    ? (t.product as Record<string, string>)[state.error] ?? (state.error === "required" ? `${t.common.required}: ${state.field ?? ""}` : t.common.error)
    : undefined;

  const upd = (key: string, patch: Partial<V>) => setVariants((vs) => vs.map((v) => (v.key === key ? { ...v, ...patch } : v)));

  return (
    <form action={action} className="space-y-6">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="variants" value={JSON.stringify(variants.map(({ key: _k, stockQty: _s, ...v }) => v))} />
      <ErrorBox message={errorText} />

      <section className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
        <Field label={t.product.sku}><input name="sku" defaultValue={initial.sku} required className="input" dir="ltr" /></Field>
        <Field label={t.product.category}>
          <input name="category" defaultValue={initial.category} list="cats" className="input" />
          <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label={t.product.nameDe}><input name="nameDe" defaultValue={initial.nameDe} required className="input" dir="ltr" lang="de" /></Field>
        <Field label={t.product.nameNl}><input name="nameNl" defaultValue={initial.nameNl} className="input" dir="ltr" lang="nl" /></Field>
        <Field label={t.product.descDe}><textarea name="descriptionDe" defaultValue={initial.descriptionDe} rows={3} className="input" dir="ltr" lang="de" /></Field>
        <Field label={t.product.descNl}><textarea name="descriptionNl" defaultValue={initial.descriptionNl} rows={3} className="input" dir="ltr" lang="nl" /></Field>
        <Field label={t.product.supplier}>
          <select name="supplierId" defaultValue={initial.supplierId} className="input">
            <option value="">{t.common.none}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t.product.vat}>
          <select name="vatRateBp" defaultValue={String(initial.vatRateBp)} className="input">
            <option value="1900">19 %</option>
            <option value="700">7 %</option>
          </select>
        </Field>
      </section>

      <section className="card grid gap-4 p-5 md:grid-cols-3 animate-rise">
        <Field label={t.product.purchase}>
          <MoneyInput name="purchasePrice" value={prices.p} onChange={(p) => setPrices((x) => ({ ...x, p }))} />
        </Field>
        <Field label={t.product.wholesale} hint={margin.w != null ? `${t.product.margin}: ${margin.w} %` : undefined}>
          <MoneyInput name="wholesalePrice" value={prices.w} onChange={(w) => setPrices((x) => ({ ...x, w }))} />
        </Field>
        <Field label={t.product.retail} hint={margin.r != null ? `${t.product.margin}: ${margin.r} %` : undefined}>
          <MoneyInput name="retailPrice" value={prices.r} onChange={(r) => setPrices((x) => ({ ...x, r }))} />
        </Field>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 md:col-span-3">
          <Check name="tracksExpiry" label={t.product.tracksExpiry} defaultChecked={initial.tracksExpiry} />
          <span className="text-sm font-semibold text-ink-soft">{t.product.shops}:</span>
          <Check name="inBrandShop" label={t.product.brandShop} defaultChecked={initial.inBrandShop} />
          <Check name="inGeneralShop" label={t.product.generalShop} defaultChecked={initial.inGeneralShop} />
        </div>
      </section>

      <section className="card p-5 animate-rise">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">{t.product.variants}</h2>
            <p className="text-xs text-ink-soft">{t.product.noVariantsHint}</p>
          </div>
          <button type="button" className="btn-ghost group"
            onClick={() => setVariants((vs) => [...vs, { key: crypto.randomUUID(), size: "", color: "", barcode: "", minStock: 0 }])}>
            <Icon name="plus" className="h-4 w-4" />{t.product.addVariant}
          </button>
        </div>
        <div className="space-y-3">
          {variants.map((v) => (
            <div key={v.key} className="grid animate-rise grid-cols-2 gap-3 rounded-xl bg-brand-50/50 p-3 ring-1 ring-black/5 md:grid-cols-[1fr_1fr_1.4fr_0.8fr_auto]">
              <Field label={t.product.size}><input className="input" value={v.size} onChange={(e) => upd(v.key, { size: e.target.value })} /></Field>
              <Field label={t.product.color}><input className="input" value={v.color} onChange={(e) => upd(v.key, { color: e.target.value })} /></Field>
              <Field label={t.product.barcode}><input className="input num" dir="ltr" inputMode="numeric" value={v.barcode} onChange={(e) => upd(v.key, { barcode: e.target.value.trim() })} /></Field>
              <Field label={t.product.minStock}><input className="input num" type="number" min={0} value={v.minStock} onChange={(e) => upd(v.key, { minStock: Math.max(0, Number(e.target.value) || 0) })} /></Field>
              <div className="flex items-end justify-end gap-2">
                {v.stockQty != null && <span className="badge mb-3 bg-white text-ink-soft ring-1 ring-black/5">{t.product.stock}: {v.stockQty}</span>}
                <button type="button" aria-label={t.common.remove} disabled={variants.length === 1 || (v.stockQty ?? 0) > 0}
                  title={(v.stockQty ?? 0) > 0 ? t.product.stock + " > 0" : undefined}
                  className="btn-danger group h-11 w-11 p-0" onClick={() => setVariants((vs) => vs.filter((x) => x.key !== v.key))}>
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="sticky bottom-20 z-10 flex justify-end lg:bottom-4">
        <SubmitButton className="btn-primary px-8 py-3 text-base shadow-lift">{t.common.save}</SubmitButton>
      </div>
    </form>
  );
}

function MoneyInput({ name, value, onChange }: { name: string; value: string; onChange: (v: string) => void }) {
  const bad = value.trim() !== "" && parseMoney(value) == null;
  return (
    <div className="relative">
      <input name={name} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" dir="ltr"
        className={`input num pe-9 ${bad ? "border-red-400 ring-4 ring-red-100" : ""}`} placeholder="0,00" />
      <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-ink-soft">€</span>
    </div>
  );
}

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-5 w-5 rounded accent-brand-600" />
      {label}
    </label>
  );
}
