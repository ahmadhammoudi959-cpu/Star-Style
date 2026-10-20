import "server-only";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { paymentState, trafficLight, type PaymentState } from "./payment-status";
import { todayIso } from "./dates";

export type OpenRow = {
  invoiceId: string; number: string; customerId: string; customerName: string; issueDate: string; grossCents: number;
  state: PaymentState; light: ReturnType<typeof trafficLight>; dunningLevel: number;
};

/** Alle Rechnungen mit offenem Betrag oder Guthaben (inkl. stornierter Rechnungen mit Zahlungen). */
export async function openItems(customerId?: string): Promise<OpenRow[]> {
  const today = todayIso();
  const rows = await db.query.invoices.findMany({
    where: and(
      eq(schema.invoices.kind, "INVOICE"), isNotNull(schema.invoices.number), inArray(schema.invoices.status, ["ISSUED", "CANCELLED"]),
      customerId ? eq(schema.invoices.customerId, customerId) : undefined,
    ),
    with: { payments: true, installments: true, dunnings: true },
  });
  const out: OpenRow[] = [];
  for (const inv of rows) {
    // stornierte Rechnung: nichts mehr geschuldet; nur noch Zahlungen zählen (→ Guthaben)
    const gross = inv.status === "CANCELLED" ? 0 : inv.grossCents;
    const state = paymentState({ ...inv, grossCents: gross, installments: inv.status === "CANCELLED" ? [] : inv.installments }, today);
    if (state.openCents === 0) continue;
    out.push({
      invoiceId: inv.id, number: inv.number!, customerId: inv.customerId, customerName: inv.custName, issueDate: inv.issueDate!,
      grossCents: gross, state, light: trafficLight(state, today), dunningLevel: inv.dunnings.length,
    });
  }
  // überfällig zuerst (nach Tagen), dann nach nächster Fälligkeit
  return out.sort((a, b) => b.state.daysOverdue - a.state.daysOverdue || (a.state.nextDueDate ?? "9").localeCompare(b.state.nextDueDate ?? "9"));
}

/** Offener Saldo je Kunde (für Kreditlimit-Warnung). */
export async function customerOpenBalances(): Promise<Map<string, number>> {
  const r = await db.execute<{ customer_id: string; open: string }>(sql`
    select c.id as customer_id,
      coalesce((select sum(gross_cents) from invoices i where i.customer_id = c.id and i.kind = 'INVOICE' and i.status = 'ISSUED'), 0)
      - coalesce((select sum(p.amount_cents + p.skonto_cents) from payments p join invoices i on i.id = p.invoice_id where i.customer_id = c.id and p.cancelled_at is null), 0) as open
    from customers c`);
  return new Map(r.rows.map((x) => [String(x.customer_id), Number(x.open)]));
}

export type StatementRow = { date: string; kind: "invoice" | "cancellation" | "payment" | "skonto" | "payment_cancelled"; ref: string; refId: string; text: string; amountCents: number; balanceCents: number };

/** Kontoauszug: Rechnungen (+), Stornos (−), Zahlungen (−), stornierte Zahlungen (+), mit laufendem Saldo. */
export async function customerStatement(customerId: string): Promise<StatementRow[]> {
  const invs = await db.query.invoices.findMany({
    where: and(eq(schema.invoices.customerId, customerId), isNotNull(schema.invoices.number)),
    with: { payments: true },
  });
  const events: Omit<StatementRow, "balanceCents">[] = [];
  for (const i of invs) {
    events.push({ date: i.issueDate!, kind: i.kind === "CANCELLATION" ? "cancellation" : "invoice", ref: i.number!, refId: i.id, text: "", amountCents: i.grossCents });
    for (const p of i.payments) {
      events.push({ date: p.date, kind: "payment", ref: p.number, refId: i.id, text: i.number!, amountCents: -p.amountCents });
      if (p.skontoCents) events.push({ date: p.date, kind: "skonto", ref: p.number, refId: i.id, text: i.number!, amountCents: -p.skontoCents });
      if (p.cancelledAt) events.push({ date: p.cancelledAt.toISOString().slice(0, 10), kind: "payment_cancelled", ref: p.number, refId: i.id, text: p.cancelReason, amountCents: p.amountCents + p.skontoCents });
    }
  }
  const order = { invoice: 0, cancellation: 1, payment: 2, skonto: 3, payment_cancelled: 4 };
  events.sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.ref.localeCompare(b.ref));
  let bal = 0;
  return events.map((e) => ({ ...e, balanceCents: (bal += e.amountCents) }));
}
