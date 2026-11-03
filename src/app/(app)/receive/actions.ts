"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { receiveGoods, StockError } from "@/lib/stock";
import { parseWeight } from "@/lib/weight";
import { setVariantWeights } from "@/lib/variants";

export type ReceiveState = { error?: string; detail?: string; ok?: string; id?: string } | undefined;

const Line = z.object({
  variantId: z.string().min(1),
  qty: z.coerce.number().int().positive(),
  unitCostCents: z.coerce.number().int().min(0),
  batchNo: z.string().trim().max(60).default(""),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).default(""),
  // Gewicht einer Packung – vorbelegt, fehlendes kann hier nachgetragen werden
  weight: z.string().trim().max(20).default(""),
  weightUnit: z.enum(["g", "kg"]).default("g"),
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
  const weights = d.lines.map((l) => parseWeight(l.weight, l.weightUnit));
  if (weights.some((w) => w === undefined)) return { error: "weightInvalid" };
  try {
    const rec = await receiveGoods({
      supplierId: d.supplierId || null, date: d.date, supplierInvoiceNo: d.supplierInvoiceNo, note: d.note,
      lines: d.lines.map(({ weight: _w, weightUnit: _u, ...l }) => ({ ...l, expiryDate: l.expiryDate || null })),
    }, session.uid);
    // eingetragene/geänderte Gewichte an der Größe/Farbe speichern (mit Protokoll, dann an die Shops)
    await setVariantWeights(d.lines.flatMap((l, i) => (weights[i] ? [{ variantId: l.variantId, grams: weights[i]! }] : [])), session.uid);
    revalidatePath("/receive"); revalidatePath("/stock"); revalidatePath("/");
    return { ok: rec.number, id: rec.id };
  } catch (e) {
    if (e instanceof StockError) return { error: e.code, detail: e.detail };
    console.error(e);
    return { error: "error" };
  }
}
