import Link from "next/link";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { loadInsights } from "@/lib/insights-data";

export const dynamic = "force-dynamic";
const TABS = ["reorder", "expiry", "slow"] as const;

export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as (typeof TABS)[number]) : "reorder";
  const { t, intl } = await getI18n();
  const ins = await loadInsights();
  const counts = { reorder: ins.reorder.length, expiry: ins.expiry.length, slow: ins.slow.length };
  const groups = new Map<string, { id: string; name: string; items: typeof ins.reorder }>();
  for (const r of ins.reorder) {
    const k = r.supplierId ?? "none";
    const g = groups.get(k) ?? { id: k, name: r.supplierName || t.ins.noSupplier, items: [] };
    g.items.push(r); groups.set(k, g);
  }
  const urgTone = { out: "bg-red-100 text-red-800", urgent: "bg-amber-100 text-amber-800", soon: "bg-sky-100 text-sky-800" } as const;
  const actTone = { writeOff: "bg-red-100 text-red-800", discount: "bg-amber-100 text-amber-800", watch: "bg-sky-100 text-sky-800" } as const;

  return (
    <div className="space-y-5">
      <PageHeader title={t.ins.title} subtitle={t.ins.subtitle} />
      <div className="inline-flex flex-wrap rounded-xl bg-white p-1 shadow-card ring-1 ring-black/5 animate-rise">
        {TABS.map((k) => (
          <Link key={k} href={`/insights?tab=${k}`} className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition ${tab === k ? "bg-brand-600 text-white shadow-card" : "text-ink-soft hover:text-ink"}`}>
            {t.ins[k]}<span className={`rounded-full px-2 text-xs ${tab === k ? "bg-white/20" : counts[k] ? "bg-amber-100 text-amber-800" : "bg-slate-100"}`}>{counts[k]}</span>
          </Link>
        ))}
      </div>

      {tab === "reorder" && (counts.reorder === 0 ? <Empty text={t.ins.noneReorder} /> : [...groups.values()].map((g) => (
        <section key={g.id} className="card animate-rise overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
            <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="truck" className="h-5 w-5 text-brand-600" />{g.name}</h2>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-ink-soft">{t.ins.cost}: <b className="num text-ink">{formatCents(g.items.reduce((s, i) => s + i.costCents, 0), intl)}</b></span>
              <Link href={`/insights/order?supplier=${g.id}`} target="_blank" className="btn-ghost group px-3 py-1.5 text-xs"><Icon name="file" className="h-4 w-4" />{t.ins.printList}</Link>
            </div>
          </div>
          <div className="table-wrap mt-3"><table className="tbl">
            <thead><tr><th>{t.product.nameDe}</th><th className="text-end">{t.ins.available}</th><th className="text-end">{t.ins.perMonth}</th><th className="text-end">{t.ins.daysLeft}</th><th className="text-end">{t.ins.suggest}</th><th className="text-end">{t.ins.cost}</th></tr></thead>
            <tbody>{g.items.map((r) => (
              <tr key={r.variantId}>
                <td><Link href={`/stock/${r.variantId}`} className="font-semibold hover:text-brand-700">{r.name}</Link><div className="text-xs text-ink-soft" dir="ltr">{r.sku}</div></td>
                <td className={`num text-end ${r.available <= 0 ? "font-bold text-red-600" : ""}`}>{r.available}</td>
                <td className="num text-end">{Math.round(r.perDay * 30)}</td>
                <td className="text-end"><span className={`badge ${urgTone[r.urgency]}`}>{r.urgency === "out" ? t.ins.urgency.out : r.daysLeft !== null && r.daysLeft < 21 ? `${r.daysLeft} ${t.ins.days}` : r.belowMin ? t.ins.belowMin : r.daysLeft === null ? t.ins.urgency[r.urgency] : `${r.daysLeft} ${t.ins.days}`}</span></td>
                <td className="num text-end font-bold">{r.qty}</td>
                <td className="num text-end">{formatCents(r.costCents, intl)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )))}

      {tab === "expiry" && (counts.expiry === 0 ? <Empty text={t.ins.noneExpiry} /> : (
        <section className="card animate-rise overflow-hidden"><div className="table-wrap"><table className="tbl">
          <thead><tr><th>{t.product.nameDe}</th><th>{t.ins.expiryDate}</th><th className="text-end">{t.ins.stock}</th><th className="text-end">{t.ins.atRisk}</th><th className="text-end">{t.ins.value}</th><th></th></tr></thead>
          <tbody>{ins.expiry.map((r) => (
            <tr key={r.batchId}>
              <td><Link href={`/stock/${r.variantId}`} className="font-semibold hover:text-brand-700">{r.name}</Link></td>
              <td className="num">{formatDate(r.expiry, intl)} <span className="text-xs text-ink-soft">({r.daysToExpiry} {t.ins.days})</span></td>
              <td className="num text-end">{r.qtyLeft}</td>
              <td className="num text-end font-bold">{r.riskQty}</td>
              <td className="num text-end">{formatCents(r.riskCents, intl)}</td>
              <td className="text-end">{r.action === "writeOff"
                ? <Link href="/write-offs" className={`badge ${actTone[r.action]} hover:underline`}>{t.ins.action[r.action]}</Link>
                : <span className={`badge ${actTone[r.action]}`}>{t.ins.action[r.action]}</span>}</td>
            </tr>
          ))}</tbody>
        </table></div></section>
      ))}

      {tab === "slow" && (counts.slow === 0 ? <Empty text={t.ins.noneSlow} /> : (
        <section className="card animate-rise overflow-hidden"><div className="table-wrap"><table className="tbl">
          <thead><tr><th>{t.product.nameDe}</th><th className="text-end">{t.ins.stock}</th><th className="text-end">{t.ins.lockedValue}</th><th className="text-end">{t.ins.sinceReceipt}</th></tr></thead>
          <tbody>{ins.slow.map((r) => (
            <tr key={r.variantId}>
              <td><Link href={`/stock/${r.variantId}`} className="font-semibold hover:text-brand-700">{r.name}</Link><div className="text-xs text-ink-soft" dir="ltr">{r.sku}</div></td>
              <td className="num text-end">{r.stock}</td>
              <td className="num text-end font-semibold">{formatCents(r.valueCents, intl)}</td>
              <td className="num text-end">{r.daysSinceReceipt === null ? "—" : `${r.daysSinceReceipt} ${t.ins.days}`}</td>
            </tr>
          ))}</tbody>
        </table></div></section>
      ))}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="card flex animate-rise items-center gap-3 p-8 text-ink-soft"><Icon name="check" className="h-6 w-6 text-brand-600" />{text}</div>;
}
