"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { PromoCorner, PromoPrice } from "./PromoPrice";
import { ZoomThumb } from "./ZoomThumb";
import { ProductShowcase, type ShowcaseGroup } from "./ProductShowcase";
import type { PickerOption } from "./VariantPicker";
import { categoryCounts, searchOptions } from "@/lib/product-search";
import { CategorySelect } from "./CategorySelect";

export type BrowserLabels = {
  title: string; search: string; searchLabel: string; category: string; all: string; add: string; inDoc: string; done: string; empty: string; available: string; lines: string;
  viewList: string; viewCatalog: string; hint: string; showcase: string; prev: string; next: string; close: string;
  fullscreen: string; exitFullscreen: string; inStock: string; outOfStock: string; photoN: string;
};

type Group<T> = ShowcaseGroup<T> & { nameNl: string };
type View = "list" | "catalog";
const VIEW_KEY = "ss-picker-view"; // Liste oder Katalog – je Gerät gemerkt

/** Alle Artikel als Liste zum Durchsehen und Antippen (Fenster über der Seite): Suche, Kategorien, je Artikel seine Größen/Farben.
 *  Bleibt offen, damit man mehrere Positionen nacheinander hinzufügen kann. */
export function ProductBrowser<T extends PickerOption>({ options, onPick, onClose, labels, priceOf, wasOf, qtyInDoc, linesCount, initialCategory = "", closeOnPick = false }: {
  options: T[]; onPick: (o: T) => void; onClose: () => void; labels: BrowserLabels;
  priceOf?: (o: T) => string; wasOf?: (o: T) => string; qtyInDoc?: (variantId: string) => number; linesCount?: number; initialCategory?: string;
  /** nur eine Auswahl (z. B. Zuordnung im Shop): nach dem Antippen schließen */
  closeOnPick?: boolean;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState(initialCategory);
  const [flash, setFlash] = useState<string | null>(null);
  const [view, setView] = useState<View>("list");
  const [show, setShow] = useState<number | null>(null); // Kundenansicht: Index in `groups`
  const searchRef = useRef<HTMLInputElement>(null);
  const showRef = useRef(show);
  showRef.current = show;

  const categories = useMemo(() => categoryCounts(options), [options]);

  const groups = useMemo(() => {
    const pool = cat ? options.filter((o) => (o.category ?? "") === cat) : options;
    const hits = q.trim() ? searchOptions(pool, q) : pool;
    const m = new Map<string, Group<T>>();
    for (const o of hits) {
      const key = o.productId ?? o.id;
      if (!m.has(key)) m.set(key, { key, productId: o.productId ?? null, name: o.nameDe, nameNl: o.nameNl, sku: o.sku, category: o.category ?? "", imageId: o.imageId ?? null, variants: [] });
      m.get(key)!.variants.push(o);
    }
    // Varianten im Artikel in Formular-Reihenfolge (wie geladen), nicht nach Treffer-Reihenfolge
    const order = new Map(options.map((o, i) => [o.id, i]));
    for (const g of m.values()) g.variants.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return [...m.values()];
  }, [options, q, cat]);

  // Seite dahinter nicht scrollen; Esc schließt. Suchfeld nur mit Maus/PC gleich aktiv (auf dem Handy sonst sofort die Tastatur).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Esc bei offener Kundenansicht schließt nur diese (sie fängt die Taste selbst ab)
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && showRef.current == null) closeRef.current(); };
    document.addEventListener("keydown", esc);
    if (window.matchMedia("(pointer: fine)").matches) searchRef.current?.focus({ preventScroll: true });
    try { if (localStorage.getItem(VIEW_KEY) === "catalog") setView("catalog"); } catch { /* ohne Speicher: Liste */ }
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  const pickView = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* egal */ } };

  // Filter geändert, während die Kundenansicht offen ist: im Bereich bleiben bzw. schließen
  useEffect(() => {
    if (show == null) return;
    if (!groups.length) setShow(null);
    else if (show >= groups.length) setShow(groups.length - 1);
  }, [groups, show]);

  const add = (o: T) => {
    onPick(o);
    if (closeOnPick) { setShow(null); onClose(); return; }
    setFlash(o.id); window.setTimeout(() => setFlash((f) => (f === o.id ? null : f)), 900);
  };

  // Über den ganzen Bildschirm: direkt in <body> (Karten mit Einblend-Animation wären sonst der Bezugsrahmen für „fixed“)
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-navy-900/50 p-0 backdrop-blur-sm sm:p-4 lg:p-8" role="dialog" aria-modal="true" aria-label={labels.title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div className="flex w-full max-w-6xl flex-col overflow-hidden bg-[#f4f6fa] shadow-lift animate-rise sm:rounded-2xl">
        {/* Kopf: Titel, Suche, Kategorien */}
        <div className="space-y-3 border-b border-black/5 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="grid" className="h-5 w-5 text-brand-600" />{labels.title}</h2>
              <p className="hidden text-xs text-ink-soft sm:block">{labels.hint}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex rounded-xl bg-slate-100 p-1 ring-1 ring-black/5" role="group" aria-label={`${labels.viewList} / ${labels.viewCatalog}`}>
                {(["list", "catalog"] as const).map((v) => (
                  <button key={v} type="button" onClick={() => pickView(v)} aria-pressed={view === v} title={v === "list" ? labels.viewList : labels.viewCatalog}
                    className={`group flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-semibold transition ${view === v ? "bg-white text-brand-700 shadow-card" : "text-ink-soft hover:text-ink"}`} data-view={v}>
                    <Icon name={v === "list" ? "list" : "grid"} className="h-4 w-4" />
                    <span className="hidden sm:inline">{v === "list" ? labels.viewList : labels.viewCatalog}</span>
                  </button>
                ))}
              </div>
              <button type="button" onClick={onClose} aria-label={labels.done} className="btn-ghost group h-10 w-10 p-0"><Icon name="x" className="h-5 w-5" /></button>
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            {categories.length > 0 && (
              <CategorySelect categories={categories} value={cat} onChange={setCat} label={labels.category} allLabel={labels.all} className="sm:w-64" />
            )}
            <label className="block min-w-0 flex-1">
              <span className="label">{labels.searchLabel}</span>
              <span className="relative block">
                <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
                <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder={labels.search} className="input ps-9" />
              </span>
            </label>
          </div>
        </div>

        {/* Artikel */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
          {groups.length === 0 ? (
            <p className="py-16 text-center text-sm text-ink-soft">{labels.empty}</p>
          ) : (
            <div className={`grid items-start gap-3 ${view === "catalog" ? "grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" : "md:grid-cols-2 xl:grid-cols-3"}`} data-browser-view={view}>
              {groups.map((g, i) => {
                const single = g.variants.length === 1 ? g.variants[0] : null;
                const compact = view === "catalog";
                const buttons = single ? (
                  <VariantButton o={single} label={labels.add} flash={flash === single.id} price={priceOf?.(single) ?? ""} was={single.promoPct ? wasOf?.(single) : undefined} inDoc={qtyInDoc?.(single.id) ?? 0}
                    labels={labels} compact={compact} onClick={() => add(single)} />
                ) : (
                  <div className="grid gap-1.5">
                    {g.variants.map((o) => (
                      <VariantButton key={o.id} o={o} label={[o.size, o.color].filter(Boolean).join(" · ") || labels.add} flash={flash === o.id}
                        price={priceOf?.(o) ?? ""} was={o.promoPct ? wasOf?.(o) : undefined} inDoc={qtyInDoc?.(o.id) ?? 0} labels={labels} compact={compact} onClick={() => add(o)} />
                    ))}
                  </div>
                );
                const title = (
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold leading-snug [overflow-wrap:anywhere]">{g.name}</div>
                    <div className="text-xs text-ink-soft"><bdi dir="ltr">{g.sku}</bdi>{g.category ? ` · ${g.category}` : ""}</div>
                  </div>
                );
                if (view === "catalog") return (
                  // Katalog: großes Foto oben, Klick = Kundenansicht
                  <div key={g.key} className="card card-hover flex flex-col overflow-hidden p-0" data-catalog-card>
                    <button type="button" onClick={() => setShow(i)} title={labels.showcase} aria-label={`${labels.showcase}: ${g.name}`}
                      className="group/img relative block aspect-square w-full cursor-zoom-in overflow-hidden bg-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-400">
                      {g.imageId ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/files/${g.imageId}`} alt={g.name} loading="lazy" className="h-full w-full object-contain p-3 transition duration-300 motion-safe:group-hover/img:scale-105" />
                      ) : (
                        <span className="grid h-full place-items-center bg-brand-50/50 text-brand-200"><Icon name="box" className="h-14 w-14" /></span>
                      )}
                      <PromoCorner pct={Math.max(0, ...g.variants.map((v) => v.promoPct ?? 0))} />
                      <span className="absolute end-2 top-2 grid h-9 w-9 place-items-center rounded-full bg-white/95 text-brand-700 opacity-0 shadow-card ring-1 ring-black/10 transition group-hover/img:opacity-100 group-focus-visible/img:opacity-100">
                        <Icon name="zoom" className="h-4 w-4" />
                      </span>
                    </button>
                    <div className="flex flex-1 flex-col gap-2 border-t border-black/5 p-3">{title}{buttons}</div>
                  </div>
                );
                return (
                  <div key={g.key} className="card card-hover flex flex-col gap-2 p-3">
                    <div className="flex items-start gap-3">
                      <ZoomThumb id={g.imageId} size={56} onOpen={() => setShow(i)} openLabel={labels.showcase}
                        info={{ title: g.name, sub: g.category, price: single ? priceOf?.(single) : undefined }} />
                      {title}
                    </div>
                    {buttons}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Fuß: Anzahl Positionen + Fertig */}
        <div className="flex items-center justify-between gap-3 border-t border-black/5 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <span className="text-sm text-ink-soft">{linesCount != null && <>{labels.lines}: <span className="num font-bold text-ink">{linesCount}</span></>}</span>
          <button type="button" onClick={onClose} className="btn-primary px-8"><Icon name="check" className="h-4 w-4" />{labels.done}</button>
        </div>
      </div>
      {show != null && groups.length > 0 && (
        <ProductShowcase groups={groups} index={Math.min(show, groups.length - 1)} onIndex={setShow} onClose={() => setShow(null)} onAdd={add}
          priceOf={priceOf} wasOf={wasOf} qtyInDoc={qtyInDoc} flash={flash} labels={labels} />
      )}
    </div>,
    document.body,
  );
}

function VariantButton({ o, label, price, was, inDoc, flash, labels, onClick, compact = false }: {
  o: PickerOption; label: string; price: string; was?: string; inDoc: number; flash: boolean; labels: BrowserLabels; onClick: () => void;
  /** Katalog (schmale Karten): ohne Barcode, Preis und Bestand unter dem Namen */
  compact?: boolean;
}) {
  const none = o.stockQty <= 0;
  if (compact) return (
    <button type="button" onClick={onClick}
      className={`group flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-start text-sm ring-1 transition active:scale-[0.99] ${flash ? "bg-emerald-50 ring-emerald-300" : "bg-white ring-black/10 hover:bg-brand-50 hover:ring-brand-200"}`}>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-600 text-white">
        <Icon name={flash ? "check" : "plus"} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold leading-snug [overflow-wrap:anywhere]">{label}</span>
        <span className="flex flex-wrap items-baseline gap-x-2 text-[0.6875rem] text-ink-soft">
          {price && <PromoPrice price={price} was={was} pct={o.promoPct} className="text-sm font-semibold text-ink" />}
          <span className={none ? "font-semibold text-red-600" : ""}>{labels.available}: {o.stockQty}</span>
        </span>
        {inDoc > 0 && <span className="badge mt-1 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">{labels.inDoc.replace("{n}", String(inDoc))}</span>}
      </span>
    </button>
  );
  return (
    <button type="button" onClick={onClick}
      className={`group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-start text-sm ring-1 transition active:scale-[0.99] ${flash ? "bg-emerald-50 ring-emerald-300" : "bg-white ring-black/10 hover:bg-brand-50 hover:ring-brand-200"}`}>
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-600 text-white">
        <Icon name={flash ? "check" : "plus"} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold [overflow-wrap:anywhere]">{label}</span>
        {o.barcode && <bdi dir="ltr" className="block text-[0.6875rem] text-ink-soft">{o.barcode}</bdi>}
      </span>
      <span className={o.promoPct ? "min-w-[5.5rem] max-w-[8.5rem] text-end" : "shrink-0 text-end"}>
        {price && <span className="block font-semibold"><PromoPrice price={price} was={was} pct={o.promoPct} /></span>}
        <span className={`block text-[0.6875rem] ${none ? "font-semibold text-red-600" : "text-ink-soft"}`}>{labels.available}: {o.stockQty}</span>
      </span>
      {inDoc > 0 && <span className="badge shrink-0 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">{labels.inDoc.replace("{n}", String(inDoc))}</span>}
    </button>
  );
}
