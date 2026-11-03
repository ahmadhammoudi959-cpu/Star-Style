import type { Metadata } from "next";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Scanner } from "./Scanner";

// eigene App-Datei: „Zum Startbildschirm hinzufügen“ auf dieser Seite → Symbol, das direkt den Scanner öffnet
export const metadata: Metadata = {
  manifest: "/brand/scan.webmanifest",
  icons: { apple: "/brand/scan-180.png" },
  appleWebApp: { capable: true, title: "Star Scan", statusBarStyle: "default" },
};

export default async function ScanPage() {
  const { t, intl } = await getI18n();
  return (
    <div>
      <PageHeader title={t.scan.title} subtitle={t.scan.subtitle} />
      <Scanner t={t} intl={intl} />
    </div>
  );
}
