"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { bookWriteOff, StockError } from "@/lib/stock";
import { storeUpload } from "@/lib/files";
import { schema } from "@/db";

export type WriteOffState = { error?: string; ok?: { id: string; number: string } } | undefined;

const Input = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.enum(schema.writeOffReason.enumValues),
  note: z.string().trim().max(1000).default(""),
  lines: z.string().transform((s) => JSON.parse(s)).pipe(z.array(z.object({
    variantId: z.string().min(1), qty: z.coerce.number().int().positive(), batchId: z.string().nullable().optional(),
  })).min(1)),
});

export async function submitWriteOff(_: WriteOffState, fd: FormData): Promise<WriteOffState> {
  const session = await requireSession();
  const p = Input.safeParse({ date: fd.get("date"), reason: fd.get("reason"), note: fd.get("note") ?? "", lines: fd.get("lines") });
  if (!p.success) return { error: "required" };
  try {
    const photoFileId = await storeUpload(fd.get("photo") as File | null);
    const wo = await bookWriteOff({ ...p.data, photoFileId }, session.uid);
    revalidatePath("/write-offs"); revalidatePath("/stock"); revalidatePath("/");
    return { ok: { id: wo.id, number: wo.number } };
  } catch (e) {
    if (e instanceof StockError) return { error: e.code };
    if (e instanceof Error && (e.message === "fileTooLarge" || e.message === "fileType")) return { error: e.message };
    console.error(e);
    return { error: "error" };
  }
}
