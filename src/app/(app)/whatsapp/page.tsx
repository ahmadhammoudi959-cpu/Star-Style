import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requirePerm } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * WhatsApp im System (Wunsch Inhaber 16.11.2026): WhatsApp Web (Business) im Rahmen, verknüpft per QR-Code vom Handy.
 * Den Rahmen zeigt WaDock aus dem Layout (bleibt beim Seitenwechsel offen); ?to=<Nummer> öffnet den Chat mit dieser Nummer.
 * Die Meta-Cloud-API-Anbindung (src/lib/whatsapp.ts, /settings/whatsapp) ruht – der Inhaber will sie nicht (16.11.2026).
 */
export default async function WhatsappPage() {
  await requirePerm("whatsapp");
  const { t } = await getI18n();
  return <PageHeader title={t.wa.title} subtitle={t.waWeb.subtitle} />;
}
