import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requirePerm } from "@/lib/auth";
import { loadCarrierSettings, usedCarrierNames } from "@/lib/carrier-settings";
import { CarrierManager } from "./CarrierManager";

/** Versanddienste (Wunsch Inhaber 13.11.2026): die Knöpfe in der Karte „Versand“ der Rechnung – Recht „Einstellungen“ */
export default async function CarriersPage() {
  await requirePerm("settings");
  const { t } = await getI18n();
  const settings = await loadCarrierSettings();
  const used = await usedCarrierNames(settings);
  return (
    <div>
      <PageHeader title={t.carriers.title} subtitle={t.carriers.subtitle} back="/settings" />
      <CarrierManager t={t} initial={settings} used={used} />
    </div>
  );
}
