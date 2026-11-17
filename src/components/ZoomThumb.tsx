"use client";
import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { Thumb } from "./Thumb";
import { zoomPlacement, zoomSize } from "@/lib/zoom-place";

export type ZoomInfo = { title: string; sub?: string; price?: string };

/** Mit Maus (nicht am Handy): Zeigen auf das Foto öffnet es groß daneben (Wunsch Inhaber 17.11.2026 – der Kunde neben
 *  dem Mitarbeiter soll den Artikel sehen). Mit `onOpen`: Klick öffnet die Kundenansicht (ProductShowcase). */
export function ZoomThumb({ id, size = 40, info, onOpen, openLabel, className = "" }: {
  id?: string | null; size?: number; info?: ZoomInfo; onOpen?: () => void; openLabel?: string; className?: string;
}) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; caption: number } | null>(null);
  const ref = useRef<HTMLElement>(null);
  const timer = useRef<number | undefined>(undefined);

  const hide = () => { window.clearTimeout(timer.current); setBox(null); };
  const show = () => {
    if (!id || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const view = { width: window.innerWidth, height: window.innerHeight };
      const caption = info ? Math.round(4.75 * rem) : 0;
      const width = zoomSize(view, rem, caption);
      setBox({ ...zoomPlacement(r, view, { width, height: width + caption }), width, caption });
    }, 120);
  };

  // Scrollen, Taste oder Klick irgendwo: Vorschau weg (sonst bliebe sie an der alten Stelle stehen)
  useEffect(() => {
    if (!box) return;
    const off = () => hide();
    window.addEventListener("scroll", off, true);
    window.addEventListener("keydown", off);
    window.addEventListener("pointerdown", off, true);
    return () => { window.removeEventListener("scroll", off, true); window.removeEventListener("keydown", off); window.removeEventListener("pointerdown", off, true); };
  }, [box]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const enter = (e: React.PointerEvent) => { if (e.pointerType === "mouse") show(); };
  const thumb = <Thumb id={id} size={size} className={className} />;
  const preview = box && id ? createPortal(
    <div aria-hidden className="pointer-events-none fixed z-[70] overflow-hidden rounded-2xl bg-white shadow-lift ring-1 ring-black/10 motion-safe:animate-zoom"
      style={{ left: box.left, top: box.top, width: box.width }} data-zoom-preview>
      <div className="flex items-center justify-center bg-white p-3" style={{ height: box.width }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/files/${id}`} alt="" className="max-h-full max-w-full object-contain" />
      </div>
      {info && (
        <div className="space-y-0.5 border-t border-black/5 px-4 py-2.5" style={{ minHeight: box.caption }}>
          <div className="line-clamp-2 font-semibold leading-snug" dir="auto">{info.title}</div>
          <div className="flex items-baseline justify-between gap-3 text-xs text-ink-soft">
            <span className="min-w-0 truncate" dir="auto">{info.sub}</span>
            {info.price && <span className="num shrink-0 text-base font-bold text-brand-700">{info.price}</span>}
          </div>
        </div>
      )}
    </div>,
    document.body,
  ) : null;

  if (onOpen) return (
    <>
      <button type="button" ref={ref as RefObject<HTMLButtonElement>} onPointerEnter={enter} onPointerLeave={hide}
        onClick={(e) => { e.stopPropagation(); hide(); onOpen(); }} title={openLabel} aria-label={openLabel}
        className="group/zoom relative shrink-0 cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand-400">
        {thumb}
        <span className="pointer-events-none absolute -bottom-1 -end-1 grid h-5 w-5 place-items-center rounded-full bg-white text-brand-700 opacity-0 shadow ring-1 ring-black/10 transition group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100">
          <Icon name="zoom" className="h-3 w-3" />
        </span>
      </button>
      {preview}
    </>
  );
  return (
    <>
      <span ref={ref as RefObject<HTMLSpanElement>} onPointerEnter={enter} onPointerLeave={hide} className={`inline-flex shrink-0 ${id ? "cursor-zoom-in" : ""}`}>{thumb}</span>
      {preview}
    </>
  );
}
