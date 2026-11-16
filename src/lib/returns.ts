/**
 * Retouren buchen (Wunsch Inhaber 16.11.2026: „تسجيل المرتجعات“) – ein Schritt, eine Transaktion:
 * 1. Nummer RT-JJJJ-NNNN (lückenlos).
 * 2. Teilretoure: Korrektur mit den behaltenen Mengen (gleiche Preise, Rabatte, Steuer) ausstellen = Storno der alten
 *    Rechnung (Ware zurück mit Charge/MHD und EK wie verkauft) + neue Rechnung (behaltene Ware wieder ab); Zahlungen und
 *    Sendungen wandern mit, die Fälligkeit bleibt die alte. Alles zurück: nur Storno.
 * 3. Beschädigte Ware → Verlust (AB-, Grund „Beschädigung“) aus den zurückgekommenen Chargen.
 * 4. Erstattung bar/Überweisung/Karte → Zahlung mit negativem Betrag (höchstens das Guthaben); sonst bleibt es Guthaben.
 * Shop-Bestellungen nicht hier: die Erstattung läuft über den Shop (Geld zurück auf Karte/PayPal), der Abgleich übernimmt
 * Storno/Korrektur dann von selbst (src/lib/shopify/sync.ts).
 */
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { nextNumber } from "./numbering";
import { audit, bookWriteOffTx } from "./stock";
import { cancelInTx, createDraft, issueInvoiceTx } from "./sales";
import { creditOf, recordRefundTx } from "./payments";
import { todayIso } from "./dates";
import { allocateDamaged, planReturn, type PlanInvoice, type PlanPick, type ReturnReason } from "./returns-plan";

export class ReturnError extends Error {
  constructor(public code: string, public detail?: string) { super(code); }
}

export const REFUND_METHODS = ["CASH", "BANK", "CARD"] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];

export type ReturnInput = {
  invoiceId: string; reason: ReturnReason; note: string; picks: PlanPick[];
  refund: { method: RefundMethod; amountCents: number } | null;
};

type InvoiceRow = typeof schema.invoices.$inferSelect & {
  lines: (typeof schema.invoiceLines.$inferSelect)[];
  payments: (typeof schema.payments.$inferSelect)[];
};

/** Warum diese Rechnung (noch) keine Retoure bekommen kann – null = geht */
export function returnBlock(inv: { kind: string; status: string; externalOrderId: string | null }): "notIssued" | "shopOrder" | null {
  if (inv.kind !== "INVOICE" || inv.status !== "ISSUED") return "notIssued";
  if (inv.externalOrderId) return "shopOrder";
  return null;
}

export function toPlanInvoice(inv: InvoiceRow): PlanInvoice {
  return {
    grossCents: inv.grossCents, discountBp: inv.discountBp, pricesGross: inv.pricesGross,
    paidCents: inv.payments.filter((p) => !p.cancelledAt).reduce((s, p) => s + p.amountCents, 0),
    lines: inv.lines.map((l) => ({
      id: l.id, position: l.position, variantId: l.variantId, description: l.description, qty: l.qty,
      unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp, externalLineId: l.externalLineId,
    })),
  };
}

/** Offener Korrekturentwurf („Bearbeiten“ angefangen)? Dann erst den Entwurf ausstellen oder löschen. */
async function openCorrection(tx: Tx | typeof db, invoiceId: string) {
  return tx.query.invoices.findFirst({
    where: and(eq(schema.invoices.replacesInvoiceId, invoiceId), eq(schema.invoices.status, "DRAFT")), columns: { id: true },
  });
}

/** Für das Formular: Rechnung mit Positionen, Zahlungen und schon zurückgegebenen Mengen früherer Retouren */
export async function invoiceForReturn(invoiceId: string) {
  const inv = await db.query.invoices.findFirst({
    where: eq(schema.invoices.id, invoiceId), with: { lines: true, payments: true, customer: true },
  });
  if (!inv) return null;
  const draft = await openCorrection(db, invoiceId);
  return { inv, block: returnBlock(inv), draftId: draft?.id ?? null, plan: toPlanInvoice(inv) };
}

