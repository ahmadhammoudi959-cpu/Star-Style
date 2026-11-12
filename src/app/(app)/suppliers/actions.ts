"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { audit } from "@/lib/stock";

export type SupplierState = { error?: string } | undefined;

const S = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().max(200).default(""),
  email: z.string().trim().max(200).default(""),
  phone: z.string().trim().max(60).default(""),
  street: z.string().trim().max(200).default(""),
  zip: z.string().trim().max(20).default(""),
  city: z.string().trim().max(100).default(""),
  country: z.string().trim().length(2).transform((s) => s.toUpperCase()).default("DE"),
  vatId: z.string().trim().max(30).transform((s) => s.replace(/\s/g, "").toUpperCase()).default(""),
  notes: z.string().trim().max(2000).default(""),
  // Warenlieferant oder Firma aus Ausgaben – nur die Anzeige (Lieferanten/Wareneingang bzw. Ausgaben → Firmen)
  kind: z.enum(["GOODS", "EXPENSE"]).default("GOODS"),
});

export async function saveSupplier(_: SupplierState, fd: FormData): Promise<SupplierState> {
  const session = await requireSession();
  const p = S.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  const { id, ...v } = p.data;
  await db.transaction(async (tx) => {
    if (id) {
      const before = await tx.query.suppliers.findFirst({ where: eq(schema.suppliers.id, id) });
      await tx.update(schema.suppliers).set(v).where(eq(schema.suppliers.id, id));
      await audit(tx, { entity: "supplier", entityId: id, action: "update", before, after: v, userId: session.uid });
    } else {
      const [r] = await tx.insert(schema.suppliers).values(v).returning({ id: schema.suppliers.id });
      await audit(tx, { entity: "supplier", entityId: r.id, action: "create", after: v, userId: session.uid });
    }
  });
  revalidatePath("/suppliers");
  revalidatePath("/expenses/vendors");
  redirect(v.kind === "EXPENSE" ? "/expenses/vendors" : "/suppliers");
}
