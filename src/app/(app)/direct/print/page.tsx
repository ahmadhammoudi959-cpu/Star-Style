import Link from "next/link";
import { headers } from "next/headers";
import { getI18n } from "@/i18n";
import de from "@/i18n/de";
import ar from "@/i18n/ar";
import { Icon } from "@/components/Icon";
import { PrintButton } from "@/components/PrintButton";
import { requirePerm } from "@/lib/auth";
import { directBaseUrl, directLinks } from "@/lib/direct";
import { directLinkUrl } from "@/lib/direct-rules";
import { qrSvgPath } from "@/lib/qr";

export const dynamic = "force-dynamic";

/** Aushang für das Büro/den Laden: QR-Code zum Bestell-Link, Text auf Deutsch und Arabisch (wie die Kundschaft) */
export default async function DirectPrintPage({ searchParams }: { searchParams: Promise<{ g?: string }> }) {
  await requirePerm("direct");
  const { g } = await searchParams;
  const group = g === "WHOLESALE" ? "WHOLESALE" : "RETAIL";
  const { t } = await getI18n();
  const link = (await directLinks()).find((l) => l.group === group);
  const url = link?.token && link.on ? directLinkUrl(directBaseUrl(await headers()), link.token) : null;
  const qr = url ? qrSvgPath(url) : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link href="/direct" className="btn-ghost group"><Icon name="arrowLeft" className="icon-pop h-4 w-4 rtl:rotate-180" />{t.direct.back}</Link>
        {url && <PrintButton label={t.direct.print} />}
      </div>
      {!url || !qr ? (
        <p className="card p-5 font-semibold text-ink-soft">{t.direct.notYet}</p>
      ) : (
        <section className="mx-auto max-w-xl space-y-5 rounded-3xl bg-white p-8 text-center shadow-card ring-1 ring-black/5 print:max-w-none print:shadow-none print:ring-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo.png" alt="Star Style" className="mx-auto h-16 w-auto" />
          <div className="flex h-1.5 overflow-hidden rounded-full" aria-hidden><span className="flex-[3] bg-brand-600" /><span className="flex-1 bg-accent-500" /></div>
          <div className="space-y-1">
            <h1 className="text-3xl font-bold">{de.direct.printTitle}</h1>
            <p className="text-2xl font-bold" dir="rtl" lang="ar">{ar.direct.printTitle}</p>
          </div>
          <div className="mx-auto w-fit rounded-2xl bg-white p-4 ring-1 ring-black/10">
            <svg viewBox={`0 0 ${qr.size} ${qr.size}`} className="h-72 w-72" role="img" aria-label="QR" shapeRendering="crispEdges">
              <path d={qr.d} fill="#0b1222" />
            </svg>
          </div>
          <div className="space-y-1 text-lg">
            <p>{de.direct.printText}</p>
            <p dir="rtl" lang="ar">{ar.direct.printText}</p>
          </div>
          <p className="font-semibold text-brand-700">{de.directPub.forWhom[group]} · <span dir="rtl" lang="ar">{ar.directPub.forWhom[group]}</span></p>
          <bdi dir="ltr" className="block break-all text-xs text-ink-soft">{url}</bdi>
        </section>
      )}
    </div>
  );
}
