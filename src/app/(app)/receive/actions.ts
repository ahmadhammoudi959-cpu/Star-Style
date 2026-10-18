"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { receiveGoods, StockError } from "@/lib/stock";

export type ReceiveState = { error?: string; detail?: string; ok?: string } | undefined;

const Line = z.object({
  variantId: z.string().min(1),
  qty: z.coerce.number().int().positive(),
  unitCostCents: z.coerce.number().int().min(0),
  batchNo: z.string().trim().max(60).default(""),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default(""),
});
const Input = z.object({
  supplierId: z.string().default(""),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  supplierInvoiceNo: z.string().trim().max(80).default(""),
  note: z.string().trim().max(1000).default(""),
  lines: z.string().transform((s) => JSON.parse(s)).pipe(z.array(Line).min(1)),
});

export async function submitReceipt(_: ReceiveState, fd: FormData): Promise<ReceiveState> {
  const session = await requireSession();
  const parsed = Input.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: "required" };
  const d = parsed.data;
  try {
    const rec = await receiveGoods({
      supplierId: d.supplierId || null, date: d.date, supplierInvoiceNo: d.supplierInvoiceNo, note: d.note,
      lines: d.lines.map((l) => ({ ...l, expiryDate: l.expiryDate || null })),
    }, session.uid);
    revalidatePath("/receive"); revalidatePath("/stock"); revalidatePath("/");
    return { ok: rec.number };
  } catch (e) {
    if (e instanceof StockError) return { error: e.code, detail: e.detail };
    console.error(e);
    return { error: "error" };
  }
}
