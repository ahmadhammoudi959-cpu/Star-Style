"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icon";
import { Thumb } from "./Thumb";

export type PickItem = { label: string; sub?: string; href: string; search: string; imageId?: string | null };

/** Suchfeld mit Auswahlliste (Wunsch Inhaber 03.11.2026: aus den Möglichkeiten wählen statt nur tippen):
 *  beim Antippen erscheinen die ersten Einträge, Tippen grenzt ein, Antippen öffnet den Eintrag direkt.
 *  Enter ohne Auswahl filtert die Liste darunter (GET-Formular, Feld `name`). */
export function SearchPick({ name, defaultValue = "", placeholder, label, items, emptyLabel, max = 8 }: {
  name: string; defaultValue?: string; placeholder: string; label?: string; items: PickItem[]; emptyLabel: string; max?: number;
}) {
  const router = useRouter();
  const [q, setQ] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? items.filter((i) => i.search.includes(s)) : items).slice(0, max);
  }, [q, items, max]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div ref={ref} className="relative min-w-0">
      {label && <span className="label">{label}</span>}
      <span className="relative block">
        <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
        <input name={name} value={q} placeholder={placeholder} autoComplete="off" className="input pe-9 ps-9"
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, hits.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, -1)); }
            if (e.key === "Enter" && open && hi >= 0 && hits[hi]) { e.preventDefault(); router.push(hits[hi].href); }
            if (e.key === "Escape") setOpen(false);
          }} />
        {/* Liste ein-/ausklappen: zeigt die Möglichkeiten auch ohne Tippen */}
        <button type="button" tabIndex={-1} aria-label={placeholder} onClick={() => setOpen((o) => !o)}
          className="absolute end-2 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-lg text-ink-soft hover:bg-brand-50">
          <svg viewBox="0 0 24 24" className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth={2}><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </span>
      {open && (
        <ul className="absolute z-30 mt-2 max-h-80 w-full overflow-auto rounded-xl bg-white p-1 shadow-lift ring-1 ring-black/5 animate-rise">
          {hits.length === 0 ? <li className="px-3 py-3 text-sm text-ink-soft">{emptyLabel}</li> : hits.map((i, k) => (
            <li key={i.href}>
              <button type="button" onMouseEnter={() => setHi(k)} onClick={() => router.push(i.href)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm ${k === hi ? "bg-brand-50" : ""}`}>
                {i.imageId !== undefined && <Thumb id={i.imageId} size={36} />}
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold [overflow-wrap:anywhere]">{i.label}</span>
                  {i.sub && <span className="block text-xs text-ink-soft [overflow-wrap:anywhere]">{i.sub}</span>}
                </span>
                <Icon name="eye" className="h-4 w-4 shrink-0 text-brand-600" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
