"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

export type NavItem = { href: string; label: string; icon: IconName; soon?: boolean };

export function SideNav({ items, soonLabel }: { items: NavItem[]; soonLabel: string }) {
  const path = usePathname();
  return (
    <nav className="space-y-1">
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        if (it.soon)
          return (
            <span key={it.href} title={soonLabel} className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-white/40">
              <Icon name={it.icon} />{it.label}
            </span>
          );
        return (
          <Link key={it.href} href={it.href}
            className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${active ? "bg-white text-brand-700 shadow-card" : "text-white/85 hover:bg-white/10 hover:text-white"}`}>
            <Icon name={it.icon} />{it.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function BottomNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav className="print:hidden fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-black/5 bg-white/95 pb-[env(safe-area-inset-bottom)] shadow-lift backdrop-blur lg:hidden">
      {items.map((it) => {
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.soon ? "#" : it.href} aria-disabled={it.soon}
            className={`group flex flex-col items-center gap-0.5 py-2 text-[0.6875rem] font-semibold ${active ? "text-brand-600" : it.soon ? "text-ink-soft/40" : "text-ink-soft"}`}>
            <Icon name={it.icon} className="h-5 w-5" />{it.label}
          </Link>
        );
      })}
    </nav>
  );
}
