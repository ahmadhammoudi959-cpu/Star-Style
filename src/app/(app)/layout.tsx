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
    <div className="min-h-screen lg:grid lg:grid-cols-[250px_1fr]">
      <aside className="sticky top-0 hidden h-screen print:!hidden flex-col justify-between bg-gradient-to-b from-brand-700 to-brand-900 p-4 text-white lg:flex">
        <div>
          <div className="mb-6 flex items-center gap-3 px-2">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-white/15 text-lg font-bold shadow-card">S</div>
            <div>
              <div className="font-bold leading-tight">{t.app.name}</div>
              <div className="text-xs text-white/70">{t.app.tagline}</div>
            </div>
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
        <header className="print:hidden sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-black/5 bg-[#f4f6f5]/90 px-4 py-3 backdrop-blur lg:px-8">
          <div className="flex items-center gap-2 font-bold lg:hidden">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm text-white">S</div>{t.app.name}
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
