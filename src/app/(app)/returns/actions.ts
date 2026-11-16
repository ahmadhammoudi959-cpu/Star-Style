"use server";
import { z } from "zod";
import { can, requirePerm } from "@/lib/auth";
import { bookReturn, REFUND_METHODS, ReturnError } from "@/lib/returns";
import { RETURN_REASONS } from "@/lib/returns-plan";
import { PaymentError } from "@/lib/payments";
import { SalesError } from "@/lib/sales";
import { StockError } from "@/lib/stock";

export type ReturnResult = { ok: true; id: string; number: string } | { ok: false; error: string; detail?: string };

const Input = z.object({
  invoiceId: z.string().min(1).max(100),
  reason: z.enum(RETURN_REASONS),
  note: z.string().max(1000).default(""),
  picks: z.array(z.object({
    lineId: z.string().min(1).max(100), restock: z.number().int().min(0).max(1_000_000), damaged: z.number().int().min(0).max(1_000_000),
  })).min(1).max(500),
  refund: z.object({ method: z.enum(REFUND_METHODS), amountCents: z.number().int().min(0).max(1_000_000_000) }).nullable(),
});

/**
 * Retoure buchen (Recht „Retouren“; Erstattung zusätzlich „Zahlungen erfassen“). Ohne revalidatePath – der Browser
 * öffnet danach die Retoure selbst (wie Versand/Shops: sonst hing die Übernahme des Seitenbaums ab und zu).
 */
export async function bookReturnAction(raw: unknown): Promise<ReturnResult> {
  const session = await requirePerm("sales.returns");
  const p = Input.safeParse(raw);
  if (!p.success) return { ok: false, error: p.error.issues.some((i) => i.path[0] === "reason") ? "reason" : "invalid" };
  const refund = p.data.refund && p.data.refund.amountCents > 0 ? p.data.refund : null;
  if (refund && !can(session, "payments.record")) return { ok: false, error: "noRefundRight" };
  try {
    const r = await bookReturn({ ...p.data, note: p.data.note.trim(), refund }, session.uid);
    return { ok: true, id: r.id, number: r.number };
  } catch (e) {
    if (e instanceof ReturnError) return { ok: false, error: e.code, detail: e.detail };
    if (e instanceof PaymentError) return { ok: false, error: e.code, detail: e.detail };
    if (e instanceof SalesError) return { ok: false, error: e.code, detail: e.detail };
    if (e instanceof StockError) return { ok: false, error: "stock", detail: e.code };
    console.error("return", e);
    return { ok: false, error: "error" };
  }
}
