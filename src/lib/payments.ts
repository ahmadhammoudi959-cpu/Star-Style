/**
 * Zahlungen, Ratenpläne, Mahnungen.
 * Zahlungen werden nie gelöscht – nur storniert (mit Grund), damit alles nachvollziehbar bleibt.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { nextNumber } from "./numbering";
import { audit } from "./stock";
import { paymentState } from "./payment-status";
import { addDaysIso, todayIso } from "./dates";
import { assertOpen } from "./periods";
import { skontoMax, skontoSplit } from "./tax";

export class PaymentError extends Error {
  constructor(public code: string, public detail?: string) { super(code); }
}

type Method = (typeof schema.paymentMethod.enumValues)[number];

async function loadState(tx: Tx | typeof db, invoiceId: string) {
  const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { payments: true, installments: true } });
  if (!inv) throw new PaymentError("notFound");
  return { inv, state: paymentState(inv, todayIso()) };
}

/** Bis wann Skonto gilt (Rechnungsdatum + Skontotage), sonst null */
export function skontoDeadline(inv: { skontoBp: number; skontoDays: number; issueDate: string | null }) {
  return inv.skontoBp > 0 && inv.skontoDays > 0 && inv.issueDate ? addDaysIso(inv.issueDate, inv.skontoDays) : null;
}

export async function recordPaymentTx(tx: Tx, p: { invoiceId: string; date: string; amountCents: number; method: Method; note?: string; userId?: string; allowOverpay?: boolean; withSkonto?: boolean }) {
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw new PaymentError("amountInvalid");
  await tx.execute(sql`select id from invoices where id = ${p.invoiceId} for update`);
  const { inv, state } = await loadState(tx, p.invoiceId);
  if (inv.status !== "ISSUED" || inv.kind !== "INVOICE") throw new PaymentError("notPayable");
  try { await assertOpen(tx, p.date); } catch { throw new PaymentError("periodLocked"); }

  // Skonto: Kunde zahlt fristgerecht den Rest abzüglich Skonto → Differenz wird als Skonto ausgebucht
  let skonto = { skontoCents: 0, skontoNetCents: 0, skontoBreakdown: [] as { rateBp: number; netCents: number; vatCents: number }[] };
  if (p.withSkonto) {
    const deadline = skontoDeadline(inv);
    if (!deadline) throw new PaymentError("noSkonto");
    if (p.date > deadline) throw new PaymentError("skontoExpired", deadline);
    const already = inv.payments.filter((x) => !x.cancelledAt).reduce((s, x) => s + x.skontoCents, 0);
    const diff = state.openCents - p.amountCents;
    const max = skontoMax(inv.grossCents, inv.skontoBp) - already;
    if (diff <= 0 || diff > max) throw new PaymentError("skontoAmount", String(state.openCents - max));
    const parts = skontoSplit(diff, inv.vatBreakdown);
    skonto = { skontoCents: diff, skontoNetCents: parts.reduce((s, g) => s + g.netCents, 0), skontoBreakdown: parts };
  } else if (!p.allowOverpay && p.amountCents > state.openCents) throw new PaymentError("overpay", String(state.openCents));

  const number = await nextNumber(tx, "PAYMENT", Number(p.date.slice(0, 4)));
  const [row] = await tx.insert(schema.payments).values({
    number, invoiceId: p.invoiceId, date: p.date, amountCents: p.amountCents, method: p.method, note: p.note ?? "", ...skonto,
  }).returning();
  await audit(tx, { entity: "payment", entityId: row.id, action: "create", after: row, userId: p.userId });
  return row;
}

export async function recordPayment(p: Parameters<typeof recordPaymentTx>[1]) {
  return db.transaction((tx) => recordPaymentTx(tx, p));
}

export async function cancelPayment(paymentId: string, reason: string, userId?: string) {
  if (reason.trim().length < 2) throw new PaymentError("reason");
  await db.transaction(async (tx) => {
    const p = await tx.query.payments.findFirst({ where: eq(schema.payments.id, paymentId) });
    if (!p) throw new PaymentError("notFound");
    if (p.cancelledAt) throw new PaymentError("alreadyCancelled");
    await tx.update(schema.payments).set({ cancelledAt: new Date(), cancelReason: reason.trim() }).where(eq(schema.payments.id, paymentId));
    await audit(tx, { entity: "payment", entityId: paymentId, action: "cancel", before: p, after: { reason }, userId });
  });
}

