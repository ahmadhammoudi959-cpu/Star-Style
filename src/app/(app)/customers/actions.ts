"use server";
import { verifyCustomerVat } from "@/lib/customer-vat";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { can, requirePerm } from "@/lib/auth";
import { parseMoney } from "@/lib/money";
import { audit } from "@/lib/stock";
import { splitVatId } from "@/lib/vat-check";
import { validEmail } from "@/lib/shopify/b2b-map";
import { RESELLER_CHANNELS, setResellerWanted, syncShopCompanyNow } from "@/lib/shopify/b2b";
import type { ShopChannel } from "@/lib/shopify/client";

/** values: bei einem Fehler die getippten Eingaben zurück (React 19 setzt das Formular nach jeder Action zurück) */
export type CustomerState = { error?: string; values?: Record<string, string> } | undefined;
const KEEP = ["name", "contact", "email", "phone", "street", "zip", "city", "country", "vatId", "creditLimit", "paymentTermDays", "notes"] as const;

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
  const session = await requirePerm("customers");
  const fail = (error: string): CustomerState => ({ error, values: Object.fromEntries(KEEP.map((k) => [k, String(fd.get(k) ?? "")])) });
  const p = C.safeParse(Object.fromEntries(fd));
  if (!p.success) return fail("required");
  const { id, vatPending, creditLimit, paymentTermDays, shopReseller, ...d } = p.data;
  // Deutschland: PLZ = 5 Ziffern, USt-IdNr. = DE + 9 Ziffern (Shopify lehnt „0000“ ab, 12.11.2026; auch auf der Rechnung falsch).
  // Reihenfolge wie im Formular: erst die Anschrift, dann die Nummer
  if (d.country === "DE" && d.zip && !/^\d{5}$/.test(d.zip)) return fail("zipDe");
  if (d.vatId && !splitVatId(d.vatId)) return fail("vatFormat");
  if (d.vatId.startsWith("DE") && !/^DE\d{9}$/.test(d.vatId)) return fail("vatDe");
  // Häkchen „Shop-Preise جملة الجملة“ (gilt für beide Shops) nur mit eigenem Recht – sonst bleibt der bisherige Stand je Shop
  // (Name/Anschrift werden trotzdem im Shop nachgezogen)
  const canReseller = can(session, "customers.reseller");
  const prevLinks = id && !canReseller ? await db.query.shopCompanies.findMany({ where: eq(schema.shopCompanies.customerId, id) }) : [];
  const wantedIn = (ch: ShopChannel) => (canReseller ? shopReseller : !!prevLinks.find((r) => r.channel === ch)?.wanted) && d.priceGroup === "WHOLESALE";
  const reseller = RESELLER_CHANNELS.some(wantedIn);
  if (reseller && canReseller && !validEmail(d.email)) return fail("resellerEmail");
  const limit = creditLimit.trim() ? parseMoney(creditLimit) : null;
  if (creditLimit.trim() && limit == null) return fail("required");
  const days = paymentTermDays.trim() ? Number(paymentTermDays) : null;

  let cid = id;
  await db.transaction(async (tx) => {
    const before = id ? await tx.query.customers.findFirst({ where: eq(schema.customers.id, id) }) : undefined;
    // Status der USt-IdNr.: geänderte Nummer muss neu geprüft werden
    let vatIdStatus: "NONE" | "PENDING" | "VALID" | "INVALID" = before?.vatIdStatus ?? "NONE";
    if (!before || before.vatId !== d.vatId) vatIdStatus = "NONE"; // neue Nummer → neu prüfen
    if (vatPending && !d.vatId) vatIdStatus = "PENDING";
    if (!vatPending && vatIdStatus === "PENDING") vatIdStatus = "NONE";
    // Kreditlimit und Zahlungsziel nur mit Recht „Kreditlimit“ – sonst bleiben die alten Werte
    const credit = can(session, "customers.credit");
    const values = { ...d, vatIdStatus, creditLimitCents: credit ? limit : (before?.creditLimitCents ?? null), paymentTermDays: credit ? days : (before?.paymentTermDays ?? null) };
    if (id) {
      await tx.update(schema.customers).set(values).where(eq(schema.customers.id, id));
      await audit(tx, { entity: "customer", entityId: id, action: "update", before, after: values, userId: session.uid });
    } else {
      const [r] = await tx.insert(schema.customers).values(values).returning({ id: schema.customers.id });
      cid = r.id;
      await audit(tx, { entity: "customer", entityId: r.id, action: "create", after: values, userId: session.uid });
    }
  });
  // Großhandelspreise in beiden Shops: verbinden/trennen und höchstens 8 s warten (Stand je Shop steht dann auf der Kundenseite);
  // dauert es länger oder ist ein Shop weg, läuft es im Hintergrund weiter bzw. der Worker versucht es alle 5 min wieder
  try {
    const todo: ShopChannel[] = [];
    for (const ch of RESELLER_CHANNELS) if (await setResellerWanted(cid!, wantedIn(ch), session.uid, ch)) todo.push(ch);
    if (todo.length) await syncShopCompanyNow(cid!, 8000, todo);
  } catch (e) { console.error("shopify b2b", e); }
  revalidatePath("/customers");
  redirect(`/customers/${cid}?saved=1`);
}

/** „Erneut versuchen“ an der Kundenseite (nach einer Ablehnung durch den Shop) */
export async function retryResellerAction(customerId: string): Promise<{ status: string }> {
  await requirePerm("customers.reseller");
  await db.update(schema.shopCompanies).set({ status: "pending", error: "", tries: 0, updatedAt: new Date() }).where(eq(schema.shopCompanies.customerId, customerId));
  const rows = await syncShopCompanyNow(customerId);
  // ein Shop mit Problem → „failed“, sonst „pending“, solange einer noch wartet
  const status = rows.some((r) => r.status === "failed") ? "failed" : rows.length && rows.every((r) => r.status !== "pending") ? "done" : "pending";
  return { status };
}

export type CheckState = { error?: string; ok?: boolean } | undefined;

export async function runVatCheck(_: CheckState, fd: FormData): Promise<CheckState> {
  const session = await requirePerm("customers");
  const id = String(fd.get("customerId") ?? "");
  const c = await db.query.customers.findFirst({ where: eq(schema.customers.id, id) });
  if (!c || !c.vatId) return { error: "required" };
  const v = await verifyCustomerVat(c.id, session.uid);
  revalidatePath(`/customers/${c.id}`);
  if (!v.status) return { error: v.ownVatMissing ? "ownVatMissing" : "unavailable" };
  return { ok: true };
}
