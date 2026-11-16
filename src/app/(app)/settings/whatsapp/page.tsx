import { headers } from "next/headers";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requirePerm } from "@/lib/auth";
import { loadWaSettings } from "@/lib/whatsapp";
import { waReady } from "@/lib/whatsapp-rules";
import { WaForm } from "./WaForm";

export const dynamic = "force-dynamic";

/** WhatsApp Business (Meta Cloud API) verbinden – Recht „Einstellungen“. Token und App-Geheimnis trägt der Inhaber selbst ein. */
export default async function WaSettingsPage() {
  await requirePerm("settings");
  const { t } = await getI18n();
  const s = await loadWaSettings();
  const h = await headers();
  const base = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `https://${h.get("x-forwarded-host") ?? h.get("host") ?? ""}`).replace(/\/+$/, "");
  return (
    <div>
      <PageHeader title={t.waSet.title} subtitle={t.waSet.subtitle} back="/settings" />
      <WaForm t={t} ready={waReady(s)} webhookUrl={`${base}/api/whatsapp/webhook`} verifyToken={s.verifyToken} initial={{
        phoneNumberId: s.phoneNumberId, wabaId: s.wabaId, apiVersion: s.apiVersion, hasToken: Boolean(s.accessToken), hasSecret: Boolean(s.appSecret),
        displayPhone: s.displayPhone, verifiedName: s.verifiedName,
      }} />
    </div>
  );
}
