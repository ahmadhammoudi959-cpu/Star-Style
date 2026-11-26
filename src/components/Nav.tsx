"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

export type NavItem = {
  href: string; label: string; icon: IconName; soon?: boolean; highlight?: boolean;
  /** „Erste Schritte“: Nummer am Menüpunkt; next = der Schritt, der als Nächstes dran ist; title = Tooltip (Nummer + was zu tun ist) */
  step?: { n: number; next: boolean; title?: string };
  /** Zahl am Menüpunkt (z. B. ungelesene E-Mails): API liefert { count } – im Browser geladen, blockiert die Seite nicht */
  badge?: string;
};

/**
 * Nächster Schritt der „Ersten Schritte“ (Wunsch Inhaber 26.11.2026): Pfeil, der hin und her stupst, „Nächster Schritt“ in Worten,
 * und die Zahl wechselt ständig die Farbe Blau → Rot → Blau (.step-blink). So ist sie klar etwas anderes als eine feste rote Zahl
 * „da wartet etwas“ (Online-Bestellungen, ungelesene E-Mails) – vorher sah die rot pulsierende „6“ am Verkauf genau so aus.
 */
function NextStepChip({ n, title, onLight = false, small = false, toward = "start" }: {
  n: number; title?: string; onLight?: boolean; small?: boolean;
  /** wohin der Pfeil zeigt: start = zum Textanfang (Chip steht am Ende der Zeile), end = nach vorn (Chip steht am Anfang) */
  toward?: "start" | "end";
}) {
  const cls = `${small ? "h-3.5 w-3.5" : "h-4 w-4"} ${onLight ? "text-brand-600" : "text-brand-300"}`;
  // LTR: start = links; RTL: start = rechts – je Richtung das passende Symbol (kein Drehen: .icon-pop dreht beim Zeigen selbst)
  const [ltr, rtl] = toward === "start" ? (["arrowLeft", "arrowRight"] as const) : (["arrowRight", "arrowLeft"] as const);
  const arrow = (
    <span aria-hidden className={`${toward === "start" ? "nudge-start" : "nudge-end"} inline-flex`}>
      <Icon name={ltr} className={`${cls} rtl:hidden`} />
      <Icon name={rtl} className={`${cls} ltr:hidden`} />
    </span>
  );
  const num = <span className={`step-blink grid place-items-center rounded-full font-bold text-white ring-2 ${onLight ? "ring-brand-100" : "ring-brand-300/40"} ${small ? "h-5 min-w-[1.25rem] px-1 text-[0.625rem]" : "h-6 min-w-[1.5rem] px-1 text-xs"}`}>{n}</span>;
  return (
    <span title={title} className="flex shrink-0 items-center gap-0.5" data-next-step-chip>
      {toward === "start" ? <>{arrow}{num}</> : <>{num}{arrow}</>}
      {title && <span className="sr-only">{title}</span>}
    </span>
  );
}

/** Zahl am Menüpunkt: lädt nach dem Anzeigen und jede Minute neu (nur wenn die Seite sichtbar ist) */
export function NavBadge({ src, className }: { src: string; className: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    // „event:<Name>“: Zahl kommt als Fenster-Ereignis (z. B. WhatsApp Web im Rahmen, WaDock) statt vom Server
    if (src.startsWith("event:")) {
      const name = src.slice(6);
      const g = window as unknown as { __ssWaUnread?: number };
      if (typeof g.__ssWaUnread === "number") setN(g.__ssWaUnread);
      const on = (e: Event) => { const d = (e as CustomEvent).detail; if (typeof d === "number") setN(d); };
      window.addEventListener(name, on);
      return () => window.removeEventListener(name, on);
    }
    let stop = false;
    const load = () => fetch(src, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => { if (!stop && j && typeof j.count === "number") setN(j.count); }).catch(() => {});
    load();
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    // gleich neu laden, wenn eine Seite etwas als gelesen markiert hat
    const now = () => window.setTimeout(load, 300);
    window.addEventListener("ss:badges", now);
    return () => { stop = true; clearInterval(id); window.removeEventListener("ss:badges", now); };
  }, [src]);
  if (!n) return null;
  return <span className={className}>{n > 99 ? "99+" : n}</span>;
}

