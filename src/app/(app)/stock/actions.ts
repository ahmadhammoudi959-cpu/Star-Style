"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { adjustStock } from "@/lib/stock";

export type AdjustState = { error?: string; ok?: boolean } | undefined;

export async function adjust(_: AdjustState, fd: FormData): Promise<AdjustState> {
  const session = await requireSession();
  const p = z.object({ variantId: z.string().min(1), counted: z.coerce.number().int().min(0), reason: z.string().trim().min(2).max(300) })
    .safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  try {
    await adjustStock(p.data.variantId, p.data.counted, p.data.reason, session.uid);
  } catch (e) {
    console.error(e);
    return { error: "error" };
  }
  revalidatePath(`/stock/${p.data.variantId}`); revalidatePath("/stock"); revalidatePath("/");
  return { ok: true };
}
