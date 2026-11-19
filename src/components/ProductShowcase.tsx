"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { PromoPrice } from "./PromoPrice";
import type { PickerOption } from "./VariantPicker";
import type { BrowserLabels } from "./ProductBrowser";

export type ShowcaseGroup<T> = { key: string; productId: string | null; name: string; sku: string; category: string; imageId: string | null; variants: T[] };

// Foto-Listen je Artikel nur einmal je Seitenaufruf holen
const photoCache = new Map<string, string[]>();

/** Fotos, die das Fenster schon kennt: Artikelfoto + eigene Fotos der Größen/Farben */
function knownPhotos<T extends PickerOption>(g: ShowcaseGroup<T>): string[] {
  return [...new Set([g.imageId, ...g.variants.map((v) => v.imageId)].filter((x): x is string => !!x))];
}

/**
 * Kundenansicht (Wunsch Inhaber 17.11.2026: „der Kunde sitzt neben mir … wie ein Katalog, professionell“):
 * ein Artikel groß über den ganzen Bildschirm – alle Fotos (Lager + Shop), Name, Größen/Farben mit Preis und „+“ zum
 * Hinzufügen, Blättern mit Pfeilen/Tasten/Wischen durch die gerade gezeigten Artikel, auf Wunsch Vollbild.
 * Ohne Bestandszahlen (nur „auf Lager“/„nicht auf Lager“) und ohne Einkaufspreis – der Kunde schaut mit.
 */
