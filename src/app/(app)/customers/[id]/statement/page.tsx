import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { PrintButton } from "@/components/PrintButton";
import { formatCents } from "@/lib/money";
import { formatDate, todayIso } from "@/lib/dates";
import { customerStatement } from "@/lib/receivables";

export const dynamic = "force-dynamic";

export default async function StatementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, intl } = await getI18n();
  const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, id) });
  if (!c) notFound();
  const company = await db.query.companySettings.findFirst();
  const rows = await customerStatement(id);
  const bal = rows.at(-1)?.balanceCents ?? 0;
  const kindLabel = { invoice: t.pay.invoice, cancellation: "Storno", payment: t.pay.payment, skonto: t.pay.skontoGranted, payment_cancelled: `${t.pay.payment} ${t.pay.cancelled}` };

  return (
    <div>
      <div className="print:hidden"><PageHeader title={t.pay.statement} subtitle={c.name} back={`/customers/${id}`} actions={<PrintButton label={t.pay.print} />} /></div>
      <div className="card animate-rise p-6 print:shadow-none print:ring-0">
        <div className="mb-6 flex flex-wrap justify-between gap-4">
          <div>
            <div className="text-xs text-ink-soft">{company?.name}</div>
            <div className="text-lg font-bold">{c.name}</div>
            <div className="text-sm text-ink-soft">{[c.street, [c.zip, c.city].filter(Boolean).join(" ")].filter(Boolean).join(", ")}</div>
          </div>
          <div className="text-end text-sm">
            <div className="text-xl font-bold print:text-black">{t.pay.statement}</div>
            <div className="text-ink-soft">{formatDate(todayIso(), intl)} · {c.number}</div>
          </div>
        </div>
        {rows.length === 0 ? <p className="text-sm text-ink-soft">{t.common.nothingYet}</p> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>{t.common.date}</th><th></th><th>Nr.</th><th></th><th className="text-end">{t.pay.charge}</th><th className="text-end">{t.pay.payment}</th><th className="text-end">{t.pay.balance}</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}>
                <td className="num">{formatDate(r.date, intl)}</td>
                <td>{kindLabel[r.kind]}</td>
                <td><Link href={`/sales/invoices/${r.refId}`} className="num font-semibold hover:text-brand-700" dir="ltr">{r.ref}</Link></td>
                <td className="text-xs text-ink-soft" dir="auto">{r.text}</td>
                <td className="num text-end">{r.amountCents > 0 ? formatCents(r.amountCents, intl) : ""}</td>
                <td className="num text-end text-brand-700">{r.amountCents < 0 ? formatCents(-r.amountCents, intl) : ""}</td>
                <td className="num text-end font-semibold">{formatCents(r.balanceCents, intl)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="ms-auto mt-4 flex max-w-sm justify-between rounded-xl bg-brand-600 px-4 py-3 font-bold text-white print:bg-white print:text-black print:ring-1 print:ring-black">
          <span>{bal < 0 ? t.pay.credit : t.pay.balance}</span><span className="num">{formatCents(Math.abs(bal), intl)}</span>
        </div>
      </div>
    </div>
  );
}
