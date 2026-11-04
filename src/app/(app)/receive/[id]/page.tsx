import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { PrintButton } from "@/components/PrintButton";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";

/** Wareneingang ansehen: was kam, wie viel, zu welchem EK, Charge/MHD – druckbar */
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, intl } = await getI18n();
  const head = (await db.execute<Record<string, unknown>>(sql`
    select r.id, r.number, r.date, r.supplier_invoice_no, r.note, r.created_at, s.name as supplier
    from goods_receipts r left join suppliers s on s.id = r.supplier_id where r.id = ${id}`)).rows[0];
  if (!head) notFound();
  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.id, l.variant_id, l.qty, l.unit_cost_cents, l.batch_no, l.expiry_date, p.name_de, p.sku, v.size, v.color, v.barcode,
           coalesce(v.image_file_id, p.image_file_id) as image_id
    from receipt_lines l join variants v on v.id = l.variant_id join products p on p.id = v.product_id
    where l.receipt_id = ${id} order by p.name_de, v.created_at`)).rows.map((x) => ({
    id: String(x.id), variantId: String(x.variant_id), qty: Number(x.qty), cost: Number(x.unit_cost_cents), batchNo: String(x.batch_no ?? ""),
    expiry: (x.expiry_date as string) ?? null, name: String(x.name_de), sku: String(x.sku), variant: [x.size, x.color].filter(Boolean).join(" · "),
    barcode: (x.barcode as string) ?? null, imageId: (x.image_id as string) ?? null,
  }));
  const qty = lines.reduce((s, l) => s + l.qty, 0);
  const value = lines.reduce((s, l) => s + l.qty * l.cost, 0);
  const note = String(head.note ?? "");
  const noteText = note === "Anfangsbestand beim Anlegen" ? t.product.initialNote : note;

  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={`${t.receive.title} ${String(head.number)}`} back="/receive" actions={<PrintButton label={t.pay.print} />} />
      </div>
      <section className="card mb-4 grid gap-4 p-5 animate-rise sm:grid-cols-2 lg:grid-cols-4 print:shadow-none print:ring-0">
        <Info label={t.receive.number}><bdi dir="ltr" className="font-bold">{String(head.number)}</bdi></Info>
        <Info label={t.common.date}><span className="num">{formatDate(String(head.date), intl)}</span></Info>
        <Info label={t.receive.supplier}>{(head.supplier as string) ?? t.common.none}</Info>
        <Info label={t.receive.supplierInvoice}><bdi dir="ltr">{String(head.supplier_invoice_no || "") || t.common.none}</bdi></Info>
        {noteText && <div className="sm:col-span-2 lg:col-span-4"><Info label={t.common.note}>{noteText}</Info></div>}
      </section>

      <section className="card overflow-hidden animate-rise print:shadow-none print:ring-0">
        <h2 className="px-5 pt-5 text-lg font-bold">{t.receive.lines}</h2>
        {lines.length === 0 ? <p className="p-5 text-sm text-ink-soft">{t.common.nothingYet}</p> : (
          <>
            <div className="table-wrap mt-3 hidden md:block">
              <table className="tbl tbl-fit">
                <thead><tr>
                  <th>{t.product.nameDe}</th><th className="w-[7rem]">{t.product.barcode}</th><th className="w-px text-end">{t.common.qty}</th>
                  <th className="w-[6rem] text-end">{t.receive.unitCost}</th><th className="w-[6.5rem] text-end">{t.common.total}</th>
                  <th>{t.receive.batchNo}</th><th>{t.receive.expiry}</th>
                </tr></thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link href={`/stock/${l.variantId}`} className="group flex items-center gap-2.5">
                          <Thumb id={l.imageId} size={40} />
                          <span className="min-w-0">
                            <span className="block font-semibold leading-snug [overflow-wrap:anywhere] group-hover:text-brand-700">{l.name}</span>
                            {l.variant && <span className="badge mt-0.5 bg-brand-50 text-brand-700" dir="auto">{l.variant}</span>}
                          </span>
                        </Link>
                      </td>
                      <td><bdi dir="ltr" className="block text-xs tabular-nums [overflow-wrap:anywhere]">{l.barcode || l.sku}</bdi></td>
                      <td className="num text-end font-semibold">{l.qty}</td>
                      <td className="num text-end">{formatCents(l.cost, intl)}</td>
                      <td className="num text-end font-semibold">{formatCents(l.qty * l.cost, intl)}</td>
                      <td className="text-xs"><bdi dir="ltr">{l.batchNo || "—"}</bdi></td>
                      <td className="num">{l.expiry ? formatDate(l.expiry, intl) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 space-y-2 p-3 md:hidden">
              {lines.map((l) => (
                <Link key={l.id} href={`/stock/${l.variantId}`} className="flex gap-3 rounded-xl bg-brand-50/40 p-3 ring-1 ring-black/5">
                  <Thumb id={l.imageId} size={48} />
                  <div className="min-w-0 flex-1 space-y-1 text-sm">
                    <div className="font-semibold [overflow-wrap:anywhere]">{l.name}</div>
                    {l.variant && <span className="badge bg-brand-50 text-brand-700" dir="auto">{l.variant}</span>}
                    <div className="text-xs text-ink-soft"><bdi dir="ltr">{l.barcode || l.sku}</bdi></div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                      <span>{t.common.qty}: <b className="num">{l.qty}</b></span>
                      <span>{t.receive.unitCost}: <b className="num">{formatCents(l.cost, intl)}</b></span>
                      <span>{t.common.total}: <b className="num">{formatCents(l.qty * l.cost, intl)}</b></span>
                      {l.batchNo && <span>{t.receive.batchNo}: <bdi dir="ltr">{l.batchNo}</bdi></span>}
                      {l.expiry && <span>{t.receive.expiry}: <span className="num">{formatDate(l.expiry, intl)}</span></span>}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 border-t border-black/5 px-5 py-4">
          <span className="text-sm text-ink-soft">{t.common.qty}: <span className="num font-bold text-ink">{qty}</span></span>
          <span className="rounded-xl bg-brand-600 px-4 py-2 font-bold text-white shadow-card print:bg-white print:text-black print:ring-1 print:ring-black">
            {t.receive.value}: <span className="num">{formatCents(value, intl)}</span>
          </span>
        </div>
      </section>
      <div className="mt-4 print:hidden">
        <Link href="/receive#history" className="btn-ghost group"><Icon name="history" className="h-4 w-4" />{t.receive.history}</Link>
      </div>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-xs text-ink-soft">{label}</div><div className="mt-0.5 font-semibold [overflow-wrap:anywhere]">{children}</div></div>;
}
