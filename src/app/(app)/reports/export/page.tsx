import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatDate, todayIso } from "@/lib/dates";
import { lockedMonths } from "@/lib/periods";
import { collectMonth } from "@/lib/advisor";
import { mailConfigured } from "@/lib/mail";
import { MonthNav } from "../../expenses/MonthNav";
import { CreatePackage, SendForm, UnlockButton } from "./ExportForms";

export const dynamic = "force-dynamic";

export default async function ExportPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const sp = await searchParams;
  const current = todayIso().slice(0, 7);
  const [cy, cm] = current.split("-").map(Number);
  const prev = cm === 1 ? `${cy - 1}-12` : `${cy}-${String(cm - 1).padStart(2, "0")}`;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : prev;
  const { t, intl } = await getI18n();
  const [d, locks, history] = await Promise.all([
    collectMonth(month), lockedMonths(),
    db.select().from(schema.advisorExports).where(eq(schema.advisorExports.month, month)).orderBy(desc(schema.advisorExports.createdAt)).limit(10),
  ]);
  const locked = locks.has(month);
  const monthExpenses = d.expenses.filter((e) => e.date >= d.from && e.date <= d.to);
  const missing = monthExpenses.filter((e) => !e.fileId).length;
  const mail = mailConfigured();

  return (
    <div className="space-y-6">
      <PageHeader title={t.rep.export} subtitle={t.rep.exportHint} back={`/reports?month=${month}`} />
      <div className="flex flex-wrap items-center gap-3 animate-rise">
        <MonthNav month={month} base="/reports/export" months={t.rep.months} locked={locked} />
        <span className={`badge ${locked ? "bg-amber-100 text-amber-800" : "bg-brand-50 text-brand-700"}`}>{locked ? t.rep.locked : t.rep.openMonth}</span>
        {locked && <UnlockButton t={t} month={month} />}
      </div>

      {d.warnings.includes("missingDatevNumbers") && (
        <Link href="/settings#datev" className="card card-hover group flex animate-rise items-center gap-3 border-s-4 border-amber-400 p-4 text-sm font-semibold text-amber-900">
          <Icon name="alert" className="h-5 w-5 shrink-0 text-amber-500" />{t.rep.missingNumbers}
        </Link>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="card animate-rise p-5">
          <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t.sales.invoices} value={d.invoices.length} />
            <Stat label={t.pay.payments} value={d.payments.length} />
            <Stat label={t.exp.title} value={monthExpenses.length} warn={missing > 0 ? t.rep.missingReceipts.replace("{n}", String(missing)) : undefined} href={`/expenses?month=${month}`} />
            <Stat label={t.rep.bookings} value={d.bookings.length} />
          </div>
          <ul className="mt-5 space-y-2 text-sm text-ink-soft">
            {["DATEV/EXTF_Buchungsstapel", "DATEV/EXTF_Debitoren_Kreditoren", "Ausgangsrechnungen/ (PDF)", "Eingangsrechnungen/", "Zahlungseingaenge.csv · Ausgaben.csv", "Monatsuebersicht.pdf"].map((f) => (
              <li key={f} className="flex items-center gap-2" dir="ltr"><Icon name="file" className="h-4 w-4 text-brand-600" />{f}</li>
            ))}
          </ul>
        </section>
        <aside className="card animate-rise h-fit p-5">
          <CreatePackage t={t} month={month} canLock={!locked && month < current} mail={mail} advisorEmail={d.company?.advisorEmail ?? ""} />
        </aside>
      </div>

      {history.length > 0 && (
        <section className="card animate-rise p-5">
          <h2 className="mb-3 font-bold">{t.rep.history}</h2>
          <ul className="divide-y divide-black/5">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <span className="num">{formatDate(h.createdAt.toISOString(), intl)} {new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(h.createdAt)} · {h.bookings} {t.rep.bookings}</span>
                <span className="flex items-center gap-3">
                  <a href={`/api/files/${h.fileId}`} download className="group inline-flex items-center gap-1 font-semibold text-brand-700 hover:underline"><Icon name="download" className="h-4 w-4" />ZIP</a>
                  {mail && <SendForm t={t} fileId={h.fileId} advisorEmail={d.company?.advisorEmail ?? ""} />}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, warn, href }: { label: string; value: number; warn?: string; href?: string }) {
  const body = (
    <>
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="num text-2xl font-bold">{value}</div>
      {warn && <div className="mt-0.5 text-xs font-semibold text-red-600">{warn}</div>}
    </>
  );
  return href ? <Link href={href} className="card-hover group rounded-xl bg-slate-50 p-3 ring-1 ring-black/5">{body}</Link> : <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-black/5">{body}</div>;
}
