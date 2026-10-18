import type { Metadata, Viewport } from "next";
import "./globals.css";
import { getI18n } from "@/i18n";

export const metadata: Metadata = { title: "Star Style", description: "Lager, Verkauf und Rechnungen" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f6a58" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dir } = await getI18n();
  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
