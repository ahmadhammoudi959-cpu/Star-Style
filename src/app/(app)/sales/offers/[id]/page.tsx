import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { addDaysIso, formatDate, todayIso } from "@/lib/dates";
import { expireOffers } from "@/lib/sales";
import { customerOptions, saleOptions } from "@/lib/sales-queries";
import { DocEditor } from "../../DocEditor";
import { EmailForm, OfferOps } from "../../DocActions";
import { mailConfigured } from "@/lib/mail";
import { StatusBadge } from "../../StatusBadge";

export default async function OfferPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ customer?: string }> }) {
  const { id } = await params;
  const { customer: preset } = await searchParams;
  const { t, intl } = await getI18n();
  await expireOffers();
  const company = await db.query.companySettings.findFirst();
  const today = todayIso();

  if (id === "new") {
    const [customers, options] = await Promise.all([customerOptions(), saleOptions()]);
    return (
      <div>
        <PageHeader title={t.sales.newOffer} back="/sales?tab=offers" />
        <DocEditor t={t} kind="offer" customers={customers} options={options} intl={intl}
          initial={{ customerId: preset ?? "", date: today, validUntil: addDaysIso(today, company?.offerValidityDays ?? 14), discountBp: 0, notes: "", lines: [] }} />
      </div>
    );
  }

  const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, id), with: { lines: true, customer: true } });
  if (!o) notFound();
  const inv = o.status === "CONVERTED" ? await db.query.invoices.findFirst({ where: eq(schema.invoices.offerId, id) }) : null;
  const editable = o.status === "DRAFT" || o.status === "SENT";
  const [customers, options] = editable ? await Promise.all([customerOptions(), saleOptions(o.id)]) : [[], []];

  return (
    <div>
      <PageHeader title={`${t.sales.offer} ${o.number}`} subtitle={o.customer.name} back="/sales?tab=offers"
        actions={<><StatusBadge t={t} status={o.status} /><a href={`/api/pdf/offer/${o.id}`} target="_blank" className="btn-ghost group"><Icon name="receipt" className="h-4 w-4" />{t.sales.pdf}</a></>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div>
          {editable ? (
            <DocEditor t={t} kind="offer" customers={customers} options={options} intl={intl} initial={{
              id: o.id, customerId: o.customerId, date: o.date, validUntil: o.validUntil, discountBp: o.discountBp, notes: o.notes,
              lines: o.lines.sort((a, b) => a.position - b.position).map((l) => ({ variantId: l.variantId, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp })),
            }} />
          ) : (
            <div className="card p-5 animate-rise">
              <ul className="divide-y divide-black/5">
                {o.lines.sort((a, b) => a.position - b.position).map((l) => <li key={l.id} className="flex justify-between py-2 text-sm"><span>{l.qty} × {l.description}</span></li>)}
              </ul>
              {inv && <Link href={`/sales/invoices/${inv.id}`} className="btn-primary mt-4 group"><Icon name="receipt" className="h-4 w-4" />{inv.number ?? t.sales.status.DRAFT}</Link>}
            </div>
          )}
        </div>
        <aside className="card h-fit space-y-3 p-5 animate-rise">
          <div className="text-sm text-ink-soft">{t.sales.reservedUntil}</div>
          <div className="font-bold">{formatDate(o.validUntil, intl)}</div>
          {o.acceptedAt && <div className="text-sm text-brand-700">{t.sales.status.ACCEPTED}: {formatDate(o.acceptedAt.toISOString(), intl)} {o.acceptedVia && `· ${o.acceptedVia}`}</div>}
          <OfferOps t={t} id={o.id} status={o.status} />
          {mailConfigured() && <EmailForm t={t} kind="offer" id={o.id} defaultTo={o.customer.email} />}
        </aside>
      </div>
    </div>
  );
}
