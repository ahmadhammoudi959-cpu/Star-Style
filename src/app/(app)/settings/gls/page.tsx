import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requirePerm } from "@/lib/auth";
import { loadGlsSettings } from "@/lib/gls-client";
import { glsReady } from "@/lib/gls";
import { GlsForm } from "./GlsForm";
import { Icon } from "@/components/Icon";

/**
 * GLS-Anbindung (Wunsch Inhaber 13.11.2026: „اربط مع GLS“) – Recht „Einstellungen“. Zugangsdaten kommen von GLS (ShipIT);
 * der Inhaber trägt sie selbst ein. Das Passwort wird nie angezeigt, nur „gespeichert“.
 */
export default async function GlsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  await requirePerm("settings");
  const { saved } = await searchParams;
  const { t } = await getI18n();
  const s = await loadGlsSettings();
  return (
    <div>
      <PageHeader title={t.gls.title} subtitle={t.gls.subtitle} back="/settings" />
      {saved === "1" && <div role="status" className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200"><Icon name="check" className="h-4 w-4 shrink-0" />{t.gls.saved}</div>}
      <GlsForm t={t} initial={{ endpoint: s.endpoint, user: s.user, contactId: s.contactId, flex: s.flex, hasPassword: Boolean(s.password) }} ready={glsReady(s)} />
    </div>
  );
}
