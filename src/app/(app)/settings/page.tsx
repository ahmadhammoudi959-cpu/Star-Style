import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "./SettingsForm";
import { ResetTestData } from "./ResetTestData";
import { SecurityCard, type LogKey, type SecurityView } from "./SecurityCard";
import { Icon } from "@/components/Icon";
import { aiConfigured, aiModel } from "@/lib/ai/client";
import { resetStatus } from "@/lib/test-reset";
import { requireSession } from "@/lib/auth";
import { dbConnectionInternal, recentAttempts, type AttemptRow } from "@/lib/login";
import { deviceLabel } from "@/lib/login-guard";
import { formatDate, formatDateTime } from "@/lib/dates";

const logKey = (r: AttemptRow): LogKey =>
  r.step === "change" ? (r.ok ? "changed" : r.reason === "code" ? "code" : "invalid")
  : r.ok && r.reason === "success" ? (r.step === "recovery" ? "recovery" : "success")
  : (["needCode", "invalid", "code", "locked"].includes(r.reason) ? r.reason : "invalid") as LogKey;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const session = await requireSession();
  const { t, intl } = await getI18n();
  const { reset } = await searchParams;
  const [s, rs, me, log] = await Promise.all([
    db.query.companySettings.findFirst(), resetStatus(),
    db.query.users.findFirst({ where: eq(schema.users.id, session.uid) }), recentAttempts(15),
  ]);
  const plain = s ? Object.fromEntries(Object.entries(s).filter(([, v]) => !(v instanceof Date) && (typeof v !== "object" || v === null))) as Record<string, string | number | null> : {};
  const ai = aiConfigured();
  const security: SecurityView = {
    twoOn: !!me?.totpEnabledAt, twoSince: me?.totpEnabledAt ? formatDate(me.totpEnabledAt.toISOString(), intl) : null,
    codesLeft: me?.recoveryCodes.length ?? 0,
    passwordChanged: me?.passwordChangedAt ? formatDateTime(me.passwordChangedAt.toISOString(), intl) : null,
    dbInternal: dbConnectionInternal(),
    log: log.map((r) => ({ at: formatDateTime(r.at, intl), ok: r.ok, key: logKey(r), device: deviceLabel(r.userAgent), ip: r.ip })),
  };
  return (
    <div>
      <PageHeader title={t.settings.title} />
      {reset === "1" && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Icon name="check" className="h-4 w-4 shrink-0" />{t.reset.done}</div>}
      {(reset === "resetLive" || reset === "resetSyncOn") && (
        <div role="alert" className="mb-4 animate-rise rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">{t.reset[reset]}</div>
      )}
      <SettingsForm t={t} s={plain} />
      <SecurityCard t={t} v={security} />
      <section className="card mt-5 flex animate-rise flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <span className={`grid h-10 w-10 place-items-center rounded-xl ${ai ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-ink-soft"}`}><Icon name="spark" className="h-5 w-5" /></span>
          <div><div className="font-bold">{t.ai.status}</div><div className="text-sm text-ink-soft">{ai ? `${t.ai.on} · ${aiModel()}` : t.ai.notConfigured}</div></div>
        </div>
        <span className={`badge ${ai ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-700"}`}>{ai ? t.ai.on : t.ai.off}</span>
      </section>
      {/* vor dem Echtbetrieb: „System zurücksetzen und Echtbetrieb starten“; danach nur noch der Hinweis, seit wann alles echt ist */}
      {rs.block !== "live" && <ResetTestData t={t} p={rs.preview} fingerprint={rs.fingerprint} syncOn={rs.block === "syncOn"} empty={rs.empty} />}
      {rs.block === "live" && rs.liveSince && (
        <section id="live" className="card mt-5 flex animate-rise items-start gap-3 p-5 ring-1 ring-emerald-100">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-emerald-700"><Icon name="check" className="icon-pop h-5 w-5" /></span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{t.reset.liveTitle}</h2>
            <p className="text-sm text-ink-soft">{t.reset.liveCard.replace("{date}", formatDateTime(rs.liveSince.toISOString(), intl))}</p>
          </div>
        </section>
      )}
    </div>
  );
}
