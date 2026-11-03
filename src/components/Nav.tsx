"use client";
import Link from "next/link";
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

export function BottomNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="print:hidden fixed inset-x-0 bottom-0 z-30 grid border-t border-black/5 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-lift backdrop-blur lg:hidden"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
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
          <Link key={it.href} href={it.soon ? "#" : it.href} aria-disabled={it.soon}
            className={`group flex min-w-0 flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-semibold ${active ? "text-brand-600" : it.soon ? "text-ink-soft/40" : "text-ink-soft"}`}>
            <Icon name={it.icon} className="h-5 w-5" /><span className="max-w-full truncate px-0.5">{it.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
