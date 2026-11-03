"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Thumb } from "./Thumb";
import { searchOptions } from "@/lib/product-search";

export type PickerOption = {
  id: string; sku: string; nameDe: string; nameNl: string; size: string; color: string; barcode: string | null; stockQty: number; imageId?: string | null;
  productId?: string; category?: string;
};

export function optionLabel(o: Pick<PickerOption, "nameDe" | "size" | "color">) {
  const extra = [o.size, o.color].filter(Boolean).join(" · ");
  return extra ? `${o.nameDe} (${extra})` : o.nameDe;
}

/** Suche nach Name (DE/NL), Art.-Nr., Barcode, Größe/Farbe oder Kategorie. Enter wählt den ersten Treffer.
 *  Mit `category`: nur Artikel dieser Kategorie – dann zeigt die Liste schon beim Antippen alle (ohne Tippen). */
export function VariantPicker({ options, placeholder, onPick, stockLabel, category }: {
  options: PickerOption[]; placeholder: string; onPick: (o: PickerOption) => void; stockLabel: string; category?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const pool = category ? options.filter((o) => (o.category ?? "") === category) : options;
    if (!q.trim()) return category ? pool.slice(0, 100) : [];
    return searchOptions(pool, q).slice(0, category ? 100 : 12);
  }, [q, options, category]);
  useEffect(() => { setHi(0); if (category) setOpen(true); }, [category]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (o: PickerOption) => { onPick(o); setQ(""); setOpen(false); setHi(0); };

  return (
    <div ref={ref} className="relative">
      <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
      <input value={q} placeholder={placeholder} className="input ps-9"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, results.length - 1)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          if (e.key === "Enter") { e.preventDefault(); if (results[hi]) pick(results[hi]); }
          if (e.key === "Escape") setOpen(false);
        }} />
      {open && results.length > 0 && (
        <ul className="absolute z-30 mt-2 max-h-80 w-full overflow-auto rounded-xl bg-white p-1 shadow-lift ring-1 ring-black/5 animate-rise">
          {results.map((o, i) => (
            <li key={o.id}>
              <button type="button" onMouseEnter={() => setHi(i)} onClick={() => pick(o)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-start text-sm ${i === hi ? "bg-brand-50" : ""}`}>
                <Thumb id={o.imageId} size={40} />
                <span className="me-auto">
                  <span className="font-semibold">{optionLabel(o)}</span>
                  <span className="block text-xs text-ink-soft" dir="ltr">{o.sku}{o.barcode && o.barcode !== o.sku ? ` · ${o.barcode}` : ""}</span>
                </span>
                <span className="badge shrink-0 bg-brand-50 text-brand-700">{stockLabel}: {o.stockQty}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
