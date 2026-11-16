import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { can, requirePerm } from "@/lib/auth";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { invoiceForReturn } from "@/lib/returns";
import { ReturnForm } from "./ReturnForm";

export const dynamic = "force-dynamic";

/** Retoure erfassen: 1. Rechnung wählen (oder vom Knopf an der Rechnung), 2. Mengen + Grund, 3. buchen */
export default async function NewReturnPage({ searchParams }: { searchParams: Promise<{ invoice?: string; q?: string }> }) {
  const session = await requirePerm("sales.returns");
  const { invoice: invoiceId, q = "" } = await searchParams;
  const { t, intl } = await getI18n();
  const R = t.ret;

  if (invoiceId) {
    const data = await invoiceForReturn(invoiceId);
    if (!data) notFound();
    const { inv, block, draftId, plan } = data;
    const header = <PageHeader title={R.new} subtitle={`${t.sales.invoice} ${inv.number ?? ""} · ${inv.custName || inv.customer.name}`} back={`/sales/invoices/${inv.id}`} />;
    if (block || draftId) {
      const current = block === "notIssued" && inv.status === "CANCELLED"
        ? await db.query.invoices.findFirst({ where: and(eq(schema.invoices.replacesInvoiceId, inv.id), eq(schema.invoices.status, "ISSUED")), columns: { id: true, number: true } })
        : null;
      return (
        <div>
          {header}
          <div className="card animate-rise flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="flex items-start gap-2 text-sm font-semibold text-amber-900"><Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              {draftId ? R.draftOpen : block === "shopOrder" ? R.shopHint : R.notIssued}</p>
            {draftId && <Link href={`/sales/invoices/${draftId}`} className="btn-primary group"><Icon name="edit" className="h-4 w-4" />{R.openDraft}</Link>}
            {current && <Link href={`/returns/new?invoice=${current.id}`} className="btn-primary group"><Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" />{R.toCurrent} <bdi dir="ltr">{current.number}</bdi></Link>}
          </div>
        </div>
      );
    }
    const vids = inv.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
    const codes = vids.length
      ? await db.select({ id: schema.variants.id, barcode: schema.variants.barcode, sku: schema.products.sku }).from(schema.variants)
        .innerJoin(schema.products, eq(schema.products.id, schema.variants.productId)).where(inArray(schema.variants.id, vids))
      : [];
    const codeOf = (v: string | null) => { const c = codes.find((x) => x.id === v); return c ? c.barcode || c.sku : ""; };
    return (
      <div>
        {header}
        <ReturnForm t={t} intl={intl} canRefund={can(session, "payments.record")} invoice={{
          id: inv.id, number: inv.number ?? "", custName: inv.custName || inv.customer.name, issueDate: inv.issueDate ?? "",
          plan: { ...plan, lines: plan.lines.map((l) => ({ ...l, code: codeOf(l.variantId) })) },
        }} />
      </div>
    );
  }

  // Schritt 1: Rechnung wählen (nur ausgestellte Rechnungen aus dem Laden – Shop-Bestellungen laufen über den Shop)
  const term = q.trim();
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db.select({
    id: schema.invoices.id, number: schema.invoices.number, date: schema.invoices.issueDate, name: schema.invoices.custName,
    gross: schema.invoices.grossCents,
  }).from(schema.invoices)
    .where(and(
      eq(schema.invoices.kind, "INVOICE"), eq(schema.invoices.status, "ISSUED"), isNull(schema.invoices.externalOrderId),
      term ? or(ilike(schema.invoices.number, like), ilike(schema.invoices.custName, like)) : undefined,
    ))
    .orderBy(desc(schema.invoices.issueDate), desc(schema.invoices.number)).limit(40);

  return (
    <div className="space-y-6">
      <PageHeader title={R.new} subtitle={R.pickInvoice} back="/returns" />
      <section className="card animate-rise overflow-hidden">
        <form method="get" className="flex gap-2 border-b border-black/5 p-4">
          <input name="q" defaultValue={term} placeholder={R.pickHint} className="input min-w-0 flex-1" autoComplete="off" />
          <button className="btn-primary group shrink-0"><Icon name="search" className="h-4 w-4" />{t.common.search.replace(/[ .…]+$/, "")}</button>
        </form>
        {rows.length === 0 ? <p className="p-5 text-sm text-ink-soft">{R.noInvoices}</p> : (
          <ul className="divide-y divide-black/5">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <bdi dir="ltr" className="num font-bold">{r.number}</bdi>
                    <span className="num text-xs text-ink-soft">{formatDate(r.date, intl)}</span>
                  </div>
                  <div className="truncate text-sm" dir="auto">{r.name}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="num hidden text-sm font-semibold sm:inline">{formatCents(r.gross, intl)}</span>
                  <Link href={`/returns/new?invoice=${r.id}`} className="btn group gap-1.5 bg-brand-600 px-3 py-1.5 text-xs text-white shadow-card hover:bg-brand-700 hover:shadow-lift">
                    <Icon name="undo" className="h-4 w-4" />{R.choose}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