export function ProductShowcase<T extends PickerOption>({ groups, index, onIndex, onClose, onAdd, priceOf, wasOf, qtyInDoc, flash, labels }: {
  groups: ShowcaseGroup<T>[]; index: number; onIndex: (i: number) => void; onClose: () => void; onAdd: (o: T) => void;
  priceOf?: (o: T) => string; wasOf?: (o: T) => string; qtyInDoc?: (variantId: string) => number; flash: string | null; labels: BrowserLabels;
}) {
  const g = groups[Math.min(index, groups.length - 1)];
  const [photos, setPhotos] = useState<string[]>(() => knownPhotos(g));
  const [active, setActive] = useState(0);
  const [full, setFull] = useState(false);
  const [canFull, setCanFull] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";

  const go = (step: number) => { if (groups.length > 1) onIndex((index + step + groups.length) % groups.length); };
  const goRef = useRef(go);
  goRef.current = go;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Fotos des Artikels: sofort die bekannten, dann alle (inkl. Shop-Galerie) vom Server
  useEffect(() => {
    const base = knownPhotos(g);
    setActive(0);
    const pid = g.productId;
    const cached = pid ? photoCache.get(pid) : undefined;
    setPhotos(cached?.length ? cached : base);
    if (!pid || cached) return;
    let alive = true;
    fetch(`/api/products/${encodeURIComponent(pid)}/photos`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ids?: unknown } | null) => {
        const ids = Array.isArray(j?.ids) ? j.ids.filter((x): x is string => typeof x === "string") : [];
        photoCache.set(pid, ids);
        if (alive && ids.length) setPhotos(ids);
      })
      .catch(() => { /* bleibt bei den bekannten Fotos */ });
    return () => { alive = false; };
  }, [g]);

  // nächsten und vorigen Artikel schon laden, damit das Blättern sofort ein Bild zeigt
  useEffect(() => {
    for (const s of [1, -1]) {
      const n = groups[(index + s + groups.length) % groups.length];
      if (n?.imageId) { const im = new Image(); im.src = `/api/files/${n.imageId}`; }
    }
  }, [index, groups]);

  // Tasten: Esc schließt (nur die Kundenansicht, das Artikel-Fenster bleibt), Pfeile blättern (in RTL gespiegelt)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeRef.current(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goRef.current(rtl ? -1 : 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); goRef.current(rtl ? 1 : -1); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [rtl]);

  // Vollbild (z. B. Bildschirm zum Kunden gedreht); beim Schließen wieder normal
  useEffect(() => {
    setCanFull(!!document.fullscreenEnabled);
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => {
      document.removeEventListener("fullscreenchange", f);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* egal */ });
    };
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => { /* egal */ });
    else rootRef.current?.requestFullscreen().catch(() => { /* nicht erlaubt */ });
  };

  const act = Math.min(active, Math.max(0, photos.length - 1));
  const photo = photos[act] ?? null;
  const showPhoto = (id?: string | null) => { const i = id ? photos.indexOf(id) : -1; if (i >= 0) setActive(i); };
  const single = g.variants.length === 1;

  return createPortal(
    <div ref={rootRef} className="fixed inset-0 z-[60] flex flex-col bg-navy-900/95 text-white backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={g.name} data-showcase>
      {/* Kopf: Zähler, Vollbild, Schließen */}
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-6">
        <span className="num rounded-full bg-white/10 px-3 py-1 text-sm font-semibold ring-1 ring-white/15" data-showcase-count>{index + 1} / {groups.length}</span>
        <div className="flex items-center gap-2">
          {canFull && (
            <button type="button" onClick={toggleFull} title={full ? labels.exitFullscreen : labels.fullscreen} aria-label={full ? labels.exitFullscreen : labels.fullscreen}
              className="group grid h-11 w-11 place-items-center rounded-full bg-white/10 ring-1 ring-white/15 transition hover:bg-white/20">
              <Icon name={full ? "shrink" : "expand"} className="h-5 w-5" />
            </button>
          )}
          <button type="button" onClick={onClose} title={labels.close} aria-label={labels.close}
            className="group grid h-11 w-11 place-items-center rounded-full bg-white/10 ring-1 ring-white/15 transition hover:bg-white/20" data-showcase-close>
            <Icon name="x" className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-6 lg:grid-cols-[minmax(0,1fr)_25rem] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
        {/* Foto groß + Fotoleiste (Handy: untereinander und zusammen scrollbar, ab lg nebeneinander in voller Höhe) */}
        <div className="flex flex-col gap-3 lg:min-h-0">
          <div className="relative flex h-[48vh] shrink-0 items-center justify-center overflow-hidden rounded-3xl bg-white shadow-lift lg:h-auto lg:min-h-0 lg:flex-1"
            onTouchStart={(e) => { const t = e.touches[0]; touch.current = { x: t.clientX, y: t.clientY }; }}
            onTouchEnd={(e) => {
              const s = touch.current; touch.current = null;
              if (!s) return;
              const t = e.changedTouches[0]; const dx = t.clientX - s.x, dy = t.clientY - s.y;
              if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? (rtl ? -1 : 1) : (rtl ? 1 : -1));
            }}>
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={photo} src={`/api/files/${photo}`} alt={g.name} className="h-full w-full object-contain p-4 motion-safe:animate-zoom sm:p-8" data-showcase-photo />
            ) : (
              <Icon name="box" className="h-24 w-24 text-brand-200" />
            )}
            {groups.length > 1 && (
              <>
                <button type="button" onClick={() => go(-1)} title={labels.prev} aria-label={labels.prev}
                  className="group absolute start-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-navy-900/70 text-white shadow-lift ring-1 ring-white/20 transition hover:bg-brand-600 sm:h-14 sm:w-14">
                  <Icon name="chevronLeft" className="h-7 w-7 rtl:rotate-180" />
                </button>
                <button type="button" onClick={() => go(1)} title={labels.next} aria-label={labels.next}
                  className="group absolute end-3 top-1/2 grid h-12 w-12 -translate-y-1/2 place-items-center rounded-full bg-navy-900/70 text-white shadow-lift ring-1 ring-white/20 transition hover:bg-brand-600 sm:h-14 sm:w-14" data-showcase-next>
                  <Icon name="chevronRight" className="h-7 w-7 rtl:rotate-180" />
                </button>
              </>
            )}
            {photos.length > 1 && (
              <span className="num absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-navy-900/70 px-3 py-1 text-xs font-semibold text-white">
                {labels.photoN.replace("{n}", String(act + 1)).replace("{m}", String(photos.length))}
              </span>
            )}
          </div>
          {photos.length > 1 && (
            <div className="flex shrink-0 gap-2 overflow-x-auto pb-1" data-showcase-strip>
              {photos.map((p, i) => (
                <button key={p} type="button" onClick={() => setActive(i)} aria-label={labels.photoN.replace("{n}", String(i + 1)).replace("{m}", String(photos.length))}
                  className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-white p-1 ring-2 transition sm:h-20 sm:w-20 ${i === act ? "ring-brand-400" : "opacity-60 ring-transparent hover:opacity-100"}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/files/${p}`} alt="" loading="lazy" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Name, Größen/Farben mit Preis, Hinzufügen */}
        <aside className="flex flex-col gap-4 rounded-3xl bg-white p-5 text-ink shadow-lift lg:min-h-0 lg:overflow-y-auto">
          <div className="space-y-1">
            {g.category && <div className="text-sm font-semibold text-brand-700" dir="auto">{g.category}</div>}
            <h2 className="text-2xl font-bold leading-tight [overflow-wrap:anywhere]" dir="auto" data-showcase-name>{g.name}</h2>
            <div className="text-xs text-ink-soft"><bdi dir="ltr">{g.sku}</bdi></div>
          </div>
          <div className="grid gap-2">
            {g.variants.map((o) => {
              const label = [o.size, o.color].filter(Boolean).join(" · ") || (single ? labels.add : g.name);
              const price = priceOf?.(o) ?? "";
              const inDoc = qtyInDoc?.(o.id) ?? 0;
              const on = flash === o.id;
              return (
                <button key={o.id} type="button" onClick={() => onAdd(o)} onMouseEnter={() => showPhoto(o.imageId)} onFocus={() => showPhoto(o.imageId)}
                  className={`group flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-start ring-1 transition active:scale-[0.99] ${on ? "bg-emerald-50 ring-emerald-300" : "bg-slate-50 ring-black/10 hover:bg-brand-50 hover:ring-brand-200"}`}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-white shadow-card">
                    <Icon name={on ? "check" : "plus"} className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold [overflow-wrap:anywhere]" dir="auto">{label}</span>
                    <span className="flex items-center gap-1.5 text-xs text-ink-soft">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${o.stockQty > 0 ? "bg-emerald-500" : "bg-red-500"}`} />
                      {o.stockQty > 0 ? labels.inStock : labels.outOfStock}
                    </span>
                  </span>
                  {price && <span className="shrink-0 text-lg font-bold text-brand-700"><PromoPrice price={price} was={o.promoPct ? wasOf?.(o) : undefined} pct={o.promoPct} /></span>}
                  {inDoc > 0 && <span className="badge shrink-0 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">{labels.inDoc.replace("{n}", String(inDoc))}</span>}
                </button>
              );
            })}
          </div>
        </aside>
      </div>
    </div>,
    document.body,
  );
}
