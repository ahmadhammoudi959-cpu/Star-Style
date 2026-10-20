import "server-only";
/**
 * Auswertungen: Gewinn und Verlust pro Monat und Verkaufskanal, Jahresübersicht, Umsatzsteuer-Überblick.
 * Rohertrag = Umsatz netto − Wareneinsatz (EK der tatsächlich verkauften Chargen, FEFO).
 * Wareneinkäufe (Kategorie GOODS) sind KEINE Kosten im Monatsergebnis – sonst würde Ware doppelt gezählt
 * (einmal beim Einkauf, einmal beim Verkauf). Sie werden nur zur Info gezeigt.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { monthRange } from "./periods";
import { isSelfAssessed, type ExpenseCategory, type ExpenseTaxCase } from "./accounts";

export type Channel = "BRAND_SHOP" | "GENERAL_SHOP" | "STORE";
export const CHANNELS: Channel[] = ["STORE", "BRAND_SHOP", "GENERAL_SHOP"];

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

export async function monthReport(month: string) {
  const { from, to } = monthRange(month);
  const [inv, cogs, exp, loss, pay, sk] = await Promise.all([
    db.execute<Row>(sql`
      select channel::text as channel, tax_mode::text as tax_mode, oss_country, kind::text as kind, net_cents, vat_cents, gross_cents, vat_breakdown
      from invoices where number is not null and status <> 'DRAFT' and issue_date between ${from} and ${to}`),
    db.execute<Row>(sql`
      select i.channel::text as channel, coalesce(-sum(m.qty * m.unit_cost_cents), 0)::bigint as cogs
      from stock_movements m join invoices i on i.id = m.ref_id
      where m.ref_type = 'invoice' and i.issue_date between ${from} and ${to}
      group by i.channel`),
    db.execute<Row>(sql`
      select category::text as category, tax_case::text as tax_case, channel::text as channel, vat_rate_bp, net_cents, vat_cents, gross_cents
      from expenses where date between ${from} and ${to}`),
    db.execute<Row>(sql`
      select coalesce(sum(l.qty * l.unit_cost_cents), 0)::bigint as v, count(distinct w.id)::int as c
      from write_off_lines l join write_offs w on w.id = l.write_off_id where w.date between ${from} and ${to}`),
    db.execute<Row>(sql`
      select method::text as method,
        coalesce(sum(case when date between ${from} and ${to} then amount_cents else 0 end), 0)::bigint as received,
        coalesce(sum(case when cancelled_at is not null and (cancelled_at at time zone 'Europe/Berlin')::date between ${from} and ${to} then amount_cents else 0 end), 0)::bigint as reversed
      from payments group by method`),
    // Skonto mindert den Umsatz im Monat der Zahlung (Storno der Zahlung → wieder dazu)
    db.execute<Row>(sql`
      select i.channel::text as channel, i.tax_mode::text as tax_mode, i.oss_country, p.skonto_breakdown,
        case when p.date between ${from} and ${to} then -1 else 0 end
        + case when p.cancelled_at is not null and (p.cancelled_at at time zone 'Europe/Berlin')::date between ${from} and ${to} then 1 else 0 end as sign
      from payments p join invoices i on i.id = p.invoice_id
      where p.skonto_cents > 0 and (p.date between ${from} and ${to}
        or (p.cancelled_at is not null and (p.cancelled_at at time zone 'Europe/Berlin')::date between ${from} and ${to}))`),
  ]);

  // Kanäle
  const ch = new Map<Channel, { revenueNet: number; vat: number; gross: number; cogs: number; direct: number; invoices: number }>();
  for (const c of CHANNELS) ch.set(c, { revenueNet: 0, vat: 0, gross: 0, cogs: 0, direct: 0, invoices: 0 });
  // Umsatzsteuer
  const vatOut = new Map<number, { net: number; vat: number }>(); // deutsche USt je Satz
  let taxFreeEu = 0, taxFreeExport = 0;
  const oss = new Map<string, { net: number; vat: number }>();
  for (const r of inv.rows) {
    const c = ch.get(r.channel as Channel)!;
    c.revenueNet += n(r.net_cents); c.vat += n(r.vat_cents); c.gross += n(r.gross_cents);
    if (r.kind === "INVOICE") c.invoices++;
    const groups = r.vat_breakdown as { rateBp: number; netCents: number; vatCents: number }[];
    if (r.tax_mode === "EU_REVERSE_CHARGE") taxFreeEu += n(r.net_cents);
    else if (r.tax_mode === "EXPORT") taxFreeExport += n(r.net_cents);
    else if (r.tax_mode === "EU_B2C" && r.oss_country) {
      const o = oss.get(String(r.oss_country)) ?? { net: 0, vat: 0 };
      o.net += n(r.net_cents); o.vat += n(r.vat_cents); oss.set(String(r.oss_country), o);
    } else for (const g of groups) {
      const v = vatOut.get(g.rateBp) ?? { net: 0, vat: 0 };
      v.net += g.netCents; v.vat += g.vatCents; vatOut.set(g.rateBp, v);
    }
  }
  let skontoNet = 0;
  for (const r of sk.rows) {
    const sign = n(r.sign);
    if (!sign) continue;
    const c = ch.get(r.channel as Channel)!;
    for (const g of r.skonto_breakdown as { rateBp: number; netCents: number; vatCents: number }[]) {
      const net = sign * g.netCents, vat = sign * g.vatCents;
      c.revenueNet += net; c.vat += vat; c.gross += net + vat; skontoNet -= net;
      if (r.tax_mode === "EU_REVERSE_CHARGE") taxFreeEu += net;
      else if (r.tax_mode === "EXPORT") taxFreeExport += net;
      else if (r.tax_mode === "EU_B2C" && r.oss_country) {
        const o = oss.get(String(r.oss_country)) ?? { net: 0, vat: 0 };
        o.net += net; o.vat += vat; oss.set(String(r.oss_country), o);
      } else {
        const v = vatOut.get(g.rateBp) ?? { net: 0, vat: 0 };
        v.net += net; v.vat += vat; vatOut.set(g.rateBp, v);
      }
    }
  }
  for (const r of cogs.rows) ch.get(r.channel as Channel)!.cogs += n(r.cogs);

  // Ausgaben
  const cats = new Map<ExpenseCategory, { net: number; vat: number; count: number }>();
  let expensesNet = 0, goodsPurchases = 0, inputVat = 0, selfAssessed = 0;
  for (const r of exp.rows) {
    const cat = r.category as ExpenseCategory;
    const tc = r.tax_case as ExpenseTaxCase;
    const c = cats.get(cat) ?? { net: 0, vat: 0, count: 0 };
    c.net += n(r.net_cents); c.vat += n(r.vat_cents); c.count++; cats.set(cat, c);
    if (cat === "GOODS") goodsPurchases += n(r.net_cents);
    else {
      expensesNet += n(r.net_cents);
      if (r.channel) ch.get(r.channel as Channel)!.direct += n(r.net_cents);
    }
    if (tc === "DOMESTIC") inputVat += n(r.vat_cents);
    if (isSelfAssessed(tc)) selfAssessed += Math.round((n(r.net_cents) * n(r.vat_rate_bp)) / 10000);
  }

  const channels = CHANNELS.map((c) => {
    const x = ch.get(c)!;
    const grossProfit = x.revenueNet - x.cogs;
    return { channel: c, ...x, grossProfit, contribution: grossProfit - x.direct, marginBp: x.revenueNet ? Math.round((grossProfit * 10000) / x.revenueNet) : 0 };
  });
  const revenueNet = channels.reduce((s, c) => s + c.revenueNet, 0);
  const cogsTotal = channels.reduce((s, c) => s + c.cogs, 0);
  const losses = n(loss.rows[0]?.v);
  const grossProfit = revenueNet - cogsTotal;
  const outputVat = [...vatOut.values()].reduce((s, v) => s + v.vat, 0);

  return {
    month, from, to, channels,
    totals: { revenueNet, cogs: cogsTotal, grossProfit, marginBp: revenueNet ? Math.round((grossProfit * 10000) / revenueNet) : 0, expenses: expensesNet, losses, profit: grossProfit - expensesNet - losses, goodsPurchases, skonto: skontoNet },
    expensesByCategory: [...cats.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.net - a.net),
    lossCount: n(loss.rows[0]?.c),
    vat: {
      output: [...vatOut.entries()].sort((a, b) => b[0] - a[0]).map(([rateBp, v]) => ({ rateBp, ...v })),
      outputTotal: outputVat, inputVat, selfAssessed, taxFreeEu, taxFreeExport,
      oss: [...oss.entries()].map(([country, v]) => ({ country, ...v })),
      payable: outputVat - inputVat, // Reverse-Charge hebt sich auf (USt = VSt)
    },
    payments: pay.rows.map((r) => ({ method: String(r.method), received: n(r.received), reversed: n(r.reversed) })).filter((p) => p.received || p.reversed),
  };
}

export type MonthReport = Awaited<ReturnType<typeof monthReport>>;

/** Jahresübersicht: 12 Monate mit Umsatz, Rohertrag, Kosten, Ergebnis */
export async function yearReport(year: number) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const [inv, cogs, exp, loss, sk] = await Promise.all([
    db.execute<Row>(sql`select to_char(issue_date, 'MM') as m, coalesce(sum(net_cents), 0)::bigint as v from invoices
      where number is not null and status <> 'DRAFT' and issue_date between ${from} and ${to} group by 1`),
    db.execute<Row>(sql`select to_char(i.issue_date, 'MM') as m, coalesce(-sum(s.qty * s.unit_cost_cents), 0)::bigint as v
      from stock_movements s join invoices i on i.id = s.ref_id where s.ref_type = 'invoice' and i.issue_date between ${from} and ${to} group by 1`),
    db.execute<Row>(sql`select to_char(date, 'MM') as m, coalesce(sum(net_cents), 0)::bigint as v from expenses
      where category <> 'GOODS' and date between ${from} and ${to} group by 1`),
    db.execute<Row>(sql`select to_char(w.date, 'MM') as m, coalesce(sum(l.qty * l.unit_cost_cents), 0)::bigint as v
      from write_off_lines l join write_offs w on w.id = l.write_off_id where w.date between ${from} and ${to} group by 1`),
    db.execute<Row>(sql`select m, coalesce(sum(v), 0)::bigint as v from (
        select to_char(date, 'MM') as m, skonto_net_cents as v from payments where skonto_cents > 0 and date between ${from} and ${to}
        union all
        select to_char((cancelled_at at time zone 'Europe/Berlin')::date, 'MM'), -skonto_net_cents from payments
          where skonto_cents > 0 and cancelled_at is not null and (cancelled_at at time zone 'Europe/Berlin')::date between ${from} and ${to}
      ) x group by m`),
  ]);
  const map = (rows: Row[]) => new Map(rows.map((r) => [String(r.m), n(r.v)]));
  const [a, b, c, d] = [map(inv.rows), map(cogs.rows), map(exp.rows), map(loss.rows)];
  const skonto = map(sk.rows);
  for (const [m, v] of skonto) a.set(m, (a.get(m) ?? 0) - v);
  return Array.from({ length: 12 }, (_, i) => {
    const m = String(i + 1).padStart(2, "0");
    const revenueNet = a.get(m) ?? 0, cogsV = b.get(m) ?? 0, expenses = c.get(m) ?? 0, losses = d.get(m) ?? 0;
    return { month: `${year}-${m}`, revenueNet, cogs: cogsV, grossProfit: revenueNet - cogsV, expenses, losses, profit: revenueNet - cogsV - expenses - losses };
  });
}
