"use server";
import { verifyCustomerVat } from "@/lib/customer-vat";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireSession } from "@/lib/auth";
import { parseMoney } from "@/lib/money";
import { audit } from "@/lib/stock";
import { splitVatId } from "@/lib/vat-check";
import { validEmail } from "@/lib/shopify/b2b-map";
import { setResellerWanted, syncShopCompanyNow } from "@/lib/shopify/b2b";

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
  shopReseller: z.string().optional().transform((v) => v === "on"),
});

export async function saveCustomer(_: CustomerState, fd: FormData): Promise<CustomerState> {
  const session = await requireSession();
  const p = C.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  const { id, vatPending, creditLimit, paymentTermDays, shopReseller, ...d } = p.data;
  if (d.vatId && !splitVatId(d.vatId)) return { error: "vatFormat" };
  const reseller = shopReseller && d.priceGroup === "WHOLESALE";
  if (reseller && !validEmail(d.email)) return { error: "resellerEmail" };
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
  // Großhandelspreise im allgemeinen Shop: verbinden/trennen und höchstens 8 s warten (Stand steht dann auf der Kundenseite);
  // dauert es länger oder ist der Shop weg, läuft es im Hintergrund weiter bzw. der Worker versucht es alle 5 min wieder
  try {
    if (await setResellerWanted(cid!, reseller, session.uid)) await syncShopCompanyNow(cid!);
  } catch (e) { console.error("shopify b2b", e); }
  revalidatePath("/customers");
  redirect(`/customers/${cid}?saved=1`);
}

/** „Erneut versuchen“ an der Kundenseite (nach einer Ablehnung durch den Shop) */
export async function retryResellerAction(customerId: string): Promise<{ status: string }> {
  await requireSession();
  await db.update(schema.shopCompanies).set({ status: "pending", error: "", tries: 0, updatedAt: new Date() }).where(eq(schema.shopCompanies.customerId, customerId));
  const r = await syncShopCompanyNow(customerId);
  return { status: r?.status ?? "pending" };
}

export type CheckState = { error?: string; ok?: boolean } | undefined;

export async function runVatCheck(_: CheckState, fd: FormData): Promise<CheckState> {
  const session = await requireSession();
  const id = String(fd.get("customerId") ?? "");
  const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, id) });
  if (!c || !c.vatId) return { error: "required" };
  const v = await verifyCustomerVat(c.id, session.uid);
  revalidatePath(`/customers/${c.id}`);
  if (!v.status) return { error: v.ownVatMissing ? "ownVatMissing" : "unavailable" };
  return { ok: true };
}
