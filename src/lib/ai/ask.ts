import "server-only";
/**
 * „Frag dein Geschäft“: Fragen in Alltagssprache. Die KI darf NUR lesen – über fest definierte Abfragen
 * mit Parametern (kein freies SQL). Gespräche werden nicht gespeichert.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { callClaude, type ContentBlock, type Message, type Tool } from "./client";
import { monthReport, yearReport } from "../reports";
import { openItems } from "../receivables";
import { loadInsights } from "../insights-data";
import { variantLabel } from "../queries";
import { todayIso } from "../dates";

type Row = Record<string, unknown>;
const eur = (cents: unknown) => Math.round(Number(cents ?? 0)) / 100;
const D = /^\d{4}-\d{2}-\d{2}$/;
const like = (q: unknown) => (typeof q === "string" && q.trim() ? `%${q.trim().toLowerCase()}%` : null);
const lim = (v: unknown, d = 10) => Math.min(Math.max(Number(v) || d, 1), 50);
function range(i: Record<string, unknown>) {
  const to = typeof i.to === "string" && D.test(i.to) ? i.to : todayIso();
  const from = typeof i.from === "string" && D.test(i.from) ? i.from : `${to.slice(0, 4)}-01-01`;
  return { from, to };
}

export const TOOLS: Tool[] = [
  { name: "month_report", description: "Profit & loss for one month: net sales, cost of goods sold, gross profit, costs, losses, profit, per sales channel, costs by category, VAT overview, payments received. Amounts in EUR.",
    input_schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } }, required: ["month"] } },
  { name: "year_report", description: "Per month of a year: net sales, gross profit, costs, losses, profit (EUR).",
    input_schema: { type: "object", properties: { year: { type: "integer" } }, required: ["year"] } },
  { name: "product_sales", description: "Sold products in a date range with quantity, net sales, cost and gross profit (EUR). Optional text filter on product name/SKU.",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, query: { type: "string" }, sort: { type: "string", enum: ["revenue", "qty", "profit"] }, limit: { type: "integer" } } } },
  { name: "customer_sales", description: "Net sales per customer in a date range (EUR), with number of invoices. Optional name filter.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, query: { type: "string" }, limit: { type: "integer" } } } },
  { name: "customer_account", description: "Find customers by name or number: open balance, overdue amount, credit limit, payment term, last invoices.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "stock_lookup", description: "Find products by name, SKU or barcode: stock, reserved, minimum stock, cost and selling prices, next expiry date.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "open_receivables", description: "All unpaid invoices with amount open, days overdue, next due date.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } } },
  { name: "expenses", description: "Expenses (purchase invoices) in a date range, optionally one category: totals and the largest items (EUR, net).",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, category: { type: "string" } } } },
  { name: "stock_insights", description: "Reorder suggestions (based on the last 90 days of sales), batches at risk of expiring unsold, and slow movers.",
    input_schema: { type: "object", properties: {} } },
];

export async function runTool(name: string, i: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "month_report": {
      const m = typeof i.month === "string" && /^\d{4}-\d{2}$/.test(i.month) ? i.month : todayIso().slice(0, 7);
      const r = await monthReport(m);
      return {
        month: m, totals: Object.fromEntries(Object.entries(r.totals).map(([k, v]) => [k, k === "marginBp" ? `${(Number(v) / 100).toFixed(1)} %` : eur(v)])),
        channels: r.channels.map((c) => ({ channel: c.channel, netSales: eur(c.revenueNet), cogs: eur(c.cogs), grossProfit: eur(c.grossProfit), directCosts: eur(c.direct), contribution: eur(c.contribution), invoices: c.invoices })),
        costsByCategory: r.expensesByCategory.map((e) => ({ category: e.category, net: eur(e.net), count: e.count })),
        vat: { outputVat: eur(r.vat.outputTotal), inputVat: eur(r.vat.inputVat), expectedPayable: eur(r.vat.payable) },
        paymentsReceived: r.payments.map((p) => ({ method: p.method, amount: eur(p.received - p.reversed) })),
      };
    }
    case "year_report": {
      const y = Number(i.year) || Number(todayIso().slice(0, 4));
      return (await yearReport(y)).map((m) => ({ month: m.month, netSales: eur(m.revenueNet), grossProfit: eur(m.grossProfit), costs: eur(m.expenses), losses: eur(m.losses), profit: eur(m.profit) }));
    }
    case "product_sales": {
      const { from, to } = range(i);
      const order = i.sort === "qty" ? sql`qty desc` : i.sort === "profit" ? sql`profit desc` : sql`revenue desc`;
      const r = await db.execute<Row>(sql`
        with l as (
          select l.variant_id, sum(l.qty) as qty, sum(l.net_cents) as revenue
          from invoice_lines l join invoices i on i.id = l.invoice_id
          where i.number is not null and i.status <> 'DRAFT' and i.issue_date between ${from}::date and ${to}::date and l.variant_id is not null
          group by l.variant_id),
        c as (
          select m.variant_id, -sum(m.qty * m.unit_cost_cents) as cogs
          from stock_movements m join invoices i on i.id = m.ref_id
          where m.ref_type = 'invoice' and i.issue_date between ${from}::date and ${to}::date group by m.variant_id)
        select p.name_de, p.sku, v.size, v.color, l.qty, l.revenue, coalesce(c.cogs, 0) as cogs, l.revenue - coalesce(c.cogs, 0) as profit
        from l join variants v on v.id = l.variant_id join products p on p.id = v.product_id left join c on c.variant_id = l.variant_id
        where (${like(i.query)}::text is null or lower(p.name_de) like ${like(i.query)} or lower(p.sku) like ${like(i.query)})
        order by ${order} limit ${lim(i.limit)}`);
      return { from, to, products: r.rows.map((x) => ({ product: variantLabel(String(x.name_de), String(x.size), String(x.color)), sku: x.sku, qty: Number(x.qty), netSales: eur(x.revenue), cogs: eur(x.cogs), grossProfit: eur(x.profit) })) };
    }
    case "customer_sales": {
      const { from, to } = range(i);
      const r = await db.execute<Row>(sql`
        select c.number, c.name, count(*) filter (where i.kind = 'INVOICE')::int as invoices, sum(i.net_cents) as revenue
        from invoices i join customers c on c.id = i.customer_id
        where i.number is not null and i.status <> 'DRAFT' and i.issue_date between ${from}::date and ${to}::date
          and (${like(i.query)}::text is null or lower(c.name) like ${like(i.query)})
        group by c.id order by revenue desc limit ${lim(i.limit)}`);
      return { from, to, customers: r.rows.map((x) => ({ number: Number(x.number), name: x.name, invoices: x.invoices, netSales: eur(x.revenue) })) };
    }
    case "customer_account": {
      const q = String(i.query ?? "").trim();
      const r = await db.execute<Row>(sql`select id, number, name, country, credit_limit_cents, payment_term_days from customers
        where lower(name) like ${`%${q.toLowerCase()}%`} or number::text = ${q} order by name limit 5`);
      const out = [];
      for (const c of r.rows) {
        const items = await openItems(String(c.id));
        const last = await db.execute<Row>(sql`select number, issue_date, gross_cents, kind from invoices where customer_id = ${c.id} and number is not null order by issue_date desc, number desc limit 5`);
        out.push({
          number: Number(c.number), name: c.name, country: c.country, creditLimit: c.credit_limit_cents == null ? null : eur(c.credit_limit_cents), paymentTermDays: c.payment_term_days,
          open: eur(items.reduce((s, x) => s + x.state.openCents, 0)), overdue: eur(items.reduce((s, x) => s + x.state.overdueCents, 0)),
          openInvoices: items.map((x) => ({ number: x.number, open: eur(x.state.openCents), daysOverdue: x.state.daysOverdue, nextDue: x.state.nextDueDate })),
          lastInvoices: last.rows.map((x) => ({ number: x.number, date: String(x.issue_date).slice(0, 10), gross: eur(x.gross_cents), kind: x.kind })),
        });
      }
      return out.length ? out : { notFound: q };
    }
    case "stock_lookup": {
      const q = like(i.query) ?? "%";
      const r = await db.execute<Row>(sql`
        select p.name_de, p.name_nl, p.sku, v.size, v.color, v.barcode, v.stock_qty, v.min_stock, v.avg_cost_cents,
          coalesce(v.wholesale_price_cents, p.wholesale_price_cents) as wholesale, coalesce(v.retail_price_cents, p.retail_price_cents) as retail,
          coalesce((select sum(qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0)::int as reserved,
          (select min(expiry_date) from batches b where b.variant_id = v.id and b.qty_left > 0) as next_expiry
        from variants v join products p on p.id = v.product_id
        where v.active and (lower(p.name_de) like ${q} or lower(p.name_nl) like ${q} or lower(p.sku) like ${q} or coalesce(v.barcode, '') like ${q})
        order by p.name_de limit 15`);
      return r.rows.map((x) => ({ product: variantLabel(String(x.name_de), String(x.size), String(x.color)), nameNl: x.name_nl, sku: x.sku, barcode: x.barcode, stock: x.stock_qty, reserved: x.reserved, available: Number(x.stock_qty) - Number(x.reserved), minStock: x.min_stock, avgCost: eur(x.avg_cost_cents), wholesalePrice: eur(x.wholesale), retailPrice: eur(x.retail), nextExpiry: x.next_expiry ? String(x.next_expiry).slice(0, 10) : null }));
    }
    case "open_receivables": {
      const items = await openItems();
      return { totalOpen: eur(items.filter((x) => x.state.openCents > 0).reduce((s, x) => s + x.state.openCents, 0)),
        totalOverdue: eur(items.reduce((s, x) => s + x.state.overdueCents, 0)),
        invoices: items.slice(0, lim(i.limit, 25)).map((x) => ({ number: x.number, customer: x.customerName, open: eur(x.state.openCents), overdue: eur(x.state.overdueCents), daysOverdue: x.state.daysOverdue, nextDue: x.state.nextDueDate, reminders: x.dunningLevel })) };
    }
    case "expenses": {
      const { from, to } = range(i);
      const cat = typeof i.category === "string" && i.category ? i.category.toUpperCase() : null;
      const r = await db.execute<Row>(sql`select category::text as category, count(*)::int as n, sum(net_cents) as net from expenses
        where date between ${from}::date and ${to}::date and (${cat}::text is null or category::text = ${cat}) group by 1 order by net desc`);
      const top = await db.execute<Row>(sql`select date, vendor_name, category::text as category, net_cents from expenses
        where date between ${from}::date and ${to}::date and (${cat}::text is null or category::text = ${cat}) order by net_cents desc limit 10`);
      return { from, to, byCategory: r.rows.map((x) => ({ category: x.category, count: x.n, net: eur(x.net) })), largest: top.rows.map((x) => ({ date: String(x.date).slice(0, 10), vendor: x.vendor_name, category: x.category, net: eur(x.net_cents) })) };
    }
    case "stock_insights": {
      const s = await loadInsights();
      return {
        reorder: s.reorder.slice(0, 20).map((x) => ({ product: x.name, supplier: x.supplierName, available: x.available, daysLeft: x.daysLeft, suggestedQty: x.qty, urgency: x.urgency })),
        expiryRisk: s.expiry.slice(0, 20).map((x) => ({ product: x.name, expiry: x.expiry, atRiskQty: x.riskQty, atRiskValue: eur(x.riskCents), action: x.action })),
        slowMovers: s.slow.slice(0, 20).map((x) => ({ product: x.name, stock: x.stock, value: eur(x.valueCents), daysSinceLastReceipt: x.daysSinceReceipt })),
      };
    }
    default: throw new Error(`unknown tool ${name}`);
  }
}

const LANG: Record<string, string> = { de: "German", ar: "Arabic (simple, friendly Levantine Arabic as spoken in Syria/Lebanon; keep product names as they are)", en: "English" };

export function systemPrompt(locale: string, company: string) {
  return `You are the business assistant inside the inventory and invoicing system of "${company || "Start Style Friseurbedarf"}", a barber and hairdresser supply wholesaler in Datteln, Germany.
Today is ${todayIso()}. Sales channels: STORE (shop / direct sales), BRAND_SHOP (own brand online shop), GENERAL_SHOP (general online shop).
Answer ONLY with data from the tools. Never invent numbers. If the tools don't contain the answer, say so briefly and say what the user can check instead.
All amounts from tools are in EUR. Write money in German format like "1.234,56 €" and dates like "18.10.2026".
Be short and practical: 1–5 sentences or a short list. Give a concrete recommendation when it helps (e.g. reorder, call a customer).
You can only read data – you cannot change anything. For tax or legal questions, give the facts from the data and recommend asking the tax advisor.
Always answer in ${LANG[locale] ?? "German"}, without mixing in English words.`;
}

export async function ask(history: { role: "user" | "assistant"; text: string }[], locale: string, company: string) {
  const messages: Message[] = history.slice(-10).map((h) => ({ role: h.role, content: h.text }));
  const used: string[] = [];
  for (let round = 0; round < 6; round++) {
    const res = await callClaude({ system: systemPrompt(locale, company), messages, tools: TOOLS, max_tokens: 1500 });
    messages.push({ role: "assistant", content: res.content });
    const calls = res.content.filter((c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use");
    if (res.stop_reason !== "tool_use" || !calls.length) {
      return { answer: res.content.filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text").map((c) => c.text).join("\n").trim(), used };
    }
    const results: ContentBlock[] = [];
    for (const c of calls) {
      used.push(c.name);
      try {
        const out = JSON.stringify(await runTool(c.name, c.input ?? {}));
        results.push({ type: "tool_result", tool_use_id: c.id, content: out.length > 60_000 ? out.slice(0, 60_000) : out });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: c.id, content: `Error: ${(e as Error).message}`, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { answer: "", used };
}

/** Ausführlicher Monatsbericht mit Empfehlungen (KI), auf Basis derselben Zahlen wie der Bericht. */
export async function summarizeMonth(month: string, prevMonth: string, locale: string, company: string) {
  const [cur, prev, stock, recv] = await Promise.all([runTool("month_report", { month }), runTool("month_report", { month: prevMonth }), runTool("stock_insights", {}), runTool("open_receivables", { limit: 10 })]);
  const res = await callClaude({
    system: systemPrompt(locale, company), max_tokens: 1200,
    messages: [{ role: "user", content: `Write the monthly report for ${month} for the owner: a short paragraph (what went well, what not, compared to the previous month), then 3 concrete recommendations as a list. Plain language, no jargon.\n\nCURRENT MONTH:\n${JSON.stringify(cur)}\n\nPREVIOUS MONTH:\n${JSON.stringify(prev)}\n\nSTOCK:\n${JSON.stringify(stock)}\n\nRECEIVABLES:\n${JSON.stringify(recv)}` }],
  });
  return res.content.filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text").map((c) => c.text).join("\n").trim();
}
