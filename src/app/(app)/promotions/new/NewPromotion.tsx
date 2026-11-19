"use client";
import { useState, useTransition } from "react";
import { Icon } from "@/components/Icon";
import { ErrorBox } from "@/components/Forms";
import { percentToBp, PROMO_PLACES } from "@/lib/promo-rules";
import type { SaleOption } from "../../sales/DocEditor";
import type { Dict } from "@/i18n/de";
import { createPromotionAction } from "../actions";
import { ItemsPicker, type ChosenItem } from "../ItemsPicker";

export function NewPromotion({ t, options, intl }: { t: Dict; options: SaleOption[]; intl: string }) {
  const T = t.promo;
  const [title, setTitle] = useState("");
  const [percent, setPercent] = useState("20");
  const [places, setPlaces] = useState<string[]>([...PROMO_PLACES]);
  const [items, setItems] = useState<ChosenItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const bp = percentToBp(percent);

  const submit = () => {
    setError(null);
    if (bp == null) return setError("percent");
    if (!items.length) return setError("noItems");
    if (!places.length) return setError("noPlaces");
    start(async () => {
      const r = await createPromotionAction({ title, percent, places, productIds: items.map((i) => i.productId) });
      if (r.ok && r.id) window.location.assign(`/promotions/${r.id}`);
      else setError(r.error ?? "error");
    });
  };

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="card relative z-10 animate-rise space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="box" className="icon-pop h-5 w-5 text-brand-600" />{T.stepItems}</h2>
        <ItemsPicker t={t} options={options} items={items} onChange={setItems} discountBp={bp} intl={intl} />
      </section>
      <aside className="card animate-rise space-y-4 p-5 lg:sticky lg:top-4">
        <label className="block">
          <span className="label">{T.percentLabel}</span>
          {/* Zahl und „%“ immer links nach rechts (sonst lagen sie in RTL übereinander, Inhaber 20.11.2026): Zahl rechtsbündig direkt vor dem Zeichen */}
          <div className="relative" dir="ltr">
            <input data-promo-percent value={percent} onChange={(e) => setPercent(e.target.value.replace(/[^\d]/g, "").slice(0, 2))} inputMode="numeric"
              className="input num pr-11 text-right text-2xl font-black" dir="ltr" aria-describedby="promo-percent-hint" />
            <span className="pointer-events-none absolute inset-y-0 right-4 grid place-items-center text-xl font-black text-ink-soft" aria-hidden="true">%</span>
          </div>
          <span id="promo-percent-hint" className={`hint block ${bp == null && percent ? "font-semibold text-red-700" : ""}`}>{T.percentHint}</span>
        </label>
        <label className="block">
          <span className="label">{T.titleLabel}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder={T.titlePh} className="input" dir="auto" />
        </label>
        <fieldset>
          <legend className="label">{T.placesLabel}</legend>
          <div className="space-y-1.5">
            {PROMO_PLACES.map((pl) => (
              <label key={pl} className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 ring-1 ring-black/5 hover:bg-brand-50/50">
                <input type="checkbox" checked={places.includes(pl)} onChange={(e) => setPlaces((ps) => (e.target.checked ? [...ps, pl] : ps.filter((x) => x !== pl)))} className="h-4 w-4 accent-brand-600" />
                <span className="text-sm font-medium">{T.places[pl]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <ErrorBox message={error ? (T.errors as Record<string, string>)[error] ?? T.errors.error : undefined} />
        <button type="button" onClick={submit} disabled={pending} data-promo-create className="btn-primary group w-full py-3 text-base">
          {pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="spark" className="icon-pop h-5 w-5" />}
          {T.createGo}
        </button>
      </aside>
    </div>
  );
}