/** Aktiv ist der längste passende Eintrag (/settings/users statt /settings) */
function activeHref(items: NavItem[], path: string): string | null {
  let best: string | null = null;
  for (const it of items) {
    const hit = it.href === "/" ? path === "/" : path === it.href || path.startsWith(it.href + "/") || path.startsWith(it.href + "?");
    if (hit && (!best || it.href.length > best.length)) best = it.href;
  }
  return best;
}

export function SideNav({ items, soonLabel, nextLabel }: { items: NavItem[]; soonLabel: string; nextLabel: string }) {
  const path = usePathname();
  const current = activeHref(items, path);
  return (
    <nav className="space-y-1 short:space-y-0.5">
      {items.map((it) => {
        const active = it.href === current;
        const next = Boolean(it.step?.next);
        if (it.soon)
          return (
            <span key={it.href} title={soonLabel} className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-white/40 short:py-1.5 tiny:py-1">
              <Icon name={it.icon} />{it.label}
            </span>
          );
        return (
          <Link key={it.href} href={it.href} data-next-step={next ? "1" : undefined}
            className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition short:py-1.5 tiny:py-1 ${active ? "border-s-4 border-accent-500 bg-white text-brand-700 shadow-card" : next ? "step-row-blink text-white" : "text-white/80 hover:bg-white/10 hover:text-white"}`}>
            <Icon name={it.icon} />
            <span className="min-w-0 flex-1">
              {it.label}
              {/* nächster Schritt: in Worten darunter, damit klar ist, dass es kein Hinweis „da wartet etwas“ ist */}
              {next && <span className={`block text-[0.6875rem] font-bold leading-tight ${active ? "text-brand-600" : "text-brand-300"}`}>{nextLabel}</span>}
            </span>
            {/* rote Zahl = da wartet wirklich etwas (z. B. Online-Bestellungen zum Versenden) */}
            {it.badge && <NavBadge src={it.badge} className="ms-auto min-w-[1.375rem] rounded-full bg-accent-500 px-1.5 text-center text-[0.6875rem] font-bold leading-[1.375rem] text-white" />}
            {it.step && (next
              ? <NextStepChip n={it.step.n} title={it.step.title} onLight={active} />
              : <span title={it.step.title ?? String(it.step.n)} className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${active ? "bg-brand-100 text-brand-700" : "bg-white/15 text-white"}`}>{it.step.n}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}


/**
 * Handy: Leiste unten (Start, Verkauf, Scanner in der Mitte, Lager, „Menü“). „Menü“ öffnet alle Seiten der Seitenleiste
 * als große Kacheln von unten (Wunsch Inhaber 03.11.2026: auf dem Handy alles erreichbar und bequem).
 */
export function BottomNav({ items, all, menuLabel, closeLabel, nextLabel, footer }: {
  items: NavItem[]; all: NavItem[]; menuLabel: string; closeLabel: string; nextLabel: string; footer?: ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  // Seite gewechselt → Menü zu
  useEffect(() => { setOpen(false); }, [path]);
  const current = activeHref(all, path);
  const inMenu = !items.some((it) => it.href === current); // aktuelle Seite liegt nur im Menü
  const cols = items.length + 1;
  // nächster Schritt liegt nur im Menü → blauer Punkt am Knopf „Menü“ (steht er unten in der Leiste, zeigt der Pfeil dort hin)
  const nextInMenu = all.some((it) => it.step?.next) && !items.some((it) => it.step?.next);
  return (
    <>
      <nav className="print:hidden fixed inset-x-0 bottom-0 z-30 grid border-t border-black/5 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-lift backdrop-blur lg:hidden"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {items.map((it) => {
          const active = it.href === current;
          // hervorgehoben (Scanner): runder Knopf, der etwas aus der Leiste ragt
          if (it.highlight) return (
            <Link key={it.href} href={it.href} aria-current={active ? "page" : undefined}
              className="group flex flex-col items-center gap-0.5 pb-2 text-xs font-bold text-brand-700">
              <span className={`-mt-4 grid h-12 w-12 place-items-center rounded-full text-white shadow-lift ring-4 ring-white transition group-active:scale-95 ${active ? "bg-accent-500" : "bg-gradient-to-br from-brand-500 to-brand-700"}`}>
                <Icon name={it.icon} className="h-6 w-6" />
              </span>
              {it.label}
            </Link>
          );
          return (
            <Link key={it.href} href={it.soon ? "#" : it.href} aria-disabled={it.soon} aria-current={active ? "page" : undefined}
              className={`group flex min-w-0 flex-col items-center gap-0.5 py-2 text-xs font-semibold ${active ? "text-brand-600" : it.soon ? "text-ink-soft/40" : "text-ink-soft"}`}>
              <span className="relative">
                <Icon name={it.icon} className="h-5 w-5" />
                {/* Zahl am Symbol (z. B. Online-Bestellungen am „Verkauf“) */}
                {it.badge && <NavBadge src={it.badge} className="absolute -top-1.5 start-3 min-w-[1.125rem] rounded-full bg-accent-500 px-1 text-center text-[0.625rem] font-bold leading-[1.125rem] text-white ring-2 ring-white" />}
                {/* nächster Schritt: blauer Pfeil, der auf das Symbol zeigt (nicht rot – das sind Zahlen, bei denen etwas wartet) */}
                {it.step?.next && (
                  <span aria-hidden title={it.step.title} className="step-blink absolute -top-2.5 start-[-0.85rem] grid h-4 w-4 place-items-center rounded-full text-white ring-2 ring-white motion-safe:animate-bounce" data-next-step-chip>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
                  </span>
                )}
              </span>
              <span className="max-w-full truncate px-0.5">{it.label}</span>
              {it.step?.next && <span className="sr-only">{it.step.title ?? nextLabel}</span>}
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open} aria-haspopup="dialog"
          className={`group relative flex min-w-0 flex-col items-center gap-0.5 py-2 text-xs font-semibold ${inMenu || open ? "text-brand-600" : "text-ink-soft"}`}>
          <Icon name="grid" className="h-5 w-5" /><span className="max-w-full truncate px-0.5">{menuLabel}</span>
          {nextInMenu && <span aria-hidden title={nextLabel} className="step-blink absolute end-[28%] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white motion-safe:animate-bounce" data-next-step-chip />}
        </button>
      </nav>
      {open && <MenuSheet items={all} title={menuLabel} closeLabel={closeLabel} nextLabel={nextLabel} footer={footer} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Alle Seiten als Kacheln, von unten eingeblendet (über die ganze Seite: Portal in <body>, siehe CLAUDE.md) */
function MenuSheet({ items, title, closeLabel, nextLabel, footer, onClose }: { items: NavItem[]; title: string; closeLabel: string; nextLabel: string; footer?: ReactNode; onClose: () => void }) {
  const path = usePathname();
  const current = activeHref(items, path);
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
            const active = it.href === current;
            const next = Boolean(it.step?.next);
            return (
              <Link key={it.href} href={it.href} onClick={onClose} aria-current={active ? "page" : undefined} data-next-step={next ? "1" : undefined}
                className={`group relative flex min-h-[5.5rem] flex-col items-center justify-center gap-1.5 rounded-2xl p-2 text-center text-xs font-semibold leading-tight ring-1 transition active:scale-95 ${active ? "bg-brand-600 text-white shadow-card ring-brand-600" : next ? "step-ring-blink bg-brand-50 text-ink" : "bg-brand-50/60 text-ink ring-black/5"}`}>
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${active ? "bg-white/20" : it.highlight ? "bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-card" : "bg-white text-brand-600 shadow-card"}`}>
                  <Icon name={it.icon} className="h-5 w-5" />
                </span>
                <span className="[overflow-wrap:anywhere]">{it.label}</span>
                {next && <span className={`-mt-1 text-[0.625rem] font-bold ${active ? "text-white/90" : "text-brand-600"}`}>{nextLabel}</span>}
                {/* Zahl oben in der Ecke (rot) = da wartet etwas; nächster Schritt steht dann in der anderen Ecke */}
                {it.badge && <NavBadge src={it.badge} className="absolute end-1.5 top-1.5 min-w-[1.25rem] rounded-full bg-accent-500 px-1 text-center text-[0.625rem] font-bold leading-5 text-white" />}
                {it.step && (next
                  ? <span className={`absolute top-1.5 ${it.badge ? "start-1.5" : "end-1.5"}`}><NextStepChip n={it.step.n} title={it.step.title} onLight={!active} small toward={it.badge ? "end" : "start"} /></span>
                  : <span title={it.step.title} className="absolute end-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-white text-[0.625rem] font-bold text-brand-700 ring-1 ring-brand-100">{it.step.n}</span>
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
