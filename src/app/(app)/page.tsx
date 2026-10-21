import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { Icon, type IconName } from "@/components/Icon";
import { alerts, dashboardStats } from "@/lib/queries";
import { openItems } from "@/lib/receivables";
import { loadInsights } from "@/lib/insights-data";
import { aiConfigured } from "@/lib/ai/client";
import { formatCents } from "@/lib/money";
import { daysBetween, formatDate, todayIso } from "@/lib/dates";
import { setupSteps } from "@/lib/onboarding";
import { fill } from "@/i18n";

export default async function Home() {
  const session = await requireSession();
  const { t, intl } = await getI18n();
  const [stats, al, open, ins, setup] = await Promise.all([dashboardStats(), alerts(), openItems(), loadInsights(), setupSteps()]);
  const ai = aiConfigured();
  const debts = open.filter((r) => r.state.openCents > 0);
  const rOpen = debts.reduce((s, r) => s + r.state.openCents, 0);
  const rOverdue = debts.reduce((s, r) => s + r.state.overdueCents, 0);
  const rSoon = debts.filter((r) => r.light === "yellow").reduce((s, r) => s + r.state.nextDueCents, 0);
  const lateList = debts.filter((r) => r.light === "red").slice(0, 5);
  const today = todayIso();

  const actions: { href: string; label: string; hint: string; icon: IconName; tone: string; soon?: boolean }[] = [
    { href: "/sales/invoices/new", label: t.home.sell, hint: t.home.sellHint, icon: "cart", tone: "from-brand-500 to-brand-700" },
    { href: "/receive", label: t.home.receive, hint: t.home.receiveHint, icon: "truck", tone: "from-sky-500 to-sky-700" },
    { href: "/expenses/new", label: t.home.expense, hint: t.home.expenseHint, icon: "receipt", tone: "from-rose-500 to-pink-700" },
    { href: "/write-offs", label: t.home.loss, hint: t.home.lossHint, icon: "alert", tone: "from-amber-500 to-orange-600" },
    { href: "/reports", label: t.home.reports, hint: t.home.reportsHint, icon: "chart", tone: "from-violet-500 to-indigo-700" },
  ];

  return (
    <div className="space-y-8">
      <div className="animate-rise">
        <h1 className="text-3xl font-bold tracking-tight">{t.home.greeting}, {session.name.split(" ")[0]}</h1>
        <p className="text-ink-soft">{t.home.subtitle}</p>
      </div>

      {!setup.allDone && (
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
          <ol className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4">
            {setup.steps.map((s) => {
              const isNext = s.key === setup.next;
              const k = s.key as keyof typeof t.setup1;
              return (
                <li key={s.key}>
                  <Link href={s.href} className={`group flex h-full items-start gap-3 rounded-xl p-3 ring-1 transition hover:-translate-y-0.5 hover:shadow-card ${s.done ? "bg-emerald-50/60 ring-emerald-100" : isNext ? "bg-white ring-2 ring-accent-500 shadow-card" : "bg-white ring-black/5"}`}>
                    <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-base font-bold ${s.done ? "bg-emerald-500 text-white" : isNext ? "bg-accent-500 text-white animate-pulse" : "bg-brand-50 text-brand-700"}`}>
                      {s.done ? <Icon name="check" className="h-5 w-5" /> : s.n}
                    </span>
                    <span className="min-w-0">
                      <span className={`block font-bold ${s.done ? "text-emerald-800 line-through decoration-emerald-300" : ""}`}>{t.setup1[k]}</span>
                      <span className="block text-xs text-ink-soft">{t.setup1[(s.key + "Hint") as keyof typeof t.setup1]}</span>
                      {isNext && <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-accent-600">{t.setup1.start} <Icon name="arrowRight" className="h-3.5 w-3.5 rtl:rotate-180" /></span>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <div className="stagger grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {actions.map((a) => {
          const inner = (
            <>
              <div className={`mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br ${a.tone} text-white shadow-lift`}>
                <Icon name={a.icon} className="h-7 w-7" />
              </div>
              <div className="text-lg font-bold">{a.label}</div>
              <div className="text-sm text-ink-soft">{a.soon ? t.home.comingSoon : a.hint}</div>
            </>
          );
          return a.soon ? (
            <div key={a.href} className="card group p-5 opacity-60">{inner}</div>
          ) : (
            <Link key={a.href} href={a.href} className="card card-hover group p-5">{inner}</Link>
          );
        })}
      </div>

      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi icon="euro" label={t.pay.kpiOpen} value={formatCents(rOpen, intl)} sub={`${debts.length} ${t.pay.openInvoices}`} href="/receivables" />
        <Kpi icon="alert" label={t.pay.totalOverdue} value={formatCents(rOverdue, intl)} tone={rOverdue ? "text-red-600" : undefined} href="/receivables?f=red" />
        <Kpi icon="clock" label={t.pay.dueSoon} value={formatCents(rSoon, intl)} tone={rSoon ? "text-amber-600" : undefined} href="/receivables?f=yellow" />
      </div>

      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi icon="box" label={t.home.stockValue} value={formatCents(stats.stockValueCents, intl)} sub={`${stats.products} ${t.home.articles}`} />
        <Kpi icon="layers" label={t.home.lowStock} value={String(stats.low)} tone={stats.low ? "text-amber-600" : undefined} href="/stock?low=1" />
        <Kpi icon="clock" label={t.home.expiring} value={String(stats.expiring)} tone={stats.expiring ? "text-red-600" : undefined} href="/stock" />
      </div>

      <div className={`grid gap-4 ${ai ? "lg:grid-cols-2" : ""}`}>
        <Link href="/insights" className="card card-hover group flex animate-rise items-center gap-4 p-5">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600"><Icon name="bulb" className="h-6 w-6" /></div>
          <div className="min-w-0 flex-1">
            <div className="font-bold">{t.ins.title}</div>
            <div className="text-sm text-ink-soft">{t.ins.summary.replace("{r}", String(ins.reorder.length)).replace("{e}", String(ins.expiry.length)).replace("{s}", String(ins.slow.length))}</div>
          </div>
          <Icon name="arrowRight" className="h-5 w-5 text-ink-soft rtl:rotate-180" />
        </Link>
        {ai && (
          <Link href="/ask" className="card card-hover group flex animate-rise items-center gap-4 bg-gradient-to-br from-violet-600 to-indigo-700 p-5 text-white">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/15"><Icon name="spark" className="h-6 w-6" /></div>
            <div className="min-w-0 flex-1"><div className="font-bold">{t.ai.askTitle}</div><div className="truncate text-sm text-white/80">{t.ai.examples[0]}</div></div>
            <Icon name="arrowRight" className="h-5 w-5 rtl:rotate-180" />
          </Link>
        )}
      </div>

      <section className="card p-5 animate-rise">
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
            {al.expiring.map((x, i) => {
              const d = daysBetween(today, x.expiry);
              return (
                <li key={"e" + i}>
                  <Link href={`/stock/${x.id}`} className="group flex items-center justify-between gap-3 py-2.5 text-sm hover:text-brand-700">
                    <span className="flex items-center gap-2">
                      <span className={`badge ${d < 0 ? "bg-red-100 text-red-800" : "bg-orange-100 text-orange-800"}`}>{d < 0 ? t.stock.expired : t.home.expiring}</span>{x.name}
                    </span>
                    <span className="num text-ink-soft">{formatDate(x.expiry, intl)} · {x.qty}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Kpi({ icon, label, value, sub, tone, href }: { icon: IconName; label: string; value: string; sub?: string; tone?: string; href?: string }) {
  const body = (
    <div className="flex items-center gap-4">
      <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name={icon} className="h-6 w-6" /></div>
      <div>
        <div className="text-sm text-ink-soft">{label}</div>
        <div className={`num text-2xl font-bold ${tone ?? ""}`}>{value}</div>
        {sub && <div className="text-xs text-ink-soft">{sub}</div>}
      </div>
    </div>
  );
  return href ? <Link href={href} className="card card-hover group p-5">{body}</Link> : <div className="card group p-5">{body}</div>;
}
