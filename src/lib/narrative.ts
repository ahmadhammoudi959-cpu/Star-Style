/** Monatsbericht in Klartext – aus den Zahlen, ohne KI-Dienst (zuverlässig, sofort, kostenlos). */
import type { MonthReport } from "./reports";

export type NarrTexts = {
  revenue: string; revenueDelta: string; margin: string; bestChannel: string; topCost: string;
  profit: string; loss: string; losses: string; overdue: string; reorder: string; expiry: string; empty: string;
};

export function narrative(r: MonthReport, prev: MonthReport | null, x: {
  t: NarrTexts; channelName: (c: string) => string; categoryName: (c: string) => string; money: (c: number) => string;
  overdueCents: number; reorderUrgent: number; expiryRiskCents: number;
}): string[] {
  const T = r.totals, t = x.t;
  const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");
  const pct = (bp: number) => `${(bp / 100).toFixed(1).replace(".", ",")} %`;
  const out: string[] = [];
  if (T.revenueNet === 0 && T.expenses === 0) out.push(t.empty);
  else {
    let s = fill(t.revenue, { v: x.money(T.revenueNet) });
    if (prev && prev.totals.revenueNet > 0) {
      const d = Math.round(((T.revenueNet - prev.totals.revenueNet) * 10000) / prev.totals.revenueNet);
      s += " " + fill(t.revenueDelta, { d: `${d >= 0 ? "+" : "−"}${pct(Math.abs(d))}` });
    }
    out.push(s);
    if (T.revenueNet > 0) out.push(fill(t.margin, { v: x.money(T.grossProfit), m: pct(T.marginBp) }));
    const best = [...r.channels].filter((c) => c.revenueNet > 0).sort((a, b) => b.contribution - a.contribution)[0];
    if (best && r.channels.filter((c) => c.revenueNet > 0).length > 1) out.push(fill(t.bestChannel, { c: x.channelName(best.channel), v: x.money(best.contribution) }));
    const cost = r.expensesByCategory.filter((e) => e.category !== "GOODS")[0];
    if (cost) out.push(fill(t.topCost, { c: x.categoryName(cost.category), v: x.money(cost.net), p: T.expenses ? pct(Math.round((cost.net * 10000) / T.expenses)) : "" }));
    out.push(fill(T.profit >= 0 ? t.profit : t.loss, { v: x.money(Math.abs(T.profit)) }));
    if (T.losses > 0) out.push(fill(t.losses, { v: x.money(T.losses) }));
  }
  if (x.overdueCents > 0) out.push(fill(t.overdue, { v: x.money(x.overdueCents) }));
  if (x.reorderUrgent > 0) out.push(fill(t.reorder, { n: String(x.reorderUrgent) }));
  if (x.expiryRiskCents > 0) out.push(fill(t.expiry, { v: x.money(x.expiryRiskCents) }));
  return out;
}
