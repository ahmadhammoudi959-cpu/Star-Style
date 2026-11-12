import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { OpenButton } from "@/components/OpenButton";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { SupplierForm } from "../../../suppliers/SupplierForm";

export const dynamic = "force-dynamic";

/** Firma aus Ausgaben: Stammdaten (gleiches Formular wie Lieferanten, mit „Art“) + ihre Ausgaben */
export default async function ExpenseVendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, intl } = await getI18n();
  const s = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, id) });
  if (!s) notFound();
  if (s.kind === "GOODS") redirect(`/suppliers/${s.id}`);
  const rows = await db.query.expenses.findMany({ where: eq(schema.expenses.supplierId, id), orderBy: [desc(schema.expenses.date), desc(schema.expenses.createdAt)], limit: 200 });
  const total = rows.reduce((sum, r) => sum + r.grossCents, 0);

  return (
    <div className="space-y-6">
      <div>
        <PageHeader title={s.name} subtitle={t.supplier.kinds.EXPENSE} back="/expenses/vendors" />
        <SupplierForm t={t} initial={s} />
      </div>
      <section className="card overflow-hidden animate-rise">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
          <h2 className="text-lg font-bold">{t.exp.vendorList}</h2>
          {rows.length > 0 && <span className="text-sm text-ink-soft">{rows.length} {t.exp.vendorInvoices} · <span className="num font-semibold text-ink">{formatCents(total, intl)}</span></span>}
        </div>
        {rows.length === 0 ? <p className="p-5 text-sm text-ink-soft">{t.common.nothingYet}</p> : (
          <>
            <div className="table-wrap mt-3 hidden md:block"><table className="tbl tbl-fit">
              <thead><tr>
                <th>{t.common.date}</th><th>{t.exp.invoiceNo}</th><th>{t.exp.category}</th><th className="text-end">{t.exp.gross}</th><th></th>
                <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">{formatDate(r.date, intl)}</td>
                  <td><Link href={`/expenses/${r.id}`} className="hover:text-brand-700"><bdi dir="ltr">{r.invoiceNo || "—"}</bdi></Link></td>
                  <td><span className="badge bg-brand-50 text-brand-700">{t.exp.categories[r.category]}</span></td>
                  <td className="num text-end font-semibold">{formatCents(r.grossCents, intl)}</td>
                  <td className="text-end">{!r.paid && <span className="badge bg-amber-100 text-amber-800">{t.exp.open}</span>}</td>
                  <td className="text-end"><OpenButton href={`/expenses/${r.id}`} label={t.product.open} /></td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="space-y-2 p-3 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="flex items-end justify-between gap-2 rounded-xl bg-brand-50/40 p-2.5 ring-1 ring-black/5">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
                      <span className="num">{formatDate(r.date, intl)}</span>
                      {r.invoiceNo && <bdi dir="ltr">{r.invoiceNo}</bdi>}
                      <span className="num font-bold text-ink">{formatCents(r.grossCents, intl)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <span className="badge bg-brand-50 text-brand-700">{t.exp.categories[r.category]}</span>
                      {!r.paid && <span className="badge bg-amber-100 text-amber-800">{t.exp.open}</span>}
                    </div>
                  </div>
                  <OpenButton href={`/expenses/${r.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
