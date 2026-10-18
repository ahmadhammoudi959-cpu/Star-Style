import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { variantOptions } from "@/lib/queries";
import { formatDate, todayIso } from "@/lib/dates";
import { formatCents } from "@/lib/money";
import { WriteOffForm } from "./WriteOffForm";

export default async function WriteOffsPage() {
  const { t, intl } = await getI18n();
  const [options, history] = await Promise.all([
    variantOptions(),
    db.execute<Record<string, unknown>>(sql`
      select w.id, w.number, w.date, w.reason, coalesce(sum(l.qty),0)::int as qty, coalesce(sum(l.qty*l.unit_cost_cents),0)::bigint as value
      from write_offs w left join write_off_lines l on l.write_off_id = w.id
      group by w.id order by w.created_at desc limit 20`),
  ]);
  return (
    <div className="space-y-8">
      <PageHeader title={t.writeOff.title} subtitle={t.writeOff.new} />
      <WriteOffForm t={t} options={options.filter((o) => o.stockQty > 0)} today={todayIso()} />
      <section className="card overflow-hidden animate-rise">
        <h2 className="px-5 pt-5 text-lg font-bold">{t.writeOff.protocol}</h2>
        {history.rows.length === 0 ? <p className="p-5 text-sm text-ink-soft">{t.common.nothingYet}</p> : (
          <div className="table-wrap mt-3"><table className="tbl">
            <thead><tr><th>{t.receive.number}</th><th>{t.common.date}</th><th>{t.writeOff.reason}</th><th className="text-end">{t.common.qty}</th><th className="text-end">{t.writeOff.value}</th></tr></thead>
            <tbody>{history.rows.map((r) => (
              <tr key={String(r.id)}>
                <td><Link href={`/write-offs/${r.id}`} className="num font-semibold hover:text-brand-700" dir="ltr">{String(r.number)}</Link></td>
                <td className="num">{formatDate(String(r.date), intl)}</td>
                <td><span className="badge bg-amber-100 text-amber-800">{t.writeOff.reasons[r.reason as keyof typeof t.writeOff.reasons]}</span></td>
                <td className="num text-end">{Number(r.qty)}</td>
                <td className="num text-end">{formatCents(Number(r.value), intl)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
