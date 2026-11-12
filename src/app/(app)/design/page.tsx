import { getI18n } from "@/i18n";
import { db } from "@/db";
import { parseDesign } from "@/lib/doc-design";
import { DesignStudio } from "./DesignStudio";

export const dynamic = "force-dynamic";

/** Belegdesign (Wunsch Inhaber 12.11.2026): Farben, Kopf/Fuß, Schrift, Texte und was auf den Belegen steht – mit Vorschau */
export default async function DesignPage() {
  const { t } = await getI18n();
  const company = await db.query.companySettings.findFirst();
  return <DesignStudio t={t} initial={parseDesign(company?.docDesign ?? {})} />;
}
