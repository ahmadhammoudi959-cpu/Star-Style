import type { Metadata } from "next";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { linkGroup, publicCatalog } from "@/lib/direct";
import { regionOptions } from "@/lib/regions";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { OrderApp } from "./OrderApp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Star Style – Katalog", robots: { index: false, follow: false, nocache: true } };

// Rechtstexte stehen im allgemeinen Shop (Impressum, Datenschutzerklärung) – dieselbe Firma
const site = (w: string) => `https://${(w || "starstyle-shop.de").replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

/**
 * Bestell-Link für Kunden (Direktverkauf, öffentlich – kein Login): Katalog wie eine Galerie, Liste zusammenstellen und an
 * uns schicken. Ohne Bezahlen, ohne Shop – die Liste landet im System unter „Direktverkauf“ (src/lib/direct.ts).
 */
export default async function OrderLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { t, locale } = await getI18n();
  const P = t.directPub;
  const group = await linkGroup(token);
  if (!group) {
    return (
      <main className="grid min-h-screen place-items-center bg-navy-900 p-6 text-white">
        <div className="max-w-md space-y-4 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-light.png" alt="Star Style" className="mx-auto h-16 w-auto" />
          <h1 className="text-2xl font-bold">{P.closedTitle}</h1>
          <p className="text-white/80">{P.closedText}</p>
          <div className="flex justify-center"><div className="rounded-xl bg-white px-2 py-1"><LanguageSwitcher current={locale} compact /></div></div>
        </div>
      </main>
    );
  }
  const [catalog, c] = await Promise.all([
    publicCatalog(group),
    db.query.companySettings.findFirst({ columns: { name: true, street: true, zip: true, city: true, email: true, phone: true, website: true } }),
  ]);
  const company = {
    name: c?.name || "Star Style",
    address: [c?.street, [c?.zip, c?.city].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    email: c?.email ?? "",
  };
  const base = site(c?.website ?? "");
  return (
    <OrderApp token={token} group={group} catalog={catalog} t={P} locale={locale} countries={regionOptions(locale)} company={company}
      links={{ imprint: `${base}/policies/legal-notice`, privacy: `${base}/policies/privacy-policy` }}
      language={<LanguageSwitcher current={locale} compact />} />
  );
}
