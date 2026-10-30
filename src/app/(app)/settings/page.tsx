import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "./SettingsForm";
import { ResetTestData } from "./ResetTestData";
import { Icon } from "@/components/Icon";
import { aiConfigured, aiModel } from "@/lib/ai/client";
import { resetStatus } from "@/lib/test-reset";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const { t } = await getI18n();
  const { reset } = await searchParams;
  const [s, rs] = await Promise.all([db.query.companySettings.findFirst(), resetStatus()]);
  const plain = s ? Object.fromEntries(Object.entries(s).filter(([, v]) => !(v instanceof Date) && (typeof v !== "object" || v === null))) as Record<string, string | number | null> : {};
  const ai = aiConfigured();
  return (
    <div>
      <PageHeader title={t.settings.title} />
      {reset && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Icon name="check" className="h-4 w-4" />{t.reset.done}</div>}
      <SettingsForm t={t} s={plain} />
      <section className="card mt-5 flex animate-rise flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <span className={`grid h-10 w-10 place-items-center rounded-xl ${ai ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-ink-soft"}`}><Icon name="spark" className="h-5 w-5" /></span>
          <div><div className="font-bold">{t.ai.status}</div><div className="text-sm text-ink-soft">{ai ? `${t.ai.on} · ${aiModel()}` : t.ai.notConfigured}</div></div>
        </div>
        <span className={`badge ${ai ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-700"}`}>{ai ? t.ai.on : t.ai.off}</span>
      </section>
      {rs.block !== "live" && !rs.empty && <ResetTestData t={t} p={rs.preview} fingerprint={rs.fingerprint} syncOn={rs.block === "syncOn"} />}
    </div>
  );
}
