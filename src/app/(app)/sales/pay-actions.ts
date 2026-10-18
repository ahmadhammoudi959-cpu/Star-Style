"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { cancelPayment, createDunning, PaymentError, recordPayment, setInstallments } from "@/lib/payments";
import { parseMoney } from "@/lib/money";

export type PayState = { error?: string; detail?: string; ok?: boolean } | undefined;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function fail(e: unknown): PayState {
  if (e instanceof PaymentError) return { error: e.code, detail: e.detail };
  console.error(e);
  return { error: "error" };
}
function done(invoiceId: string): PayState {
  revalidatePath(`/sales/invoices/${invoiceId}`); revalidatePath("/receivables"); revalidatePath("/");
  return { ok: true };
}

export async function addPaymentAction(_: PayState, fd: FormData): Promise<PayState> {
  const s = await requireSession();
  const p = z.object({ invoiceId: z.string().min(1), date, amount: z.string(), method: z.enum(["CASH", "BANK", "CARD", "ONLINE"]), note: z.string().max(500).default("") })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  const amountCents = parseMoney(p.data.amount);
  if (amountCents == null || amountCents <= 0) return { error: "amountInvalid" };
  try { await recordPayment({ ...p.data, amountCents, userId: s.uid }); } catch (e) { return fail(e); }
  return done(p.data.invoiceId);
}

export async function cancelPaymentAction(_: PayState, fd: FormData): Promise<PayState> {
  const s = await requireSession();
  const invoiceId = String(fd.get("invoiceId"));
  try { await cancelPayment(String(fd.get("paymentId")), String(fd.get("reason") ?? ""), s.uid); } catch (e) { return fail(e); }
  return done(invoiceId);
}

export async function savePlanAction(_: PayState, fd: FormData): Promise<PayState> {
  const s = await requireSession();
  const invoiceId = String(fd.get("invoiceId"));
  const plan = z.array(z.object({ dueDate: date, amountCents: z.number().int() })).safeParse(JSON.parse(String(fd.get("plan") ?? "[]")));
  if (!plan.success) return { error: "planInvalid" };
  try { await setInstallments(invoiceId, plan.data, s.uid); } catch (e) { return fail(e); }
  return done(invoiceId);
}

export async function dunningAction(_: PayState, fd: FormData): Promise<PayState> {
  const s = await requireSession();
  const invoiceId = String(fd.get("invoiceId"));
  try { await createDunning(invoiceId, s.uid); } catch (e) { return fail(e); }
  return done(invoiceId);
}
