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
import { canOpen } from "@/lib/permissions";
import { WaDock } from "@/components/WaDock";
import { can } from "@/lib/auth";
import { WA_EXT_READONLY_VERSION } from "@/lib/wa-extension";
import { AgentDock } from "@/components/agent/AgentDock";
import { aiConfigured } from "@/lib/ai/client";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const { t, locale, intl } = await getI18n();
  // Zeichen „Testbetrieb“ / „Echtbetrieb seit …“ (Wunsch Inhaber 04.11.2026): ab dem Zurücksetzen sind alle Daten echt
  const live = await liveStatus();
  const liveText = live.live ? (live.since ? t.reset.badgeLive.replace("{date}", formatDate(live.since.toISOString(), intl)) : t.reset.badgeLiveShort) : t.reset.badgeTest;
  const liveHref = session.admin ? (live.live ? "/settings#live" : "/settings#reset") : null; // nur der Admin kann dort etwas tun
  const liveTip = live.live ? liveText : t.reset.badgeTestHint;
  const allItems: NavItem[] = [
    { href: "/", label: t.nav.home, icon: "home" },
    // rote Zahl = Online-Bestellungen, die noch verschickt/abgeholt werden müssen (Wunsch Inhaber 19.11.2026, wie WhatsApp/E-Mail)
    { href: "/sales", label: t.nav.sales, icon: "cart", badge: can(session, "sales.shipping") ? "/api/sales/waiting" : undefined },
    // Direktverkauf (Wunsch Inhaber 19.11.2026): Listen vom Bestell-Link – Zahl der neuen
    { href: "/direct", label: t.nav.direct, icon: "list", badge: "/api/direct/unread" },
    { href: "/returns", label: t.nav.returns, icon: "undo" },
    { href: "/receivables", label: t.nav.receivables, icon: "euro" },
    { href: "/customers", label: t.nav.customers, icon: "users" },
    { href: "/whatsapp", label: t.nav.whatsapp, icon: "chat", badge: "event:ss:wa-unread" }, // Zahl aus WhatsApp Web (WaDock)
    { href: "/mail", label: t.nav.mail, icon: "inbox", badge: "/api/mail/unread" },
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
    { href: "/design", label: t.nav.design, icon: "palette" },
    { href: "/settings/users", label: t.nav.users, icon: "users" },
    { href: "/settings", label: t.nav.settings, icon: "settings" },
    { href: "/account", label: t.nav.account, icon: "key" },
  ];
  // Menü je nach Rechten (Wunsch Inhaber 12.11.2026): nur Seiten, die diese Person öffnen darf
  const items = allItems.filter((it) => canOpen(session, it.href));
  // Nummern der ersten Schritte am Menü (nur Admin), solange noch nicht alles erledigt ist
  const setup = session.admin ? await setupSteps() : null;
  if (setup && !setup.allDone) for (const s of setup.steps) {
    const it = items.find((i) => i.href === s.nav);
    if (it && (!s.done || setup.showGuide)) it.step = { n: s.n, next: s.key === setup.next };
  }
  // Handy unten: Start, Verkauf, Scanner (hervorgehoben, Mitte), Lager, „Menü“ = alle Seiten der Seitenleiste
  const pick = (href: string) => items.find((i) => i.href === href);
  const scan = pick("/scan");
  const mobile = [pick("/"), pick("/sales"), scan && { ...scan, label: t.nav.scanShort, highlight: true }, pick("/stock")].filter((x): x is NavItem => !!x);
  const menuFooter = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0 truncate text-sm font-semibold text-ink-soft" dir="auto">{session.name}</div>
      <div className="flex items-center gap-2">
        <LanguageSwitcher current={locale} />
        <form action={logout} data-ai-block><button className="btn-ghost group gap-2 px-3"><Icon name="logout" className="h-4 w-4" />{t.common.logout}</button></form>
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
            <MaybeLink href={liveHref} title={liveTip} data-live={live.live ? "1" : "0"}
              className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] font-bold ring-1 transition hover:scale-[1.03] ${live.live ? "bg-emerald-400/15 text-emerald-200 ring-emerald-300/30" : "bg-amber-300/15 text-amber-200 ring-amber-300/40"}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${live.live ? "bg-emerald-400" : "animate-pulse bg-amber-400"}`} />{liveText}
            </MaybeLink>
          </div>
          <SideNav items={items} soonLabel={t.home.comingSoon} />
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-1 pt-3">
          <div className="min-w-0 truncate text-xs text-white/70" dir="auto">{session.name}</div>
          <form action={logout} className="shrink-0" data-ai-block>
            <button className="group flex items-center gap-2 whitespace-nowrap rounded-xl px-2 py-1.5 text-sm text-white/85 hover:bg-white/10"><Icon name="logout" />{t.common.logout}</button>
          </form>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="print:hidden sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-black/5 bg-[#f4f6fa]/90 px-4 py-3 backdrop-blur lg:px-8">
          <div className="flex items-center gap-2 font-bold lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo.png" alt={t.app.name} className="h-8 w-auto" />
            <MaybeLink href={liveHref} title={liveTip}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-bold ring-1 ${live.live ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-amber-50 text-amber-800 ring-amber-200"}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live.live ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />{live.live ? t.reset.badgeLiveShort : t.reset.badgeTest}
            </MaybeLink>
          </div>
          <div className="hidden lg:block" />
          <div className="flex items-center gap-2">
            <LanguageSwitcher current={locale} />
            <form action={logout} className="lg:hidden" data-ai-block><button aria-label={t.common.logout} className="btn-ghost px-3"><Icon name="logout" /></button></form>
          </div>
        </header>
        {/* alle Seiten breit (Wunsch Inhaber 04.11.2026: große Bildschirme nutzen); Belege/Drucke begrenzen sich selbst (max-w-3xl) */}
        <main className="mx-auto max-w-[96rem] px-4 pb-28 pt-6 lg:px-8 lg:pb-12">
          {children}
          {/* WhatsApp Web bleibt beim Seitenwechsel offen, sichtbar nur auf /whatsapp (Wunsch Inhaber 16.11.2026) */}
          {canOpen(session, "/whatsapp") && <Suspense fallback={null}><WaDock t={t.waWeb} canSend={can(session, "whatsapp.send")} minReadOnlyVersion={WA_EXT_READONLY_VERSION} /></Suspense>}
        </main>
        {/* Assistent „Star Style“ (Wunsch Inhaber 17.11.2026): bedient das System sichtbar für den Nutzer, mit seinen Rechten */}
        {aiConfigured() && can(session, "assistant") && <AgentDock t={t.agent} locale={locale} />}
      </div>
      <BottomNav items={mobile} all={items.map((it) => (it.href === "/scan" ? { ...it, highlight: true } : it))} menuLabel={t.nav.menu} closeLabel={t.common.close} footer={menuFooter} />
    </div>
  );
}

/** Link nur, wenn es ein Ziel gibt (Mitarbeiter sehen das Zeichen ohne Link) */
function MaybeLink({ href, children, ...rest }: { href: string | null; children: React.ReactNode; title?: string; className?: string; "data-live"?: string }) {
  return href ? <Link href={href} {...rest}>{children}</Link> : <span {...rest}>{children}</span>;
}
