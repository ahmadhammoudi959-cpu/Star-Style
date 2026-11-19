import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requirePerm } from "@/lib/auth";
import { saleOptions } from "@/lib/sales-queries";
import { NewPromotion } from "./NewPromotion";

export const dynamic = "force-dynamic";

/** Neue Aktion: 1. Artikel + Rabatt (+ wo er gilt) → danach erstellt die KI das Werbebild, die Seite der Aktion öffnet sich */
export default async function NewPromotionPage() {
  await requirePerm("promotions");
  const { t, intl } = await getI18n();
  const options = await saleOptions();
  return (
    <div className="space-y-6">
      <PageHeader title={t.promo.newTitle} subtitle={t.promo.newSubtitle} back="/promotions" />
      <NewPromotion t={t} options={options} intl={intl} />
    </div>
  );
}
