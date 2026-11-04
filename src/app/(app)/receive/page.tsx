import Link from "next/link";
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { variantOptions } from "@/lib/queries";
import { todayIso, formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { ReceiveForm } from "./ReceiveForm";
import { OpenButton } from "@/components/OpenButton";

const INITIAL_NOTE = "Anfangsbestand beim Anlegen";

export default async function ReceivePage({ searchParams }: { searchParams: Promise<{ hq?: string }> }) {
  const { hq = "" } = await searchParams;
  const { t, intl } = await getI18n();
  const like = hq.trim() ? `%${hq.trim().toLowerCase()}%` : null;
  const [options, suppliers, history] = await Promise.all([
    variantOptions(),
    db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.active, true)).orderBy(asc(schema.suppliers.name)),
    // letzte Wareneingänge; Suche nach WE-Nr., Lieferant, Lieferanten-Rechnungsnr. oder Artikel (Name, Nr., Barcode)
    db.execute<Record<string, unknown>>(sql`
      select r.id, r.number, r.date, r.supplier_invoice_no, r.note, s.name as supplier,
             count(l.id)::int as lines, coalesce(sum(l.qty), 0)::int as qty, coalesce(sum(l.qty * l.unit_cost_cents),0)::bigint as value
      from goods_receipts r left join suppliers s on s.id = r.supplier_id left join receipt_lines l on l.receipt_id = r.id
      where (${like}::text is null or lower(r.number) like ${like} or lower(coalesce(s.name, '')) like ${like} or lower(r.supplier_invoice_no) like ${like}
             or exists (select 1 from receipt_lines lx join variants vx on vx.id = lx.variant_id join products px on px.id = vx.product_id
                        where lx.receipt_id = r.id and (lower(px.name_de) like ${like} or lower(px.sku) like ${like} or coalesce(vx.barcode, '') like ${like})))
      group by r.id, s.name order by r.created_at desc limit 50`),
  ]);
  const rows = history.rows.map((r) => ({
    id: String(r.id), number: String(r.number), date: String(r.date), invoiceNo: String(r.supplier_invoice_no ?? ""), supplier: (r.supplier as string) ?? null,
    initial: r.note === INITIAL_NOTE, lines: Number(r.lines), qty: Number(r.qty), value: Number(r.value),
  }));

  return (
    <div className="space-y-8">
      <PageHeader title={t.receive.title} subtitle={t.receive.new} />
      <ReceiveForm t={t} options={options} suppliers={suppliers} today={todayIso()} intl={intl} />
      <section id="history" className="card overflow-hidden animate-rise">
        <div className="flex flex-col gap-3 px-5 pt-5 md:flex-row md:items-end md:justify-between">
          <h2 className="text-lg font-bold">{t.receive.history}</h2>
          <form action="/receive#history" className="relative block w-full md:max-w-sm">
            <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" />
            <input name="hq" defaultValue={hq} placeholder={t.receive.searchHistory} className="input ps-9" />
          </form>
        </div>
        {rows.length === 0 ? <p className="p-5 text-sm text-ink-soft">{hq.trim() ? t.picker.empty : t.common.nothingYet}</p> : (
          <>
            <div className="table-wrap mt-3 hidden md:block">
              <table className="tbl tbl-fit">
                <thead><tr>
                  <th>{t.receive.number}</th><th>{t.common.date}</th><th>{t.receive.supplier}</th><th>{t.receive.supplierInvoice}</th>
                  <th className="w-px text-end">{t.receive.items}</th><th className="w-px text-end">{t.common.qty}</th><th className="text-end">{t.receive.value}</th>
                  <th className="w-px"><span className="sr-only">{t.product.open}</span></th>
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><Link href={`/receive/${r.id}`} className="font-semibold hover:text-brand-700"><bdi dir="ltr">{r.number}</bdi></Link></td>
                      <td className="num">{formatDate(r.date, intl)}</td>
                      <td>
                        <span className="[overflow-wrap:anywhere]">{r.supplier ?? t.common.none}</span>
                        {r.initial && <span className="badge mt-0.5 flex w-fit bg-sky-50 text-sky-800">{t.product.initialNote}</span>}
                      </td>
                      <td><bdi dir="ltr" className="text-xs tabular-nums">{r.invoiceNo || t.common.none}</bdi></td>
                      <td className="num text-end">{r.lines}</td>
                      <td className="num text-end font-semibold">{r.qty}</td>
                      <td className="num text-end">{formatCents(r.value, intl)}</td>
                      <td className="text-end"><OpenButton href={`/receive/${r.id}`} label={t.product.open} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3 space-y-2 p-3 md:hidden">
              {rows.map((r) => (
                <div key={r.id} className="space-y-1.5 rounded-xl bg-brand-50/40 p-2.5 ring-1 ring-black/5">
                  <div className="flex items-center justify-between gap-2">
                    <bdi dir="ltr" className="font-bold">{r.number}</bdi>
                    <span className="num text-xs text-ink-soft">{formatDate(r.date, intl)}</span>
                  </div>
                  <div className="text-sm">{r.supplier ?? t.common.none}{r.invoiceNo && <> · <bdi dir="ltr">{r.invoiceNo}</bdi></>}</div>
                  {r.initial && <span className="badge bg-sky-50 text-sky-800">{t.product.initialNote}</span>}
                  <div className="flex items-end justify-between gap-2">
                    <div className="flex flex-wrap gap-x-3 text-xs">
                      <span>{t.receive.items}: <b className="num">{r.lines}</b></span>
                      <span>{t.common.qty}: <b className="num">{r.qty}</b></span>
                      <span>{t.receive.value}: <b className="num">{formatCents(r.value, intl)}</b></span>
                    </div>
                    <OpenButton href={`/receive/${r.id}`} label={t.product.open} className="shrink-0 px-2.5 py-1.5 text-xs" />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

