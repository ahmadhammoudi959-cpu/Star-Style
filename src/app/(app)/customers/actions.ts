"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { parseMoney } from "@/lib/money";
import { audit } from "@/lib/stock";
import { checkBzst, checkVies, splitVatId, type VatCheckResult } from "@/lib/vat-check";

export type CustomerState = { error?: string } | undefined;

const C = z.object({
  id: z.string().optional(),
  type: z.enum(["COMPANY", "PERSON"]),
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().max(200).default(""),
  email: z.string().trim().max(200).default(""),
  phone: z.string().trim().max(60).default(""),
  street: z.string().trim().max(200).default(""),
  zip: z.string().trim().max(20).default(""),
  city: z.string().trim().max(100).default(""),
  country: z.string().trim().length(2).transform((s) => s.toUpperCase()),
  vatId: z.string().trim().max(30).transform((s) => s.replace(/[\s.-]/g, "").toUpperCase()).default(""),
  vatPending: z.string().optional().transform((v) => v === "on"),
  priceGroup: z.enum(["WHOLESALE", "RETAIL"]),
  creditLimit: z.string().default(""),
  paymentTermDays: z.string().default(""),
  notes: z.string().trim().max(2000).default(""),
});

export async function saveCustomer(_: CustomerState, fd: FormData): Promise<CustomerState> {
  const session = await requireSession();
  const p = C.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  const { id, vatPending, creditLimit, paymentTermDays, ...d } = p.data;
  if (d.vatId && !splitVatId(d.vatId)) return { error: "vatFormat" };
  const limit = creditLimit.trim() ? parseMoney(creditLimit) : null;
  if (creditLimit.trim() && limit == null) return { error: "required" };
  const days = paymentTermDays.trim() ? Number(paymentTermDays) : null;

  let cid = id;
  await db.transaction(async (tx) => {
    const before = id ? await tx.query.customers.findFirst({ where: eq(schema.customers.id, id) }) : undefined;
    // Status der USt-IdNr.: geänderte Nummer muss neu geprüft werden
    let vatIdStatus: "NONE" | "PENDING" | "VALID" | "INVALID" = before?.vatIdStatus ?? "NONE";
    if (!before || before.vatId !== d.vatId) vatIdStatus = "NONE"; // neue Nummer → neu prüfen
    if (vatPending && !d.vatId) vatIdStatus = "PENDING";
    if (!vatPending && vatIdStatus === "PENDING") vatIdStatus = "NONE";
    const values = { ...d, vatIdStatus, creditLimitCents: limit, paymentTermDays: days };
    if (id) {
      await tx.update(schema.customers).set(values).where(eq(schema.customers.id, id));
      await audit(tx, { entity: "customer", entityId: id, action: "update", before, after: values, userId: session.uid });
    } else {
      const [r] = await tx.insert(schema.customers).values(values).returning({ id: schema.customers.id });
      cid = r.id;
      await audit(tx, { entity: "customer", entityId: r.id, action: "create", after: values, userId: session.uid });
    }
  });
  revalidatePath("/customers");
  redirect(`/customers/${cid}?saved=1`);
}

export type CheckState = { error?: string; ok?: boolean } | undefined;

export async function runVatCheck(_: CheckState, fd: FormData): Promise<CheckState> {
  const session = await requireSession();
  const id = String(fd.get("customerId") ?? "");
  const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, id) });
  if (!c || !c.vatId) return { error: "required" };
  const company = await db.query.companySettings.findFirst();
  const results: VatCheckResult[] = [];
  if (company?.vatId) {
    results.push(await checkBzst({ ownVatId: company.vatId, vatId: c.vatId, company: c.name, city: c.city, zip: c.zip, street: c.street }));
  }
  results.push(await checkVies(c.vatId));
  const decided = results.find((r) => r.valid !== null);
  await db.transaction(async (tx) => {
    for (const r of results) {
      await tx.insert(schema.vatChecks).values({
        customerId: c.id, vatId: c.vatId, source: r.source, valid: r.valid, name: r.name, address: r.address, error: r.error, raw: r.raw ?? null,
      });
    }
    if (decided) {
      const status = decided.valid ? "VALID" : "INVALID";
      await tx.update(schema.customers).set({ vatIdStatus: status, vatCheckedAt: new Date() }).where(eq(schema.customers.id, c.id));
      await audit(tx, { entity: "customer", entityId: c.id, action: "vat_check", before: { status: c.vatIdStatus }, after: { status }, userId: session.uid });
    }
  });
  revalidatePath(`/customers/${c.id}`);
  if (!decided) return { error: company?.vatId ? "unavailable" : "ownVatMissing" };
  return { ok: true };
}
