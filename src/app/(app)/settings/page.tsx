import Link from "next/link";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "./SettingsForm";
import { LiveCard, ResetTestData } from "./ResetTestData";
import { Icon, type IconName } from "@/components/Icon";
import { aiConfigured, aiModel } from "@/lib/ai/client";
import { resetStatus, undoLiveInfo } from "@/lib/test-reset";
import { requirePerm } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ reset?: string; live?: string; undo?: string }> }) {
  const session = await requirePerm("settings");
  const admin = session.admin;
  const { t, intl } = await getI18n();
  const { reset, live, undo: undoDone } = await searchParams;
  const [s, rs, undo] = await Promise.all([db.query.companySettings.findFirst(), admin ? resetStatus() : null, admin ? undoLiveInfo() : null]);
  const plain = s ? Object.fromEntries(Object.entries(s).filter(([, v]) => !(v instanceof Date) && (typeof v !== "object" || v === null))) as Record<string, string | number | null> : {};
  const ai = aiConfigured();
  const links: { href: string; icon: IconName; title: string; hint: string }[] = [
    ...(admin ? [{ href: "/settings/users", icon: "users" as const, title: t.users.title, hint: t.users.cardHint }] : []),
    { href: "/account", icon: "shield", title: t.account.cardTitle, hint: t.account.cardHint },
  ];
  return (
    <div>
      <PageHeader title={t.settings.title} />
      {reset === "1" && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Icon name="check" className="h-4 w-4 shrink-0" />{t.reset.done}</div>}
      {live === "1" && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Icon name="check" className="h-4 w-4 shrink-0" />{t.reset.goLiveDone}</div>}
      {undoDone === "1" && rs && rs.block !== "live" && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200"><Icon name="check" className="h-4 w-4 shrink-0" />{t.reset.undoDone}</div>}
      {(reset === "resetLive" || reset === "resetSyncOn") && (
        <div role="alert" className="mb-4 animate-rise rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">{t.reset[reset]}</div>
      )}
      {/* Mitarbeiter & Rechte (Admin) und das eigene Konto (Passwort, Zwei-Schritt) – die Sicherheit liegt jetzt unter „Mein Konto“ */}
      <div id="security" className="stagger mb-5 grid scroll-mt-20 gap-3 md:grid-cols-2">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="card card-hover group flex items-center gap-4 p-5">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name={l.icon} className="icon-pop h-5 w-5" /></span>
            <span className="min-w-0 flex-1"><span className="block font-bold">{l.title}</span><span className="block text-sm text-ink-soft">{l.hint}</span></span>
            <Icon name="arrowRight" className="h-5 w-5 shrink-0 text-ink-soft rtl:rotate-180" />
          </Link>
        ))}
      </div>
      <SettingsForm t={t} s={plain} />
      <section className="card mt-5 flex animate-rise flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <span className={`grid h-10 w-10 place-items-center rounded-xl ${ai ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-ink-soft"}`}><Icon name="spark" className="h-5 w-5" /></span>
          <div><div className="font-bold">{t.ai.status}</div><div className="text-sm text-ink-soft">{ai ? `${t.ai.on} · ${aiModel()}` : t.ai.notConfigured}</div></div>
        </div>
        <span className={`badge ${ai ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-700"}`}>{ai ? t.ai.on : t.ai.off}</span>
      </section>
      {/* Testbetrieb: „Testdaten zurücksetzen“ (beliebig oft) + „Echtbetrieb starten“; danach nur noch der Hinweis, seit wann alles echt ist */}
      {rs && rs.block !== "live" && <ResetTestData t={t} p={rs.preview} fingerprint={rs.fingerprint} syncOn={rs.block === "syncOn"} syncShops={rs.syncShops} empty={rs.empty} />}
      {rs && rs.block === "live" && !rs.liveSince && (
        <p id="live" className="mt-5 animate-rise rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">{t.reset.lockedHint}</p>
      )}
      {rs && rs.block === "live" && rs.liveSince && (
        <LiveCard t={t} since={formatDateTime(rs.liveSince.toISOString(), intl)}
          undo={undo && { ...undo.since, state: undo.state, until: formatDateTime(undo.until.toISOString(), intl) }} />
      )}
    </div>
  );
}
