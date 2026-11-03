"use client";
import { useActionState, useEffect, useMemo, useState } from "react";
import { saveProduct } from "./actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { parseMoney } from "@/lib/money";
import { PhotoPicker } from "@/components/PhotoPicker";
import type { Dict } from "@/i18n/de";

type V = { key: string; id?: string; size: string; color: string; barcode: string; minStock: number; stockQty?: number; initialQty?: number; initialExpiry?: string; imageFileId?: string | null };
export type ProductFormData = {
  id?: string; sku: string; nameDe: string; nameNl: string; descriptionDe: string; descriptionNl: string; category: string;
  supplierId: string; vatRateBp: number; purchasePrice: string; wholesalePrice: string; retailPrice: string;
  tracksExpiry: boolean; inBrandShop: boolean; inGeneralShop: boolean; imageFileId?: string | null;
  variants: Omit<V, "key">[];
};

const fmt = (c: number) => (c / 100).toFixed(2).replace(".", ",");
export const centsToInput = fmt;

type ShopFlags = { BRAND_SHOP: boolean; GENERAL_SHOP: boolean };

export function ProductForm({ t, initial, suppliers, categories, shopStatus }: {
  t: Dict; initial: ProductFormData; suppliers: { id: string; name: string }[]; categories: string[];
  shopStatus?: { connected: ShopFlags; linked: ShopFlags };
}) {
  const [state, action] = useActionState(saveProduct, undefined);
  const [variants, setVariants] = useState<V[]>(
    (initial.variants.length ? initial.variants : [{ size: "", color: "", barcode: "", minStock: 0 }]).map((v, i) => ({ ...v, key: String(i) })),
  );
  // Art.-Nr. = Barcode (Wunsch Inhaber): folgt dem ersten Barcode, solange man sie nicht selbst anders schreibt
  const firstBarcode = variants.find((v) => v.barcode)?.barcode ?? "";
  const [sku, setSku] = useState(initial.sku);
  const [skuFollows, setSkuFollows] = useState(() => !initial.sku || initial.sku === (initial.variants.find((v) => v.barcode)?.barcode ?? ""));
  useEffect(() => { if (skuFollows && firstBarcode) setSku(firstBarcode); }, [skuFollows, firstBarcode]);
  const [tracksExpiry, setTracksExpiry] = useState(initial.tracksExpiry);
  const [inShop, setInShop] = useState<ShopFlags>({ BRAND_SHOP: initial.inBrandShop, GENERAL_SHOP: initial.inGeneralShop });
  // im Shop schon verbunden → „im Shop ✓“; angehakt, Shop eingerichtet, noch nicht verbunden → wird beim Speichern angelegt
  const shopNote = (c: keyof ShopFlags) =>
    shopStatus?.linked[c] ? { text: t.product.inShop, tone: "ok" as const }
      : shopStatus?.connected[c] && inShop[c] ? { text: t.product.willCreate, tone: "info" as const } : undefined;
  const [prices, setPrices] = useState({ p: initial.purchasePrice, w: initial.wholesalePrice, r: initial.retailPrice });
  const margin = useMemo(() => {
    const p = parseMoney(prices.p) ?? 0;
    const calc = (s: string) => { const v = parseMoney(s) ?? 0; return v > 0 && p > 0 ? Math.round(((v - p) / v) * 100) : null; };
    return { w: calc(prices.w), r: calc(prices.r) };
  }, [prices]);

  // nach einer Fehlermeldung: zuletzt eingegebene Texte statt der Ausgangswerte (React setzt das Formular zurück)
  const v = { ...initial, ...(state?.values ?? {}) } as ProductFormData & Record<string, unknown>;
  const known = state?.error ? (t.product as unknown as Record<string, unknown>)[state.error] : undefined;
  const errorText = state?.error
    ? typeof known === "string" ? known : state.error === "required" ? `${t.common.required}: ${state.field ?? ""}` : t.common.error
    : undefined;

  const photoLabels = { add: t.product.addPhoto, change: t.product.changePhoto, remove: t.product.removePhoto, processing: t.product.photoProcessing, error: t.product.imageType };
  const upd = (key: string, patch: Partial<V>) => setVariants((vs) => vs.map((v) => (v.key === key ? { ...v, ...patch } : v)));

  return (
    <form action={action} className="space-y-6">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="variants" value={JSON.stringify(variants.map(({ key, stockQty: _s, imageFileId: _i, ...v }) => ({ ...v, ref: key })))} />
      <ErrorBox message={errorText} />

      <section className="card flex flex-col gap-4 p-5 animate-rise sm:flex-row sm:items-center">
        <PhotoPicker name="image" initialId={initial.imageFileId} labels={photoLabels} size={132} />
        <div>
          <h2 className="text-lg font-bold">{t.product.photo}</h2>
          <p className="max-w-md text-sm text-ink-soft">{t.product.photoHint}</p>
        </div>
      </section>

      <section className="card grid gap-4 p-5 md:grid-cols-2 animate-rise">
        <Field label={t.product.sku} hint={t.product.skuHint}>
          <input name="sku" value={sku} required={!firstBarcode} className="input num" dir="ltr"
            onChange={(e) => { const v = e.target.value; setSku(v); setSkuFollows(!v.trim() || v.trim() === firstBarcode); }} />
        </Field>
        <Field label={t.product.category}>
          <input name="category" defaultValue={v.category} list="cats" className="input" />
          <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label={t.product.nameDe}><input name="nameDe" defaultValue={v.nameDe} required className="input" dir="ltr" lang="de" /></Field>
        <Field label={t.product.nameNl}><input name="nameNl" defaultValue={v.nameNl} className="input" dir="ltr" lang="nl" /></Field>
        <Field label={t.product.descDe}><textarea name="descriptionDe" defaultValue={v.descriptionDe} rows={3} className="input" dir="ltr" lang="de" /></Field>
        <Field label={t.product.descNl}><textarea name="descriptionNl" defaultValue={v.descriptionNl} rows={3} className="input" dir="ltr" lang="nl" /></Field>
        <Field label={t.product.supplier}>
          <select name="supplierId" defaultValue={v.supplierId} className="input">
            <option value="">{t.common.none}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t.product.vat}>
          <select name="vatRateBp" defaultValue={String(v.vatRateBp)} className="input">
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
          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <input type="checkbox" name="tracksExpiry" checked={tracksExpiry} onChange={(e) => setTracksExpiry(e.target.checked)} className="h-5 w-5 rounded accent-brand-600" />
            {t.product.tracksExpiry}
          </label>
          <span className="text-sm font-semibold text-ink-soft">{t.product.shops}:</span>
          <Check name="inBrandShop" label={t.product.brandShop} checked={inShop.BRAND_SHOP} onChange={(c) => setInShop((x) => ({ ...x, BRAND_SHOP: c }))} note={shopNote("BRAND_SHOP")} />
          <Check name="inGeneralShop" label={t.product.generalShop} checked={inShop.GENERAL_SHOP} onChange={(c) => setInShop((x) => ({ ...x, GENERAL_SHOP: c }))} note={shopNote("GENERAL_SHOP")} />
          {(shopStatus?.connected.BRAND_SHOP || shopStatus?.connected.GENERAL_SHOP) && (
            <p className="w-full text-xs text-ink-soft">{t.product.shopsHint}</p>
          )}
        </div>
      </section>

      <section className="card p-5 animate-rise">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">{t.product.variants}</h2>
            <p className="text-xs text-ink-soft">{t.product.noVariantsHint}</p>
            {variants.some((v) => !v.id) && <p className="mt-1 text-xs font-semibold text-brand-700">{t.product.initialHint}</p>}
          </div>
          <button type="button" className="btn-ghost group"
            onClick={() => setVariants((vs) => [...vs, { key: crypto.randomUUID(), size: "", color: "", barcode: "", minStock: 0 }])}>
            <Icon name="plus" className="h-4 w-4" />{t.product.addVariant}
          </button>
        </div>
        <div className="space-y-3">
          {variants.map((v) => (
            <div key={v.key} className="grid animate-rise grid-cols-2 gap-3 rounded-xl bg-brand-50/50 p-3 ring-1 ring-black/5 md:grid-cols-[auto_minmax(0,1fr)_1fr_1.4fr_0.8fr_auto]">
              <div className="col-span-2 flex items-end md:col-span-1" title={t.product.variantPhoto}>
                <PhotoPicker name={`vimg_${v.key}`} initialId={v.imageFileId} labels={photoLabels} size={44} compact />
              </div>
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
              {!v.id && (
                <div className="col-span-2 grid grid-cols-2 gap-3 md:col-span-6 md:grid-cols-4">
                  <Field label={t.product.initialQty}>
                    <input className="input num border-brand-300 bg-white" type="number" min={0} inputMode="numeric" placeholder="0"
                      value={v.initialQty || ""} onChange={(e) => upd(v.key, { initialQty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                  </Field>
                  {tracksExpiry && (v.initialQty ?? 0) > 0 && (
                    <Field label={t.product.initialExpiry}>
                      <input className="input" type="date" value={v.initialExpiry ?? ""} onChange={(e) => upd(v.key, { initialExpiry: e.target.value })} />
                    </Field>
                  )}
                </div>
              )}
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
    <div className="relative" dir="ltr">
      <input name={name} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" dir="ltr"
        className={`input num pe-9 ${bad ? "border-red-400 ring-4 ring-red-100" : ""}`} placeholder="0,00" />
      <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-ink-soft">€</span>
    </div>
  );
}

function Check({ name, label, defaultChecked, checked, onChange, note }: {
  name: string; label: string; defaultChecked?: boolean; checked?: boolean; onChange?: (checked: boolean) => void;
  note?: { text: string; tone: "ok" | "info" };
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
      <input type="checkbox" name={name} {...(checked !== undefined ? { checked, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.checked) } : { defaultChecked })}
        className="h-5 w-5 rounded accent-brand-600" />
      {label}
      {note && <span className={`badge ring-1 ${note.tone === "ok" ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : "bg-brand-50 text-brand-700 ring-brand-100"}`}>{note.text}</span>}
    </label>
  );
}
