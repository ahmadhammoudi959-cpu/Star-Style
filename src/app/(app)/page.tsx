import Link from "next/link";
import { can, requireSession } from "@/lib/auth";
import { canOpen, type Perm } from "@/lib/permissions";
import { getI18n } from "@/i18n";
import { Icon, type IconName } from "@/components/Icon";
import { alerts, dashboardStats } from "@/lib/queries";
import { openItems } from "@/lib/receivables";
import { loadInsights } from "@/lib/insights-data";
import { aiConfigured } from "@/lib/ai/client";
import { formatCents } from "@/lib/money";
import { daysBetween, formatDate, formatDateTime, todayIso } from "@/lib/dates";
import { EXPIRY_BADGE, expiryState } from "@/lib/expiry";
import { shopOrdersToPickUp, shopOrdersToShip } from "@/lib/shipments";
import { failuresSincePrevious } from "@/lib/login";
import { setupSteps } from "@/lib/onboarding";
import { fill } from "@/i18n";
import { pendingSummary } from "@/lib/shopify/product-push";
import { recentBackups } from "@/lib/backup-info";
import { NavBadge } from "@/components/Nav";
import { newShopCustomersCount } from "@/lib/shopify/customers";
import { newDirectCount } from "@/lib/direct";
import { runningPromotions } from "@/lib/promotions";

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const session = await requireSession();
  const { t, intl } = await getI18n();
  const { denied } = await searchParams;
  const today = todayIso();
  // Startseite je nach Rechten (Wunsch Inhaber 12.11.2026): nur was die Person öffnen darf, Geld-Zahlen nur mit „dashboard.money“
  const may = (p: Perm) => can(session, p);
  const opens = (href: string) => canOpen(session, href);
  const money = may("dashboard.money"), seeStock = may("products.view");
  const [stats, al, open, ins, setup, pend, fails, toShip, backups, newShop, toPickUp, directNew, promos] = await Promise.all([
    seeStock || money ? dashboardStats(today) : null,
    seeStock ? alerts(today) : { low: [], expiring: [] },
    money ? openItems() : [],
    may("insights") ? loadInsights() : null,
    session.admin ? setupSteps() : null,
    may("shops.manage") ? pendingSummary() : [],
    failuresSincePrevious(session.uid, session.admin),
    may("sales.shipping") ? shopOrdersToShip() : [],
    opens("/backup") ? recentBackups(1) : [],
    opens("/customers") ? newShopCustomersCount().catch(() => 0) : 0,
    may("sales.shipping") ? shopOrdersToPickUp() : [],
    may("direct") ? newDirectCount().catch(() => 0) : 0,
    // Aktionen (Wunsch Inhaber 19.11.2026: „على الداشبورد برضه يظهر الخصم“): wer verkauft oder Artikel sieht, soll es wissen
    may("promotions") || may("sales.offers") || may("sales.invoices") || seeStock ? runningPromotions().catch(() => []) : [],
  ]);
  const ai = aiConfigured() && may("ask");
  const debts = open.filter((r) => r.state.openCents > 0);
  const rOpen = debts.reduce((s, r) => s + r.state.openCents, 0);
  const rOverdue = debts.reduce((s, r) => s + r.state.overdueCents, 0);
  const rSoon = debts.filter((r) => r.light === "yellow").reduce((s, r) => s + r.state.nextDueCents, 0);
  const lateList = opensSales(session) ? debts.filter((r) => r.light === "red").slice(0, 5) : [];

  // Datensicherung (nur Admin, Wunsch Inhaber 12.11.2026: „باك اب يومي“ als Kachel wie Scanner/Verkaufen): gelb, solange heute noch keine
  const berlinDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(iso));
  const backupToday = backups[0] && berlinDay(backups[0].at) === today ? backups[0].at : null;
  const backupHint = backupToday
    ? fill(t.home.backupLast, { d: new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(new Date(backupToday)) })
    : t.home.backupNone;
  const allActions: { href: string; label: string; hint: string; icon: IconName; tone: string; soon?: boolean; warn?: boolean; badge?: string }[] = [
    { href: "/scan", label: t.home.scan, hint: t.home.scanHint, icon: "scan", tone: "from-teal-500 to-emerald-700" },
    { href: "/sales/invoices/new", label: t.home.sell, hint: t.home.sellHint, icon: "cart", tone: "from-brand-500 to-brand-700" },
    // Kommunikation (Wunsch Inhaber 16.11.2026): Zahl der ungelesenen lädt der Browser nach (blockiert die Startseite nicht)
    { href: "/whatsapp", label: t.home.whatsapp, hint: t.home.whatsappHint, icon: "chat", tone: "from-emerald-500 to-green-700", badge: "event:ss:wa-unread" },
    { href: "/mail", label: t.home.mail, hint: t.home.mailHint, icon: "inbox", tone: "from-indigo-500 to-blue-700", badge: "/api/mail/unread" },
    { href: "/receive", label: t.home.receive, hint: t.home.receiveHint, icon: "truck", tone: "from-sky-500 to-sky-700" },
    { href: "/expenses/new", label: t.home.expense, hint: t.home.expenseHint, icon: "receipt", tone: "from-rose-500 to-pink-700" },
    { href: "/write-offs", label: t.home.loss, hint: t.home.lossHint, icon: "alert", tone: "from-amber-500 to-orange-600" },
    { href: "/reports", label: t.home.reports, hint: t.home.reportsHint, icon: "chart", tone: "from-violet-500 to-indigo-700" },
    { href: "/backup", label: t.home.backup, hint: backupHint, icon: "download", tone: "from-slate-500 to-navy-800", warn: !backupToday },
  ];
  const actions = allActions.filter((a) => opens(a.href));
  const showAlerts = (money && lateList.length > 0) || seeStock;

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <h1 className="text-3xl font-bold tracking-tight">{t.home.greeting}, {session.name.split(" ")[0]}</h1>
        <p className="text-ink-soft">{t.home.subtitle}</p>
      </div>

      {denied === "1" && (
        <p role="alert" className="flex animate-rise items-start gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
          <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />{t.home.denied}
        </p>
      )}

      {fails.n > 0 && (
        <Link href="/account" className="group card flex animate-rise flex-wrap items-center justify-between gap-3 p-4 ring-1 ring-amber-200 hover:shadow-lift">
          <span className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700"><Icon name="shield" className="icon-pop h-5 w-5" /></span>
            <span className="text-sm font-semibold text-amber-900">{fill(fails.n === 1 ? t.security.alertOne : t.security.alert, { n: fails.n, time: formatDateTime(fails.last, intl) })}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-bold text-brand-700">{t.security.alertLink}<Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></span>
        </Link>
      )}

      {/* Online-Bestellungen, die noch verschickt werden müssen (Wunsch Inhaber 12.11.2026: alles im System, nie im Shopify-Admin) */}
      {toShip.length > 0 && (
        <Link href="/sales?ship=open" className="group card flex animate-rise flex-wrap items-center justify-between gap-3 p-4 ring-2 ring-brand-500/25 hover:shadow-lift">
          <span className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="truck" className="icon-pop h-5 w-5" /></span>
            <span className="font-bold">{toShip.length === 1 ? t.home.toShipOne : fill(t.home.toShip, { n: toShip.length })}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-bold text-brand-700">{t.home.toShipAction}<Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></span>
        </Link>
      )}
      {/* Online-Bestellungen zur Abholung im Lager (Shopify „Abholung im Geschäft“) */}
      {toPickUp.length > 0 && (
        <Link href="/sales?ship=pickup" className="group card flex animate-rise flex-wrap items-center justify-between gap-3 p-4 ring-2 ring-brand-500/25 hover:shadow-lift">
          <span className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="box" className="icon-pop h-5 w-5" /></span>
            <span className="font-bold">{toPickUp.length === 1 ? t.home.toPickUpOne : fill(t.home.toPickUp, { n: toPickUp.length })}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-bold text-brand-700">{t.home.toPickUpAction}<Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></span>
        </Link>
      )}

      {/* laufende bzw. geplante Aktionen */}
      {promos.map((p) => {
        const name = p.title || fill(t.promo.name, { n: p.number });
        const running = p.state.price === "active" || p.state.banner === "active";
        const text = running
          ? fill(t.promo.homeRunning, { name, p: Math.round(p.discountBp / 100), n: p.items }) + (p.state.price === "active" && p.priceUntil ? fill(t.promo.homeUntil, { d: formatDate(p.priceUntil, intl) }) : "")
          : fill(t.promo.homeScheduled, { name, d: formatDate(p.priceFrom, intl) });
        const body = (
          <span className="flex items-center gap-3">
            <span className="num grid h-10 min-w-10 shrink-0 place-items-center rounded-xl bg-accent-600 px-1.5 text-sm font-black text-white" dir="ltr">−{Math.round(p.discountBp / 100)}%</span>
            <span className="font-bold" dir="auto">{text}</span>
          </span>
        );
        return opens("/promotions") ? (
          <Link key={p.id} href={`/promotions/${p.id}`} className="group card flex animate-rise flex-wrap items-center justify-between gap-3 p-4 ring-2 ring-accent-500/25 hover:shadow-lift" data-home-promo>
            {body}<Icon name="arrowRight" className="h-4 w-4 text-brand-700 rtl:rotate-180" />
          </Link>
        ) : <div key={p.id} className="card flex animate-rise items-center gap-3 p-4 ring-2 ring-accent-500/25" data-home-promo>{body}</div>;
      })}

      {/* Listen vom Bestell-Link (Direktverkauf), aus denen noch kein Angebot / keine Rechnung wurde */}
      {directNew > 0 && (
        <Link href="/direct?state=new" className="group card flex animate-rise flex-wrap items-center justify-between gap-3 p-4 ring-2 ring-accent-500/25 hover:shadow-lift">
          <span className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600"><Icon name="list" className="icon-pop h-5 w-5" /></span>
            <span className="font-bold">{directNew === 1 ? t.direct.homeNewOne : fill(t.direct.homeNew, { n: directNew })}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-bold text-brand-700">{t.direct.homeAction}<Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></span>
        </Link>
      )}

      {/* neue Kunden aus den Shops – Konto angelegt oder bestellt, auch unbezahlt (Wunsch Inhaber 13.11.2026) */}
      {newShop > 0 && (
        <Link href="/customers?src=new" className="group card flex animate-rise flex-wrap items-center justify-between gap-3 p-4 ring-1 ring-emerald-200 hover:shadow-lift">
          <span className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Icon name="users" className="icon-pop h-5 w-5" /></span>
            <span className="font-bold">{newShop === 1 ? t.home.newShopCustomerOne : fill(t.home.newShopCustomers, { n: newShop })}</span>
          </span>
          <span className="inline-flex items-center gap-1 text-sm font-bold text-brand-700">{t.home.newShopCustomersAction}<Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></span>
        </Link>
      )}

      {setup && !setup.allDone && (
        <section className="card animate-rise overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/5 bg-gradient-to-l from-brand-50 to-white p-5">
            <div>
              <h2 className="text-lg font-bold">{t.setup1.title}</h2>
              <p className="text-sm text-ink-soft">{t.setup1.intro}</p>
            </div>
            <div className="min-w-[10rem]">
              <div className="mb-1 text-end text-sm font-bold text-brand-700">{fill(t.setup1.progress, { d: setup.doneCount, n: setup.steps.length })}</div>
              <div className="h-2 overflow-hidden rounded-full bg-brand-100"><div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500 transition-all" style={{ width: `${(setup.doneCount / setup.steps.length) * 100}%` }} /></div>
            </div>
          </div>
          <ol className="grid grid-cols-2 gap-2 p-3 sm:p-4 xl:grid-cols-4">
            {setup.steps.map((s) => {
              const isNext = s.key === setup.next;
              const k = s.key as keyof typeof t.setup1;
              return (
                <li key={s.key}>
                  <Link href={s.href} className={`group flex h-full items-start gap-2 rounded-xl p-2.5 ring-1 transition sm:gap-3 sm:p-3 hover:-translate-y-0.5 hover:shadow-card ${s.done ? "bg-emerald-50/60 ring-emerald-100" : isNext ? "bg-white ring-2 ring-accent-500 shadow-card" : "bg-white ring-black/5"}`}>
                    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold sm:h-9 sm:w-9 sm:text-base ${s.done ? "bg-emerald-500 text-white" : isNext ? "bg-accent-500 text-white animate-pulse" : "bg-brand-50 text-brand-700"}`}>
                      {s.done ? <Icon name="check" className="h-5 w-5" /> : s.n}
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-sm font-bold leading-snug sm:text-base ${s.done ? "text-emerald-800 line-through decoration-emerald-300" : ""}`}>{t.setup1[k]}</span>
                      <span className="hidden text-xs text-ink-soft sm:block">{t.setup1[(s.key + "Hint") as keyof typeof t.setup1]}</span>
                      {isNext && <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-accent-600">{t.setup1.start} <Icon name="arrowRight" className="h-3.5 w-3.5 rtl:rotate-180" /></span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {/* Artikel, die in einem angehakten Shop noch fehlen (Wunsch Inhaber: Erinnerung + Hochladen nur nach Rückfrage) */}
      {pend.length > 0 && (
        <section className="card animate-rise overflow-hidden ring-2 ring-accent-500/25">
          <div className="flex items-center gap-3 border-b border-black/5 bg-gradient-to-l from-accent-50 to-white px-5 py-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600"><Icon name="upload" className="icon-pop h-5 w-5" /></div>
            <h2 className="font-bold">{t.home.pendingTitle}</h2>
          </div>
          <ul className="divide-y divide-black/5">
            {pend.map((x) => (
              <li key={x.channel} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm">{fill(t.home.pendingText, { shop: t.shop.names[x.channel], n: x.total, r: x.ready })}</span>
                <Link href={`/shops/${x.channel}#pending`} className="btn-primary group shrink-0">{t.home.pendingAction}<Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Handy: Kacheln nebeneinander zum Wischen (Wunsch Inhaber 04.11.2026), ab Tablet als Raster */}
      <div className={`stagger swipe-row -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0 ${actions.length > 8 ? "sm:grid-cols-3 lg:grid-cols-5" : actions.length === 8 ? "sm:grid-cols-4 2xl:grid-cols-8" : actions.length === 7 ? "sm:grid-cols-4 xl:grid-cols-7" : "sm:grid-cols-3 lg:grid-cols-6"}`}>
        {actions.map((a) => {
          const inner = (
            <>
              <div className={`mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br ${a.tone} text-white shadow-lift sm:mb-4 sm:h-14 sm:w-14`}>
                <Icon name={a.icon} className="h-6 w-6 sm:h-7 sm:w-7" />
              </div>
              {a.badge && <NavBadge src={a.badge} className="absolute end-3 top-3 min-w-[1.5rem] rounded-full bg-accent-500 px-1.5 text-center text-xs font-bold leading-6 text-white shadow-card" />}
              <div className="font-bold sm:text-lg">{a.label}</div>
              <div className={`text-xs sm:text-sm ${a.warn ? "font-semibold text-amber-700" : "text-ink-soft"}`}>{a.soon ? t.home.comingSoon : a.hint}</div>
            </>
          );
          const box = `card group relative w-[38%] shrink-0 snap-start p-4 sm:w-auto sm:p-5${a.warn ? " ring-2 ring-amber-300" : ""}`;
          return a.soon ? (
            <div key={a.href} className={`${box} opacity-60`}>{inner}</div>
          ) : (
            <Link key={a.href} href={a.href} className={`${box} card-hover`}>{inner}</Link>
          );
        })}
      </div>

      {money && (
        <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
          <Kpi icon="euro" label={t.pay.kpiOpen} value={formatCents(rOpen, intl)} sub={`${debts.length} ${t.pay.openInvoices}`} href={opens("/receivables") ? "/receivables" : undefined} wide />
          <Kpi icon="alert" label={t.pay.totalOverdue} value={formatCents(rOverdue, intl)} tone={rOverdue ? "text-red-600" : undefined} href={opens("/receivables") ? "/receivables?f=red" : undefined} />
          <Kpi icon="clock" label={t.pay.dueSoon} value={formatCents(rSoon, intl)} tone={rSoon ? "text-amber-600" : undefined} href={opens("/receivables") ? "/receivables?f=yellow" : undefined} />
        </div>
      )}

      {/* Lager: 2 × 2 (Handy bis Laptop), ab xl in einer Reihe. MHD getrennt: läuft bald ab / schon abgelaufen (Wunsch Inhaber 12.11.2026),
          jede Zahl öffnet genau diese Artikel in der Lagerliste */}
      {stats && (seeStock || money) && (
      <div className={`stagger grid grid-cols-2 gap-3 sm:gap-4 ${seeStock && money ? "xl:grid-cols-4" : seeStock ? "sm:grid-cols-3" : ""}`}>
        {money && <Kpi icon="box" label={t.home.stockValue} value={formatCents(stats.stockValueCents, intl)} sub={`${stats.products} ${t.home.articles}`} wide={!seeStock} />}
        {seeStock && <>
        <Kpi icon="layers" label={t.home.lowStock} value={String(stats.low)} tone={stats.low ? "text-amber-600" : undefined} href="/stock?low=1" />
        <Kpi icon="clock" label={t.home.expiring} value={String(stats.expiring)} sub={stats.expiring ? fill(t.scan.pieces, { n: stats.expiringQty }) : undefined}
          tone={stats.expiring ? "text-orange-600" : undefined} ring={stats.expiring ? "ring-1 ring-orange-200" : undefined} href="/stock?exp=soon" />
        <Kpi icon="alert" label={t.home.expired} value={String(stats.expired)} sub={stats.expired ? fill(t.scan.pieces, { n: stats.expiredQty }) : undefined}
          tone={stats.expired ? "text-red-600" : undefined} ring={stats.expired ? "ring-2 ring-red-200" : undefined} href="/stock?exp=expired" />
        </>}
      </div>
      )}

      {(ins || ai) && <div className={`grid gap-4 ${ai && ins ? "lg:grid-cols-2" : ""}`}>
        {ins && <Link href="/insights" className="card card-hover group flex animate-rise items-center gap-4 p-5">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600"><Icon name="bulb" className="h-6 w-6" /></div>
          <div className="min-w-0 flex-1">
            <div className="font-bold">{t.ins.title}</div>
            <div className="text-sm text-ink-soft">{t.ins.summary.replace("{r}", String(ins.reorder.length)).replace("{e}", String(ins.expiry.length)).replace("{s}", String(ins.slow.length))}</div>
          </div>
          <Icon name="arrowRight" className="h-5 w-5 text-ink-soft rtl:rotate-180" />
        </Link>}
        {ai && (
          <Link href="/ask" className="card card-hover group flex animate-rise items-center gap-4 bg-gradient-to-br from-violet-600 to-indigo-700 p-5 text-white">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/15"><Icon name="spark" className="h-6 w-6" /></div>
            <div className="min-w-0 flex-1"><div className="font-bold">{t.ai.askTitle}</div><div className="truncate text-sm text-white/80">{t.ai.examples[0]}</div></div>
            <Icon name="arrowRight" className="h-5 w-5 rtl:rotate-180" />
          </Link>
        )}
      </div>}

      {showAlerts && <section className="card p-5 animate-rise">
        <h2 className="mb-3 flex items-center gap-2 text-lg font-bold"><Icon name="alert" className="h-5 w-5 text-amber-500" />{t.home.alerts}</h2>
        {al.low.length === 0 && al.expiring.length === 0 && lateList.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-ink-soft"><Icon name="check" className="h-4 w-4 text-brand-600" />{t.home.noAlerts}</p>
        ) : (
          <ul className="divide-y divide-black/5">
            {lateList.map((r) => (
              <li key={"p" + r.invoiceId}>
                <Link href={`/sales/invoices/${r.invoiceId}#payments`} className="group flex items-center justify-between gap-3 py-2.5 text-sm hover:text-brand-700">
                  <span className="flex items-center gap-2"><span className="badge bg-red-100 text-red-800">{t.pay.overdue} · {r.state.daysOverdue} {t.pay.days}</span>{r.customerName} <span className="num text-ink-soft" dir="ltr">{r.number}</span></span>
                  <span className="num font-semibold text-red-600">{formatCents(r.state.overdueCents, intl)}</span>
                </Link>
              </li>
            ))}
            {al.low.map((x) => (
              <li key={"l" + x.id}>
                <Link href={`/stock/${x.id}`} className="group flex items-center justify-between gap-3 py-2.5 text-sm hover:text-brand-700">
                  <span className="flex items-center gap-2"><span className="badge bg-amber-100 text-amber-800">{t.home.lowStock}</span>{x.name}</span>
                  <span className="num font-semibold">{x.qty} / {x.min}</span>
                </Link>
              </li>
            ))}
            {al.expiring.map((x) => {
              const st = expiryState(today, x.expiry), d = daysBetween(today, x.expiry);
              return (
                <li key={"e" + x.batchId}>
                  <Link href={`/stock/${x.id}`} className="group flex items-center justify-between gap-3 py-2.5 text-sm hover:text-brand-700">
                    <span className="flex items-center gap-2">
                      <span className={`badge shrink-0 ${EXPIRY_BADGE[st]}`}>{st === "expired" ? t.home.expired : d === 0 ? capitalize(t.stock.expiresToday) : t.home.expiring}</span>{x.name}
                    </span>
                    <span className="num shrink-0 text-ink-soft">{formatDate(x.expiry, intl)} · {x.qty}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>}
    </div>
  );
}

const opensSales = (a: Parameters<typeof canOpen>[0]) => canOpen(a, "/sales");
const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** wide = auf dem Handy über beide Spalten (die Summe), die anderen zwei stehen darunter nebeneinander */
function Kpi({ icon, label, value, sub, tone, ring, href, wide = false }: { icon: IconName; label: string; value: string; sub?: string; tone?: string; ring?: string; href?: string; wide?: boolean }) {
  const body = (
    <div className="flex items-center gap-3 sm:gap-4">
      <div className={`h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 sm:grid sm:h-12 sm:w-12 ${wide ? "grid" : "hidden"}`}><Icon name={icon} className="h-5 w-5 sm:h-6 sm:w-6" /></div>
      <div className="min-w-0">
        <div className="text-xs text-ink-soft sm:text-sm">{label}</div>
        <div className={`num text-lg font-bold sm:text-2xl ${tone ?? ""}`}>{value}</div>
        {sub && <div className="text-xs text-ink-soft">{sub}</div>}
      </div>
    </div>
  );
  const box = `card group p-3.5 sm:col-span-1 sm:p-5 ${wide ? "col-span-2" : ""} ${ring ?? ""}`;
  return href ? <Link href={href} className={`${box} card-hover`}>{body}</Link> : <div className={box}>{body}</div>;
}
