"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { deleteExpense, ExpenseError, saveExpense } from "@/lib/expenses";
import { storeUpload } from "@/lib/files";
import { parseMoney } from "@/lib/money";
import { schema } from "@/db";

export type ExpenseState = { error?: string } | undefined;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Input = z.object({
  id: z.string().optional(),
  date, vendorName: z.string().trim().min(1).max(120), vendorCountry: z.string().trim().length(2), vendorVatId: z.string().trim().max(20).default(""),
  invoiceNo: z.string().trim().max(60).default(""),
  category: z.enum(schema.expenseCategory.enumValues), taxCase: z.enum(schema.expenseTaxCase.enumValues),
  channel: z.enum(["", ...schema.channel.enumValues]).transform((v) => (v === "" ? null : v)),
  amount: z.string(), vatRateBp: z.coerce.number().int(),
  paid: z.string().optional().transform((v) => v === "on"),
  paidAt: z.string().optional().transform((v) => v || null),
  paymentMethod: z.enum(["", ...schema.paymentMethod.enumValues]).optional().transform((v) => (v ? v : null)),
  note: z.string().max(1000).default(""),
});

export async function saveExpenseAction(_: ExpenseState, fd: FormData): Promise<ExpenseState> {
  const s = await requireSession();
  const raw = Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
  const p = Input.safeParse(raw);
  if (!p.success) {
    const f = p.error.issues[0]?.path[0];
    return { error: f === "vendorName" ? "vendor" : f === "date" ? "date" : "required" };
  }
  const amountCents = parseMoney(p.data.amount);
  if (amountCents == null || amountCents <= 0) return { error: "amount" };
  let id: string;
  try {
    const file = fd.get("file");
    const fileId = file instanceof File && file.size > 0 ? await storeUpload(file) : undefined;
    id = await saveExpense({
      id: p.data.id || undefined, date: p.data.date, vendorName: p.data.vendorName, vendorCountry: p.data.vendorCountry, vendorVatId: p.data.vendorVatId,
      invoiceNo: p.data.invoiceNo, category: p.data.category, taxCase: p.data.taxCase, channel: p.data.channel,
      amountCents, vatRateBp: p.data.taxCase === "NO_VAT" ? 0 : p.data.vatRateBp,
      paid: p.data.paid, paidAt: p.data.paidAt, paymentMethod: p.data.paymentMethod, fileId, note: p.data.note,
    }, s.uid);
  } catch (e) {
    if (e instanceof ExpenseError) return { error: e.code };
    if (e instanceof Error && (e.message === "fileTooLarge" || e.message === "fileType")) return { error: e.message };
    console.error(e);
    return { error: "error" };
  }
  revalidatePath("/expenses"); revalidatePath("/reports");
  redirect(`/expenses?month=${p.data.date.slice(0, 7)}&saved=${id}`);
}

export async function deleteExpenseAction(_: ExpenseState, fd: FormData): Promise<ExpenseState> {
  const s = await requireSession();
  const id = String(fd.get("id"));
  const month = String(fd.get("month") ?? "");
  try { await deleteExpense(id, s.uid); } catch (e) {
    if (e instanceof ExpenseError) return { error: e.code };
    console.error(e); return { error: "error" };
  }
  revalidatePath("/expenses"); revalidatePath("/reports");
  redirect(`/expenses${month ? `?month=${month}` : ""}`);
}
