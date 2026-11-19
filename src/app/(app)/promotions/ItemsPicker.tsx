"use client";
/** Artikel einer Aktion wählen (Suche, Kategorie, „Alle Artikel“ wie überall) + Liste mit Preis vorher/nachher */
import { ProductPickerBar } from "@/components/ProductPickerBar";
import { Thumb } from "@/components/Thumb";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { discounted } from "@/lib/promo-rules";
import type { SaleOption } from "../sales/DocEditor";
import type { Dict } from "@/i18n/de";

export type ChosenItem = { productId: string; name: string; imageId: string | null; category: string; retail: number; wholesale: number };

export const itemFromOption = (o: SaleOption): ChosenItem => ({
  productId: o.productId ?? o.id, name: o.nameDe, imageId: o.imageId ?? null, category: o.category ?? "", retail: o.retailPriceCents, wholesale: o.wholesalePriceCents,
});

export function ItemsPicker({ t, options, items, onChange, discountBp, intl }: {
  t: Dict; options: SaleOption[]; items: ChosenItem[]; onChange: (items: ChosenItem[]) => void; discountBp: number | null; intl: string;
}) {
  const T = t.promo;
  const has = new Set(items.map((i) => i.productId));
  const pick = (o: SaleOption) => {
    const it = itemFromOption(o);
    if (has.has(it.productId)) return;
    onChange([...items, it]);
  };
  const price = (c: number) => (
    discountBp ? <span className="num inline-flex flex-wrap items-baseline gap-x-1.5" dir="ltr">
      <s className="text-ink-soft">{formatCents(c, intl)}</s><b className="text-accent-700">{formatCents(discounted(c, discountBp), intl)}</b>
    </span> : <span className="num" dir="ltr">{formatCents(c, intl)}</span>
  );
  return (
    <div className="space-y-3">
      <ProductPickerBar options={options} onPick={pick} placeholder={T.pick} stockLabel={t.sales.available} labels={t.picker}
        priceOf={(o) => formatCents(o.retailPriceCents, intl)} qtyInDoc={(vid) => { const o = options.find((x) => x.id === vid); return o && has.has(o.productId ?? o.id) ? 1 : 0; }}
        linesCount={items.length} />
      <div>
        <p className="label">{T.chosen.replace("{n}", String(items.length))}</p>
        {items.length === 0 ? <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-ink-soft">{T.noneChosen}</p> : (
          <ul className="divide-y divide-black/5 rounded-xl ring-1 ring-black/5" data-promo-items>
            {items.map((it) => (
              <li key={it.productId} className="flex items-center gap-3 px-3 py-2">
                <Thumb id={it.imageId} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold" dir="auto">{it.name}</div>
                  <div className="flex flex-wrap gap-x-3 text-xs text-ink-soft">
                    <span>{t.customer.RETAIL}: {price(it.retail)}</span>
                    <span>{t.customer.WHOLESALE}: {price(it.wholesale)}</span>
                  </div>
                </div>
                <button type="button" onClick={() => onChange(items.filter((x) => x.productId !== it.productId))} className="btn-ghost group h-9 w-9 shrink-0 p-0" aria-label={T.removeItem} title={T.removeItem}>
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