export async function bookReturn(input: ReturnInput, userId?: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from invoices where id = ${input.invoiceId} for update`);
    const inv = await tx.query.invoices.findFirst({
      where: eq(schema.invoices.id, input.invoiceId), with: { lines: true, payments: true, installments: true },
    });
    if (!inv) throw new ReturnError("notFound");
    const block = returnBlock(inv);
    if (block) throw new ReturnError(block);
    const draft = await openCorrection(tx, inv.id);
    if (draft) throw new ReturnError("correctionOpen", draft.id);
    const plan = planReturn(toPlanInvoice(inv), input.picks);
    if (!plan.ok) throw new ReturnError(plan.error, plan.lineId);
    const refund = input.refund && input.refund.amountCents > 0 ? input.refund : null;
    if (refund && (!Number.isInteger(refund.amountCents) || refund.amountCents > plan.refundableCents)) throw new ReturnError("refundTooHigh", String(plan.refundableCents));

    const today = todayIso();
    const number = await nextNumber(tx, "RETURN", Number(today.slice(0, 4)));
    const tag = `Retoure ${number}`;

    // 2) Storno (+ neue Rechnung mit den behaltenen Mengen)
    let cancellationId: string;
    let correctionId: string | null = null;
    let newGross = 0;
    if (plan.full) {
      cancellationId = await cancelInTx(tx, inv.id, userId, undefined, { note: tag });
    } else {
      correctionId = await createDraft(tx, {
        customerId: inv.customerId, replacesInvoiceId: inv.id, channel: inv.channel, deliveryDate: inv.deliveryDate,
        discountBp: inv.discountBp, retentionOfTitle: inv.retentionOfTitle,
        notes: [inv.notes, `Korrektur nach Warenrücknahme ${number} zu Rechnung ${inv.number}.`].filter(Boolean).join("\n"),
        installments: [...inv.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((r) => ({ dueDate: r.dueDate, amountCents: r.amountCents })),
        pricesGross: inv.pricesGross, externalOrderId: inv.externalOrderId,
        // Steuer wie auf der zurückgegebenen Rechnung – die Retoure bezieht sich auf diesen Verkauf
        taxOverride: { mode: inv.taxMode, ossCountry: inv.ossCountry },
        lines: plan.keep.map((l) => ({
          variantId: l.variantId, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents,
          discountBp: l.discountBp, vatRateBp: l.vatRateBp, externalLineId: l.externalLineId ?? null,
        })),
      });
      const r = await issueInvoiceTx(tx, correctionId, userId, { allowNegativeStock: true, cancelNote: tag });
      if (!r.cancellationId) throw new ReturnError("error", "noCancellation");
      cancellationId = r.cancellationId;
      const issued = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, correctionId), with: { installments: true } });
      newGross = issued?.grossCents ?? 0;
      // gleiche Zahlungsfrist wie vorher (eine Retoure verlängert das Zahlungsziel nicht)
      if (issued && !issued.installments.length && inv.dueDate) {
        await tx.update(schema.invoices).set({ dueDate: inv.dueDate }).where(eq(schema.invoices.id, correctionId));
      }
    }

    // 3) beschädigt → Verlust aus den gerade zurückgekommenen Chargen
    let writeOffId: string | null = null;
    const damaged = new Map<string, number>();
    for (const x of plan.lines) if (x.condition === "DAMAGED" && x.line.variantId) damaged.set(x.line.variantId, (damaged.get(x.line.variantId) ?? 0) + x.qty);
    if (damaged.size) {
      const woLines: { variantId: string; qty: number; batchId: string | null }[] = [];
      for (const [variantId, qty] of damaged) {
        const bs = await tx.execute<{ id: string; qty_left: number }>(sql`
          select b.id, b.qty_left from stock_movements m join batches b on b.id = m.batch_id
          where m.ref_type = 'invoice' and m.ref_id = ${cancellationId} and m.type = 'CANCEL' and m.variant_id = ${variantId}
          order by b.expiry_date asc nulls last, b.received_at asc`);
        for (const a of allocateDamaged(qty, bs.rows.map((b) => ({ id: String(b.id), qtyLeft: Number(b.qty_left) })))) woLines.push({ variantId, ...a });
      }
      const wo = await bookWriteOffTx(tx, { date: today, reason: "DAMAGE", note: `${tag} · ${inv.number} · ${inv.custName}`, lines: woLines }, userId);
      writeOffId = wo.id;
    }

    // 4) Erstattung
    let refundPaymentId: string | null = null;
    if (refund) {
      const pay = await recordRefundTx(tx, {
        invoiceId: correctionId ?? inv.id, date: today, amountCents: refund.amountCents, method: refund.method, note: `Erstattung ${tag}`, userId,
      });
      refundPaymentId = pay.id;
    }

    const [ret] = await tx.insert(schema.returns).values({
      number, date: today, invoiceId: inv.id, cancellationId, correctionId, customerId: inv.customerId,
      reason: input.reason, note: input.note.trim().slice(0, 1000), creditCents: Math.max(inv.grossCents - newGross, 0),
      refundCents: refund?.amountCents ?? 0, refundMethod: refund?.method ?? null, refundPaymentId, writeOffId, createdBy: userId ?? null,
    }).returning();
    await tx.insert(schema.returnLines).values(plan.lines.map((x, i) => ({
      returnId: ret.id, position: i + 1, invoiceLineId: x.line.id, variantId: x.line.variantId, description: x.line.description,
      qty: x.qty, condition: x.condition,
    })));
    await audit(tx, {
      entity: "return", entityId: ret.id, action: "create",
      after: { ...input, number, invoice: inv.number, cancellationId, correctionId, writeOffId, refundPaymentId, creditCents: ret.creditCents }, userId,
    });
    return { id: ret.id, number, cancellationId, correctionId };
  });
}

// ───────────────────────── Anzeigen ─────────────────────────

export async function listReturns(o: { q?: string; limit?: number } = {}) {
  const q = (o.q ?? "").trim();
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db.select({
    id: schema.returns.id, number: schema.returns.number, date: schema.returns.date, reason: schema.returns.reason,
    creditCents: schema.returns.creditCents, refundCents: schema.returns.refundCents, refundMethod: schema.returns.refundMethod,
    invoiceId: schema.returns.invoiceId, correctionId: schema.returns.correctionId, writeOffId: schema.returns.writeOffId,
    customerId: schema.returns.customerId, customerName: schema.customers.name, customerNo: schema.customers.number,
    invoiceNumber: schema.invoices.number,
    units: sql<number>`(select coalesce(sum(qty), 0)::int from return_lines l where l.return_id = ${schema.returns.id})`,
    damaged: sql<number>`(select coalesce(sum(qty), 0)::int from return_lines l where l.return_id = ${schema.returns.id} and l.condition = 'DAMAGED')`,
  }).from(schema.returns)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.returns.customerId))
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.returns.invoiceId))
    .where(q ? or(
      ilike(schema.returns.number, like), ilike(schema.customers.name, like), ilike(schema.invoices.number, like),
      sql`exists (select 1 from return_lines l left join variants v on v.id = l.variant_id left join products p on p.id = v.product_id
        where l.return_id = ${schema.returns.id} and (l.description ilike ${like} or v.barcode ilike ${like} or p.sku ilike ${like}))`,
    ) : undefined)
    .orderBy(desc(schema.returns.date), desc(schema.returns.number))
    .limit(o.limit ?? 200);
  return rows.map((r) => ({ ...r, units: Number(r.units), damaged: Number(r.damaged) }));
}

export async function getReturn(id: string) {
  const r = await db.query.returns.findFirst({ where: eq(schema.returns.id, id), with: { lines: true, customer: true } });
  if (!r) return null;
  const nums = await db.select({ id: schema.invoices.id, number: schema.invoices.number }).from(schema.invoices)
    .where(inArray(schema.invoices.id, [r.invoiceId, r.cancellationId, r.correctionId].filter((x): x is string => Boolean(x))));
  const num = (x: string | null) => (x ? nums.find((n) => n.id === x)?.number ?? null : null);
  const wo = r.writeOffId ? await db.query.writeOffs.findFirst({ where: eq(schema.writeOffs.id, r.writeOffId), columns: { id: true, number: true } }) : null;
  const pay = r.refundPaymentId ? await db.query.payments.findFirst({ where: eq(schema.payments.id, r.refundPaymentId), columns: { id: true, number: true, cancelledAt: true } }) : null;
  const variants = r.lines.flatMap((l) => (l.variantId ? [l.variantId] : []));
  const codes = variants.length
    ? await db.select({ id: schema.variants.id, barcode: schema.variants.barcode, sku: schema.products.sku }).from(schema.variants)
      .innerJoin(schema.products, eq(schema.products.id, schema.variants.productId)).where(inArray(schema.variants.id, variants))
    : [];
  // Guthaben, das jetzt noch beim Kunden steht (auf der neuen bzw. stornierten Rechnung) – auszahlbar an der Rechnung
  const target = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, r.correctionId ?? r.invoiceId), with: { payments: true } });
  return {
    ...r,
    openCreditCents: target ? creditOf(target) : 0, creditInvoiceId: target?.id ?? null,
    lines: [...r.lines].sort((a, b) => a.position - b.position).map((l) => ({ ...l, code: codes.find((c) => c.id === l.variantId) ?? null })),
    invoiceNumber: num(r.invoiceId), cancellationNumber: num(r.cancellationId), correctionNumber: num(r.correctionId),
    writeOff: wo ?? null, refundPayment: pay ?? null,
  };
}

/** Retouren, die zu einer Rechnung gehören (als zurückgegebene oder als daraus entstandene neue Rechnung) */
export async function returnsOfInvoice(invoiceId: string) {
  return db.select({ id: schema.returns.id, number: schema.returns.number, date: schema.returns.date, creditCents: schema.returns.creditCents, refundCents: schema.returns.refundCents })
    .from(schema.returns)
    .where(or(eq(schema.returns.invoiceId, invoiceId), eq(schema.returns.correctionId, invoiceId)))
    .orderBy(desc(schema.returns.number));
}
