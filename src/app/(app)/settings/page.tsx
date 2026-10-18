import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "./SettingsForm";
import { Icon } from "@/components/Icon";
import { aiConfigured, aiModel } from "@/lib/ai/client";

export default async function SettingsPage() {
  const { t } = await getI18n();
  const s = await db.query.companySettings.findFirst();
  const plain = s ? Object.fromEntries(Object.entries(s).filter(([, v]) => !(v instanceof Date) && (typeof v !== "object" || v === null))) as Record<string, string | number | null> : {};
  const ai = aiConfigured();
  return (
    <div>
      <PageHeader title={t.settings.title} />
      <SettingsForm t={t} s={plain} />
      <section className="card mt-5 flex animate-rise flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex items-center gap-3">
          <span className={`grid h-10 w-10 place-items-center rounded-xl ${ai ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-ink-soft"}`}><Icon name="spark" className="h-5 w-5" /></span>
          <div><div className="font-bold">{t.ai.status}</div><div className="text-sm text-ink-soft">{ai ? `${t.ai.on} · ${aiModel()}` : t.ai.notConfigured}</div></div>
        </div>
        <span className={`badge ${ai ? "bg-violet-100 text-violet-800" : "bg-slate-100 text-slate-700"}`}>{ai ? t.ai.on : t.ai.off}</span>
      </section>
    </div>
  );
}
