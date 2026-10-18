import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { variantOptions } from "@/lib/queries";
import { todayIso, formatDate } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { ReceiveForm } from "./ReceiveForm";

export default async function ReceivePage() {
  const { t, intl } = await getI18n();
  const [options, suppliers, history] = await Promise.all([
    variantOptions(),
    db.select({ id: schema.suppliers.id, name: schema.suppliers.name }).from(schema.suppliers).where(eq(schema.suppliers.active, true)).orderBy(asc(schema.suppliers.name)),
    db.execute<Record<string, unknown>>(sql`
      select r.id, r.number, r.date, r.supplier_invoice_no, s.name as supplier,
             count(l.id)::int as lines, coalesce(sum(l.qty * l.unit_cost_cents),0)::bigint as value
      from goods_receipts r left join suppliers s on s.id = r.supplier_id left join receipt_lines l on l.receipt_id = r.id
      group by r.id, s.name order by r.created_at desc limit 15`),
  ]);
  return (
    <div className="space-y-8">
      <PageHeader title={t.receive.title} subtitle={t.receive.new} />
      <ReceiveForm t={t} options={options} suppliers={suppliers} today={todayIso()} intl={intl} />
      <section className="card overflow-hidden animate-rise">
        <h2 className="px-5 pt-5 text-lg font-bold">{t.receive.history}</h2>
        {history.rows.length === 0 ? <p className="p-5 text-sm text-ink-soft">{t.common.nothingYet}</p> : (
          <div className="table-wrap mt-3">
            <table className="tbl">
              <thead><tr><th>{t.receive.number}</th><th>{t.common.date}</th><th>{t.receive.supplier}</th><th>{t.receive.supplierInvoice}</th><th className="text-end">{t.receive.items}</th><th className="text-end">{t.receive.value}</th></tr></thead>
              <tbody>
                {history.rows.map((r) => (
                  <tr key={String(r.id)}>
                    <td className="num font-semibold" dir="ltr">{String(r.number)}</td>
                    <td className="num">{formatDate(String(r.date), intl)}</td>
                    <td>{(r.supplier as string) ?? t.common.none}</td>
                    <td className="num" dir="ltr">{String(r.supplier_invoice_no) || t.common.none}</td>
                    <td className="num text-end">{Number(r.lines)}</td>
                    <td className="num text-end">{formatCents(Number(r.value), intl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
