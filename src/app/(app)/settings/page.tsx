import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { SettingsForm } from "./SettingsForm";

export default async function SettingsPage() {
  const { t } = await getI18n();
  const s = await db.query.companySettings.findFirst();
  const plain = s ? Object.fromEntries(Object.entries(s).filter(([, v]) => !(v instanceof Date) && (typeof v !== "object" || v === null))) as Record<string, string | number | null> : {};
  return <div><PageHeader title={t.settings.title} /><SettingsForm t={t} s={plain} /></div>;
}
