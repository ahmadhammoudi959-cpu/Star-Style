import { getI18n } from "@/i18n";
import { db } from "@/db";
import { PrintButton } from "@/components/PrintButton";
import { formatCents } from "@/lib/money";
import { formatDate, todayIso } from "@/lib/dates";
import { loadInsights } from "@/lib/insights-data";

export const dynamic = "force-dynamic";

/** Druckbare Bestellliste je Lieferant (bewusst auf Deutsch – geht an den Lieferanten). */
export default async function OrderListPage({ searchParams }: { searchParams: Promise<{ supplier?: string }> }) {
  const { supplier = "none" } = await searchParams;
  const { t, intl } = await getI18n();
  const [ins, company] = await Promise.all([loadInsights(), db.query.companySettings.findFirst()]);
  const items = ins.reorder.filter((r) => (r.supplierId ?? "none") === supplier);
  const name = items[0]?.supplierName || t.ins.noSupplier;
  return (
    <div className="card mx-auto max-w-3xl animate-rise p-8 print:shadow-none print:ring-0" dir="ltr">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-ink-soft">{company?.name}</div>
          <h1 className="text-2xl font-bold">Bestellliste</h1>
          <div className="text-sm text-ink-soft">{name} · {formatDate(todayIso(), intl)}</div>
        </div>
        <div className="print:hidden"><PrintButton label={t.pay.print} /></div>
      </div>
      <table className="tbl">
        <thead><tr><th>Art.-Nr.</th><th>Artikel</th><th className="text-end">Menge</th><th className="text-end">EK ca.</th></tr></thead>
        <tbody>{items.map((r) => (
          <tr key={r.variantId}><td className="num">{r.sku}</td><td>{r.name}</td><td className="num text-end font-bold">{r.qty}</td><td className="num text-end">{formatCents(r.costCents, intl)}</td></tr>
        ))}</tbody>
      </table>
      <div className="mt-4 text-end text-sm">Summe ca.: <b className="num">{formatCents(items.reduce((s, r) => s + r.costCents, 0), intl)}</b></div>
    </div>
  );
}
