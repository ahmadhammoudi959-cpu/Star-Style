import { requireSession } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { BottomNav, SideNav, type NavItem } from "@/components/Nav";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { Icon } from "@/components/Icon";
import { logout } from "@/app/actions-auth";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const items: NavItem[] = [
    { href: "/", label: t.nav.home, icon: "home" },
    { href: "/sales", label: t.nav.sales, icon: "cart" },
    { href: "/receivables", label: t.nav.receivables, icon: "euro" },
    { href: "/customers", label: t.nav.customers, icon: "users" },
    { href: "/products", label: t.nav.products, icon: "box" },
    { href: "/receive", label: t.nav.receive, icon: "truck" },
    { href: "/stock", label: t.nav.stock, icon: "layers" },
    { href: "/write-offs", label: t.nav.writeOffs, icon: "alert" },
    { href: "/expenses", label: t.nav.expenses, icon: "receipt" },
    { href: "/reports", label: t.nav.reports, icon: "chart" },
    { href: "/insights", label: t.nav.insights, icon: "bulb" },
    { href: "/ask", label: t.nav.ask, icon: "spark" },
    { href: "/shops", label: t.nav.shops, icon: "globe" },
    { href: "/suppliers", label: t.nav.suppliers, icon: "truck" },
    { href: "/settings", label: t.nav.settings, icon: "settings" },
  ];
  const mobile = [items[0], items[1], items[2], items[8], items[6]];
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15.625rem_1fr]">
      <aside className="sticky top-0 hidden h-screen print:!hidden flex-col justify-between bg-gradient-to-b from-navy-800 to-navy-900 p-4 text-white lg:flex">
        <div>
          <div className="mb-6 px-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo-light.png" alt={t.app.name} className="h-auto w-44 transition duration-300 hover:scale-[1.03]" />
            <div className="mt-2 h-0.5 w-full rounded-full bg-gradient-to-r from-brand-500 via-white/20 to-accent-500" />
            <div className="mt-2 text-xs text-white/60">{t.app.tagline}</div>
          </div>
          <SideNav items={items} soonLabel={t.home.comingSoon} />
        </div>
        <div className="space-y-2 px-1">
          <div className="text-xs text-white/70">{session.name}</div>
          <form action={logout}>
            <button className="group flex w-full items-center gap-2 rounded-xl px-2 py-2 text-sm text-white/85 hover:bg-white/10"><Icon name="logout" />{t.common.logout}</button>
          </form>
        </div>
      </aside>
      <div className="min-w-0">
        <header className="print:hidden sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-black/5 bg-[#f4f6fa]/90 px-4 py-3 backdrop-blur lg:px-8">
          <div className="flex items-center gap-2 font-bold lg:hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo.png" alt={t.app.name} className="h-8 w-auto" />
          </div>
          <div className="hidden lg:block" />
          <div className="flex items-center gap-2">
            <LanguageSwitcher current={locale} />
            <form action={logout} className="lg:hidden"><button aria-label={t.common.logout} className="btn-ghost px-3"><Icon name="logout" /></button></form>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-28 pt-6 lg:px-8 lg:pb-12">{children}</main>
      </div>
      <BottomNav items={mobile} />
    </div>
  );
}
