import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { bpToPercent, formatCents } from "@/lib/money";
import { formatDate, todayIso } from "@/lib/dates";
import { determineTaxMode } from "@/lib/tax";
import { customerOptions, saleOptions } from "@/lib/sales-queries";
import { DocEditor } from "../../DocEditor";
import { EmailForm, InvoiceOp } from "../../DocActions";
import { mailConfigured } from "@/lib/mail";
import { StatusBadge } from "../../StatusBadge";

export default async function InvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ customer?: string }> }) {
  const { id } = await params;
  const { customer: preset } = await searchParams;
  const { t, intl } = await getI18n();

  if (id === "new") {
    const [customers, options] = await Promise.all([customerOptions(), saleOptions()]);
    return (
      <div>
        <PageHeader title={t.sales.newInvoice} back="/sales" />
        <DocEditor t={t} kind="invoice" customers={customers} options={options} intl={intl}
          initial={{ customerId: preset ?? "", date: todayIso(), channel: "STORE", discountBp: 0, notes: "", retentionOfTitle: true, lines: [] }} />
      </div>
    );
  }

  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id), with: { lines: true, customer: true } });
  if (!inv) notFound();
  const lines = inv.lines.sort((a, b) => a.position - b.position);
  const [replaces, cancels, cancelledBy, replacedBy] = await Promise.all([
    inv.replacesInvoiceId ? db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.replacesInvoiceId) }) : null,
    inv.cancelsInvoiceId ? db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.cancelsInvoiceId) }) : null,
    db.query.invoices.findFirst({ where: eq(schema.invoices.cancelsInvoiceId, id) }),
    db.query.invoices.findFirst({ where: and(eq(schema.invoices.replacesInvoiceId, id), ne(schema.invoices.status, "DRAFT")) }),
  ]);
  const title = inv.kind === "CANCELLATION" ? `Storno ${inv.number}` : inv.number ? `${t.sales.invoice} ${inv.number}` : `${t.sales.status.DRAFT}`;

  if (inv.status === "DRAFT") {
    const [customers, options] = await Promise.all([customerOptions(), saleOptions(inv.offerId ?? undefined)]);
    return (
      <div>
        <PageHeader title={title} subtitle={inv.customer.name} back="/sales"
          actions={<><StatusBadge t={t} status="DRAFT" />
            <a href={`/api/pdf/invoice/${inv.id}`} target="_blank" className="btn-ghost group"><Icon name="receipt" className="h-4 w-4" />{t.sales.pdf}</a>
            <div className="w-40"><InvoiceOp t={t} id={inv.id} op="delete" label={t.common.delete} icon="trash" tone="btn-danger" confirmText={t.common.delete + "?"} /></div></>} />
        <DocEditor t={t} kind="invoice" customers={customers} options={options} intl={intl} initial={{
          id: inv.id, customerId: inv.customerId, date: todayIso(), channel: inv.channel, deliveryDate: inv.deliveryDate ?? "", discountBp: inv.discountBp,
          skontoBp: inv.skontoBp, skontoDays: inv.skontoDays, notes: inv.notes, retentionOfTitle: inv.retentionOfTitle, offerId: inv.offerId, replacesInvoiceId: inv.replacesInvoiceId,
          lines: lines.map((l) => ({ variantId: l.variantId, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp })),
        }} />
      </div>
    );
  }

  const pendingFixable = inv.status === "ISSUED" && inv.taxMode === "EU_PENDING_VATID" && determineTaxMode(inv.customer) === "EU_REVERSE_CHARGE";
  return (
    <div>
      <PageHeader title={title} subtitle={inv.custName} back="/sales" actions={<StatusBadge t={t} status={inv.status} />} />
      {pendingFixable && (
        <div className="mb-5 flex animate-rise flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
          <div className="text-sm font-semibold text-amber-900">{t.sales.vatIdNowValid}: <span dir="ltr">{inv.customer.vatId}</span> · {t.sales.refund}: {formatCents(inv.vatCents, intl)}</div>
          <div className="w-72"><InvoiceOp t={t} id={inv.id} op="correct" label={t.sales.fixVat} icon="check" tone="btn-primary" /></div>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="card overflow-hidden animate-rise">
          <div className="grid gap-4 p-5 sm:grid-cols-4">
            <Info k={t.sales.issueDate} v={formatDate(inv.issueDate, intl)} />
            <Info k={t.sales.deliveryDate} v={formatDate(inv.deliveryDate, intl)} />
            <Info k={t.sales.dueDate} v={inv.kind === "INVOICE" ? formatDate(inv.dueDate, intl) : "—"} />
            <Info k={t.customer.taxMode} v={t.taxMode[inv.taxMode]} />
          </div>
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>#</th><th>{t.product.nameDe}</th><th className="text-end">{t.common.qty}</th><th className="text-end">{t.sales.price}</th><th className="text-end">{t.sales.lineDiscount}</th><th className="text-end">{t.sales.net}</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id}><td className="text-ink-soft">{l.position}</td><td>{l.description}</td><td className="num text-end">{l.qty}</td>
                <td className="num text-end">{formatCents(l.unitPriceCents, intl)}</td><td className="num text-end">{l.discountBp ? `${bpToPercent(l.discountBp)} %` : ""}</td>
                <td className="num text-end font-semibold">{formatCents(l.netCents, intl)}</td></tr>
            ))}</tbody>
          </table></div>
          <dl className="ms-auto max-w-sm space-y-1.5 p-5 text-sm">
            {inv.discountCents !== 0 && <><Row k={t.sales.subtotal} v={formatCents(inv.subtotalCents, intl)} /><Row k={`${t.sales.discount} ${bpToPercent(inv.discountBp)} %`} v={formatCents(-inv.discountCents, intl)} /></>}
            <Row k={t.sales.net} v={formatCents(inv.netCents, intl)} />
            {inv.vatBreakdown.map((g) => <Row key={g.rateBp} k={`${t.sales.vat} ${bpToPercent(g.rateBp)} %`} v={formatCents(g.vatCents, intl)} />)}
            <div className="flex justify-between rounded-xl bg-brand-600 px-4 py-3 font-bold text-white"><span>{t.sales.gross}</span><span className="num">{formatCents(inv.grossCents, intl)}</span></div>
          </dl>
        </div>
        <aside className="card h-fit space-y-2 p-5 animate-rise">
          <a href={`/api/pdf/invoice/${inv.id}`} target="_blank" className="btn-primary group w-full justify-start"><Icon name="receipt" className="h-4 w-4" />{t.sales.pdf}</a>
          {mailConfigured() && <EmailForm t={t} kind="invoice" id={inv.id} defaultTo={inv.customer.email} />}
          {inv.sentAt && <p className="px-1 text-xs text-ink-soft">✓ {t.sales.status.SENT}: {formatDate(inv.sentAt.toISOString(), intl)}</p>}
          {inv.kind === "INVOICE" && <a href={`/api/pdf/invoice/${inv.id}?type=delivery`} target="_blank" className="btn-ghost group w-full justify-start"><Icon name="truck" className="h-4 w-4" />{t.sales.deliveryNote}</a>}
          {inv.status === "ISSUED" && inv.kind === "INVOICE" && <>
            <InvoiceOp t={t} id={inv.id} op="correct" label={t.sales.correct} icon="edit" />
            <p className="px-1 text-xs text-ink-soft">{t.sales.correctHint}</p>
            <InvoiceOp t={t} id={inv.id} op="cancel" label={t.sales.cancel} icon="trash" tone="btn-danger" confirmText={t.sales.cancelConfirm} />
          </>}
          <div className="space-y-1 pt-2 text-sm">
            {replaces && <Ref label={t.sales.replaces} id={replaces.id} n={replaces.number} />}
            {cancels && <Ref label={t.sales.cancellationOf} id={cancels.id} n={cancels.number} />}
            {cancelledBy && <Ref label="Storno" id={cancelledBy.id} n={cancelledBy.number} />}
            {replacedBy && <Ref label={t.sales.replacedBy} id={replacedBy.id} n={replacedBy.number} />}
            <Ref label={t.sales.customer} id={inv.customerId} n={inv.custName} href={`/customers/${inv.customerId}`} />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) { return <div><div className="text-xs text-ink-soft">{k}</div><div className="font-semibold">{v || "—"}</div></div>; }
function Row({ k, v }: { k: string; v: string }) { return <div className="flex justify-between"><dt className="text-ink-soft">{k}</dt><dd className="num font-semibold">{v}</dd></div>; }
function Ref({ label, id, n, href }: { label: string; id: string; n: string | null; href?: string }) {
  return <div className="flex justify-between gap-2"><span className="text-ink-soft">{label}</span><Link href={href ?? `/sales/invoices/${id}`} className="font-semibold text-brand-700 hover:underline" dir="ltr">{n}</Link></div>;
}