/** Ratenplan festlegen. Summe muss genau dem Rechnungsbetrag entsprechen. Leere Liste = kein Plan. */
export async function setInstallments(invoiceId: string, plan: { dueDate: string; amountCents: number }[], userId?: string) {
  await db.transaction(async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { installments: true } });
    if (!inv) throw new PaymentError("notFound");
    if (inv.kind !== "INVOICE" || inv.status === "CANCELLED") throw new PaymentError("notPayable");
    validatePlan(plan, inv.grossCents);
    await tx.delete(schema.installments).where(eq(schema.installments.invoiceId, invoiceId));
    if (plan.length) await tx.insert(schema.installments).values(plan.map((r) => ({ invoiceId, ...r })));
    if (plan.length) await tx.update(schema.invoices).set({ dueDate: plan[plan.length - 1].dueDate }).where(and(eq(schema.invoices.id, invoiceId), eq(schema.invoices.status, "ISSUED")));
    await audit(tx, { entity: "invoice", entityId: invoiceId, action: "installments", before: inv.installments, after: plan, userId });
  });
}

export function validatePlan(plan: { dueDate: string; amountCents: number }[], grossCents: number) {
  if (!plan.length) return;
  if (plan.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) || !Number.isInteger(r.amountCents) || r.amountCents <= 0)) throw new PaymentError("planInvalid");
  const sum = plan.reduce((s, r) => s + r.amountCents, 0);
  if (sum !== grossCents) throw new PaymentError("planSum", String(grossCents - sum));
  for (let i = 1; i < plan.length; i++) if (plan[i].dueDate < plan[i - 1].dueDate) throw new PaymentError("planOrder");
}

/**
 * Wird beim Ausstellen einer Korrekturrechnung aufgerufen:
 * Zahlungen der alten Rechnung wandern auf die neue (Kunde hat ja schon gezahlt).
 */
export async function movePayments(tx: Tx, fromInvoiceId: string, toInvoiceId: string, userId?: string) {
  const moved = await tx.update(schema.payments).set({ invoiceId: toInvoiceId, movedFromInvoiceId: fromInvoiceId })
    .where(and(eq(schema.payments.invoiceId, fromInvoiceId), isNull(schema.payments.cancelledAt))).returning({ id: schema.payments.id });
  if (moved.length) await audit(tx, { entity: "invoice", entityId: toInvoiceId, action: "payments_moved", after: { from: fromInvoiceId, count: moved.length }, userId });
}

/** Ratenplan an neuen Bruttobetrag anpassen (Korrektur): Differenz auf die letzte Rate, sonst Plan verwerfen. */
export async function fitPlanToGross(tx: Tx, invoiceId: string, grossCents: number) {
  const plan = await tx.select().from(schema.installments).where(eq(schema.installments.invoiceId, invoiceId)).orderBy(asc(schema.installments.dueDate));
  if (!plan.length) return;
  const diff = grossCents - plan.reduce((s, r) => s + r.amountCents, 0);
  if (diff === 0) return;
  const last = plan[plan.length - 1];
  if (last.amountCents + diff > 0) await tx.update(schema.installments).set({ amountCents: last.amountCents + diff }).where(eq(schema.installments.id, last.id));
  else await tx.delete(schema.installments).where(eq(schema.installments.invoiceId, invoiceId));
}

// ───────────────────────── Mahnwesen ─────────────────────────

export const DUNNING_LEVELS = [
  { level: 1, title: "Zahlungserinnerung", days: 7, feeCents: 0 },
  { level: 2, title: "1. Mahnung", days: 7, feeCents: 0 },
  { level: 3, title: "2. Mahnung", days: 7, feeCents: 0 },
] as const;

export async function createDunning(invoiceId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const { inv, state } = await loadState(tx, invoiceId);
    if (inv.status !== "ISSUED" || inv.kind !== "INVOICE") throw new PaymentError("notPayable");
    if (state.overdueCents <= 0) throw new PaymentError("notOverdue");
    const prev = await tx.select().from(schema.dunnings).where(eq(schema.dunnings.invoiceId, invoiceId));
    const level = Math.min(prev.length + 1, DUNNING_LEVELS.length);
    const cfg = DUNNING_LEVELS[level - 1];
    const today = todayIso();
    const [d] = await tx.insert(schema.dunnings).values({
      invoiceId, level, date: today, openCents: state.overdueCents, feeCents: cfg.feeCents, newDueDate: addDaysIso(today, cfg.days),
    }).returning();
    await audit(tx, { entity: "invoice", entityId: invoiceId, action: "dunning", after: d, userId });
    return d;
  });
}
