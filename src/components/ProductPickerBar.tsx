"use client";
import { useCallback, useMemo, useState } from "react";
import { Icon } from "./Icon";
import { ProductBrowser, type BrowserLabels } from "./ProductBrowser";
import { VariantPicker, type PickerOption } from "./VariantPicker";
import { CategorySelect } from "./CategorySelect";
import { categoryCounts } from "@/lib/product-search";

export type PickerLabels = Omit<BrowserLabels, "available"> & { browseAll: string; searchLabel: string };

/** Artikel finden – überall gleich (Wunsch Inhaber 03.11.2026): Kategorie wählen, suchen (Name, Nr., Barcode, Kategorie)
 *  oder alle Artikel im Fenster durchsehen und antippen. `compact`: nur Suche + Knopf „alle“ (z. B. in Tabellenzeilen). */
export function ProductPickerBar<T extends PickerOption>({ options, onPick, placeholder, stockLabel, labels, priceOf, qtyInDoc, linesCount, compact = false, closeOnPick = false }: {
  options: T[]; onPick: (o: T) => void; placeholder: string; stockLabel: string; labels: PickerLabels;
  priceOf?: (o: T) => string; qtyInDoc?: (variantId: string) => number; linesCount?: number; compact?: boolean; closeOnPick?: boolean;
}) {
  const [cat, setCat] = useState("");
  const [browse, setBrowse] = useState(false);
  const close = useCallback(() => setBrowse(false), []);
  const categories = useMemo(() => categoryCounts(options), [options]);
  const pick = (o: PickerOption) => onPick(o as T);

  return (
    <>
      <div className={compact ? "flex items-center gap-2" : "flex flex-col gap-3 md:flex-row md:items-end"}>
        {!compact && categories.length > 0 && (
          <CategorySelect categories={categories} value={cat} onChange={setCat} label={labels.category} allLabel={labels.all} className="md:w-64" />
        )}
        <div className="min-w-0 flex-1">
          {!compact && <span className="label">{labels.searchLabel}</span>}
          <VariantPicker options={options} placeholder={placeholder} onPick={pick} stockLabel={stockLabel} category={cat || undefined} />
        </div>
        <button type="button" onClick={() => setBrowse(true)} title={labels.browseAll} aria-label={labels.browseAll}
          className={`btn group shrink-0 bg-brand-600 text-white shadow-card hover:bg-brand-700 hover:shadow-lift ${compact ? "h-11 w-11 p-0" : ""}`}>
          <Icon name="grid" className="h-4 w-4" />{!compact && labels.browseAll}
        </button>
      </div>
      {browse && (
        <ProductBrowser options={options} onPick={onPick} onClose={close} priceOf={priceOf} qtyInDoc={qtyInDoc} linesCount={linesCount}
          initialCategory={cat} closeOnPick={closeOnPick} labels={{ ...labels, available: stockLabel }} />
      )}
    </>
  );
}
