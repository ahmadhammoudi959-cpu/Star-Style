import { requireSession } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { BottomNav, SideNav, type NavItem } from "@/components/Nav";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Icon } from "@/components/Icon";
import { logout } from "@/app/actions-auth";
import { setupSteps } from "@/lib/onboarding";
import { Suspense } from "react";
import Link from "next/link";
import { NavProgress } from "@/components/NavProgress";
import { liveStatus } from "@/lib/test-reset";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const { t, locale, intl } = await getI18n();
  // Zeichen „Testbetrieb“ / „Echtbetrieb seit …“ (Wunsch Inhaber 04.11.2026): ab dem Zurücksetzen sind alle Daten echt
  const live = await liveStatus();
  const liveText = live.live ? (live.since ? t.reset.badgeLive.replace("{date}", formatDate(live.since.toISOString(), intl)) : t.reset.badgeLiveShort) : t.reset.badgeTest;
  const liveHref = live.live ? "/settings#live" : "/settings#reset";
  const liveTip = live.live ? liveText : t.reset.badgeTestHint;
  const items: NavItem[] = [
    { href: "/", label: t.nav.home, icon: "home" },
    { href: "/sales", label: t.nav.sales, icon: "cart" },
    { href: "/receivables", label: t.nav.receivables, icon: "euro" },
    { href: "/customers", label: t.nav.customers, icon: "users" },
    { href: "/products", label: t.nav.products, icon: "box" },
    { href: "/categories", label: t.nav.categories, icon: "tag" },
    { href: "/receive", label: t.nav.receive, icon: "truck" },
    { href: "/stock", label: t.nav.stock, icon: "layers" },
    { href: "/scan", label: t.nav.scan, icon: "scan" },
    { href: "/write-offs", label: t.nav.writeOffs, icon: "alert" },
    { href: "/expenses", label: t.nav.expenses, icon: "receipt" },
    { href: "/reports", label: t.nav.reports, icon: "chart" },
    { href: "/insights", label: t.nav.insights, icon: "bulb" },
    { href: "/ask", label: t.nav.ask, icon: "spark" },
    { href: "/shops", label: t.nav.shops, icon: "globe" },
    { href: "/suppliers", label: t.nav.suppliers, icon: "truck" },
    { href: "/settings", label: t.nav.settings, icon: "settings" },
  ];
  // Nummern der ersten Schritte am Menü, solange noch nicht alles erledigt ist
  const setup = await setupSteps();
  if (!setup.allDone) for (const s of setup.steps) {
    const it = items.find((i) => i.href === s.nav);
    if (it && (!s.done || setup.showGuide)) it.step = { n: s.n, next: s.key === setup.next };
  }
  // Handy unten: Start, Verkauf, Scanner (hervorgehoben, Mitte), Lager, „Menü“ = alle Seiten der Seitenleiste
  const pick = (href: string) => items.find((i) => i.href === href)!;
  const mobile: NavItem[] = [pick("/"), pick("/sales"), { ...pick("/scan"), label: t.nav.scanShort, highlight: true }, pick("/stock")];
  const menuFooter = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 truncate text-sm font-semibold text-ink-soft" dir="auto">{session.name}</div>
      <div className="flex items-center gap-2">
        <LanguageSwitcher current={locale} />
        <form action={logout}><button className="btn-ghost group gap-2 px-3"><Icon name="logout" className="h-4 w-4" />{t.common.logout}</button></form>
      </div>
    </div>
  );
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15.625rem_1fr]">
      <Suspense fallback={null}><NavProgress /></Suspense>
      {/* Seitenleiste immer genau Bildschirmhöhe: passt das Menü nicht (Laptop), scrollt es innen – der dunkle Hintergrund bleibt überall */}
      <aside className="scroll-slim sticky top-0 hidden h-screen print:!hidden flex-col justify-between gap-4 overflow-y-auto overscroll-contain bg-gradient-to-b from-navy-800 to-navy-900 p-4 text-white lg:flex short:py-3">
        <div>
          <div className="mb-6 px-2 short:mb-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-light.png" alt={t.app.name} className="h-auto w-44 transition duration-300 hover:scale-[1.03] short:w-36" />
            <div className="mt-2 h-0.5 w-full rounded-full bg-gradient-to-r from-brand-500 via-white/20 to-accent-500" />
            <div className="mt-2 text-xs text-white/60 short:hidden">{t.app.tagline}</div>
            <Link href={liveHref} title={liveTip} data-live={live.live ? "1" : "0"}
              className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-bold ring-1 transition hover:scale-[1.03] ${live.live ? "bg-emerald-400/15 text-emerald-200 ring-emerald-300/30" : "bg-amber-300/15 text-amber-200 ring-amber-300/40"}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${live.live ? "bg-emerald-400" : "animate-pulse bg-amber-400"}`} />{liveText}
            </Link>
          </div>
          <SideNav items={items} soonLabel={t.home.comingSoon} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-1 pt-3">
          <div className="min-w-0 truncate text-xs text-white/70" dir="auto">{session.name}</div>
          <form action={logout} className="shrink-0">
            <button className="group flex items-center gap-2 whitespace-nowrap rounded-xl px-2 py-1.5 text-sm text-white/85 hover:bg-white/10"><Icon name="logout" />{t.common.logout}</button>
          </form>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="print:hidden sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-black/5 bg-[#f4f6fa]/90 px-4 py-3 backdrop-blur lg:px-8">
          <div className="flex items-center gap-2 font-bold lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo.png" alt={t.app.name} className="h-8 w-auto" />
            <Link href={liveHref} title={liveTip}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-bold ring-1 ${live.live ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live.live ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />{live.live ? t.reset.badgeLiveShort : t.reset.badgeTest}
            </Link>
          </div>
          <div className="hidden lg:block" />
          <div className="flex items-center gap-2">
            <LanguageSwitcher current={locale} />
            <form action={logout} className="lg:hidden"><button aria-label={t.common.logout} className="btn-ghost px-3"><Icon name="logout" /></button></form>
          </div>
        </header>
        {/* alle Seiten breit (Wunsch Inhaber 04.11.2026: große Bildschirme nutzen); Belege/Drucke begrenzen sich selbst (max-w-3xl) */}
        <main className="mx-auto max-w-[96rem] px-4 pb-28 pt-6 lg:px-8 lg:pb-12">{children}</main>
      </div>
      <BottomNav items={mobile} all={items.map((it) => (it.href === "/scan" ? { ...it, highlight: true } : it))} menuLabel={t.nav.menu} closeLabel={t.common.close} footer={menuFooter} />
    </div>
  );
}
