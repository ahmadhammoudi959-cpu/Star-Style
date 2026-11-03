"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

export type NavItem = { href: string; label: string; icon: IconName; soon?: boolean; step?: { n: number; next: boolean }; highlight?: boolean };

export function SideNav({ items, soonLabel }: { items: NavItem[]; soonLabel: string }) {
  const path = usePathname();
  return (
    <nav className="space-y-1 short:space-y-0.5">
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        if (it.soon)
          return (
            <span key={it.href} title={soonLabel} className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-white/40 short:py-1.5 tiny:py-1">
              <Icon name={it.icon} />{it.label}
            </span>
          );
        return (
          <Link key={it.href} href={it.href}
            className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition short:py-1.5 tiny:py-1 ${active ? "border-s-4 border-accent-500 bg-white text-brand-700 shadow-card" : "text-white/80 hover:bg-white/10 hover:text-white"}`}>
            <Icon name={it.icon} />{it.label}
            {it.step && (
              <span title={String(it.step.n)} className={`ms-auto grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${it.step.next ? "bg-accent-500 text-white animate-pulse" : active ? "bg-brand-100 text-brand-700" : "bg-white/15 text-white"}`}>{it.step.n}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

const isActive = (href: string, path: string) => (href === "/" ? path === "/" : path.startsWith(href));

/**
 * Handy: Leiste unten (Start, Verkauf, Scanner in der Mitte, Lager, „Menü“). „Menü“ öffnet alle Seiten der Seitenleiste
 * als große Kacheln von unten (Wunsch Inhaber 03.11.2026: auf dem Handy alles erreichbar und bequem).
 */
export function BottomNav({ items, all, menuLabel, closeLabel, footer }: {
  items: NavItem[]; all: NavItem[]; menuLabel: string; closeLabel: string; footer?: ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // Seite gewechselt → Menü zu
  useEffect(() => { setOpen(false); }, [path]);
  const inMenu = !items.some((it) => isActive(it.href, path)); // aktuelle Seite liegt nur im Menü
  const cols = items.length + 1;
  return (
    <>
      <nav className="print:hidden fixed inset-x-0 bottom-0 z-30 grid border-t border-black/5 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-lift backdrop-blur lg:hidden"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {items.map((it) => {
          const active = isActive(it.href, path);
          // hervorgehoben (Scanner): runder Knopf, der etwas aus der Leiste ragt
          if (it.highlight) return (
            <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined}
              className="group flex flex-col items-center gap-0.5 pb-2 text-[0.6875rem] font-bold text-brand-700">
              <span className={`-mt-4 grid h-12 w-12 place-items-center rounded-full text-white shadow-lift ring-4 ring-white transition group-active:scale-95 ${active ? "bg-accent-500" : "bg-gradient-to-br from-brand-500 to-brand-700"}`}>
                <Icon name={it.icon} className="h-6 w-6" />
              </span>
              {it.label}
            </Link>
          );
          return (
            <Link key={it.href} href={it.soon ? "#" : it.href} aria-disabled={it.soon} aria-current={active ? "page" : undefined}
              className={`group flex min-w-0 flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-semibold ${active ? "text-brand-600" : it.soon ? "text-ink-soft/40" : "text-ink-soft"}`}>
              <Icon name={it.icon} className="h-5 w-5" /><span className="max-w-full truncate px-0.5">{it.label}</span>
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog"
          className={`group relative flex min-w-0 flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-semibold ${inMenu || open ? "text-brand-600" : "text-ink-soft"}`}>
          <Icon name="grid" className="h-5 w-5" /><span className="max-w-full truncate px-0.5">{menuLabel}</span>
          {all.some((it) => it.step?.next) && <span className="absolute end-[28%] top-1.5 h-2.5 w-2.5 rounded-full bg-accent-500 ring-2 ring-white" />}
        </button>
      </nav>
      {open && <MenuSheet items={all} title={menuLabel} closeLabel={closeLabel} footer={footer} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Alle Seiten als Kacheln, von unten eingeblendet (über die ganze Seite: Portal in <body>, siehe CLAUDE.md) */
function MenuSheet({ items, title, closeLabel, footer, onClose }: { items: NavItem[]; title: string; closeLabel: string; footer?: ReactNode; onClose: () => void }) {
  const path = usePathname();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", esc);
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end bg-navy-900/50 backdrop-blur-sm lg:hidden" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div className="sheet-up max-h-[88vh] w-full overflow-y-auto overscroll-contain rounded-t-3xl bg-white pb-[env(safe-area-inset-bottom)] shadow-lift">
        <div className="sticky top-0 z-10 bg-white/95 px-4 pb-2 pt-2 backdrop-blur">
          <div className="mx-auto mb-2 h-1.5 w-12 rounded-full bg-black/10" />
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold">{title}</h2>
            <button type="button" onClick={onClose} aria-label={closeLabel} className="btn-ghost group h-10 w-10 p-0"><Icon name="x" className="h-5 w-5" /></button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 px-4 pb-4 min-[360px]:grid-cols-4">
          {items.map((it) => {
            const active = isActive(it.href, path);
            return (
              <Link key={it.href} href={it.href} onClick={onClose} aria-current={active ? "page" : undefined}
                className={`group relative flex min-h-[5.5rem] flex-col items-center justify-center gap-1.5 rounded-2xl p-2 text-center text-xs font-semibold leading-tight ring-1 transition active:scale-95 ${active ? "bg-brand-600 text-white shadow-card ring-brand-600" : "bg-brand-50/60 text-ink ring-black/5"}`}>
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${active ? "bg-white/20" : it.highlight ? "bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-card" : "bg-white text-brand-600 shadow-card"}`}>
                  <Icon name={it.icon} className="h-5 w-5" />
                </span>
                <span className="[overflow-wrap:anywhere]">{it.label}</span>
                {it.step && (
                  <span className={`absolute end-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full text-[0.625rem] font-bold ${it.step.next ? "animate-pulse bg-accent-500 text-white" : "bg-white text-brand-700 ring-1 ring-brand-100"}`}>{it.step.n}</span>
                )}
              </Link>
            );
          })}
        </div>
        {footer && <div className="border-t border-black/5 px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
