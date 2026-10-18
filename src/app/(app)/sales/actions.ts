"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { sendMail } from "@/lib/mail";
import { archivedInvoicePdf, offerPdf } from "@/lib/pdf";
import { formatDate } from "@/lib/dates";
import { requireSession } from "@/lib/auth";
import {
  cancelInvoice, deleteDraft, issueInvoice, offerToInvoice, saveInvoiceDraft, saveOffer, SalesError, setOfferStatus, startCorrection,
} from "@/lib/sales";

export type DocState = { error?: string; detail?: string } | undefined;

const Line = z.object({
  variantId: z.string().nullable(),
  description: z.string().trim().min(1).max(500),
  qty: z.coerce.number().int().positive(),
  unitPriceCents: z.coerce.number().int().min(0),
  discountBp: z.coerce.number().int().min(0).max(10000),
  vatRateBp: z.coerce.number().int().refine((n) => [0, 700, 1900].includes(n)),
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const lines = z.string().transform((s) => JSON.parse(s)).pipe(z.array(Line));

const OfferIn = z.object({
  id: z.string().optional(), customerId: z.string().min(1), date, validUntil: date,
  discountBp: z.coerce.number().int().min(0).max(10000), notes: z.string().max(2000).default(""), lines,
});

function fail(e: unknown): DocState {
  if (e instanceof SalesError) return { error: e.code, detail: e.detail };
  console.error(e);
  return { error: "error" };
}

export async function saveOfferAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requireSession();
  const p = OfferIn.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0]?.path[0] === "customerId" ? "noCustomer" : "required" };
  if (!p.data.lines.length) return { error: "noLines" };
  let id: string;
  try { id = await saveOffer(p.data, s.uid); } catch (e) { return fail(e); }
  revalidatePath("/sales");
  redirect(`/sales/offers/${id}`);
}

export async function offerStatusAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requireSession();
  const id = String(fd.get("id")), status = String(fd.get("status")) as "SENT" | "ACCEPTED" | "REJECTED";
  try { await setOfferStatus(id, status, String(fd.get("acceptedVia") ?? ""), s.uid); } catch (e) { return fail(e); }
  revalidatePath(`/sales/offers/${id}`); revalidatePath("/sales");
  return undefined;
}

export async function convertOfferAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requireSession();
  let inv: string;
  try { inv = await offerToInvoice(String(fd.get("id")), s.uid); } catch (e) { return fail(e); }
  revalidatePath("/sales");
  redirect(`/sales/invoices/${inv}`);
}

const InvoiceIn = z.object({
  id: z.string().optional(), customerId: z.string().min(1), offerId: z.string().optional(), replacesInvoiceId: z.string().optional(),
  channel: z.enum(["STORE", "BRAND_SHOP", "GENERAL_SHOP"]), deliveryDate: date.or(z.literal("")).default(""),
  discountBp: z.coerce.number().int().min(0).max(10000), skontoBp: z.coerce.number().int().min(0).max(10000).default(0),
  skontoDays: z.coerce.number().int().min(0).max(365).default(0), notes: z.string().max(2000).default(""),
  retentionOfTitle: z.string().optional().transform((v) => v === "on"), intent: z.enum(["save", "issue"]).default("save"), lines,
});

export async function saveInvoiceAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requireSession();
  const p = InvoiceIn.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0]?.path[0] === "customerId" ? "noCustomer" : "required" };
  if (!p.data.lines.length) return { error: "noLines" };
  const { intent, ...d } = p.data;
  let id: string;
  try {
    id = await saveInvoiceDraft({ ...d, deliveryDate: d.deliveryDate || null, offerId: d.offerId || null, replacesInvoiceId: d.replacesInvoiceId || null }, s.uid);
    if (intent === "issue") await issueInvoice(id, s.uid);
  } catch (e) {
    const r = fail(e);
    // Entwurf wurde gespeichert, nur das Ausstellen schlug fehl → zur Entwurfsseite mit Fehlermeldung
    return r;
  }
  revalidatePath("/sales"); revalidatePath("/stock"); revalidatePath("/");
  redirect(`/sales/invoices/${id}`);
}

export async function invoiceAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requireSession();
  const id = String(fd.get("id")), op = String(fd.get("op"));
  let target = id;
  try {
    if (op === "issue") await issueInvoice(id, s.uid);
    else if (op === "cancel") await cancelInvoice(id, s.uid);
    else if (op === "correct") target = await startCorrection(id, s.uid);
    else if (op === "delete") { await deleteDraft(id, s.uid); revalidatePath("/sales"); redirect("/sales?tab=invoices"); }
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // redirect durchreichen
    return fail(e);
  }
  revalidatePath("/sales"); revalidatePath("/stock"); revalidatePath("/");
  redirect(`/sales/invoices/${target}`);
}

// ───────── E-Mail-Versand ─────────

export async function emailDocAction(_: DocState, fd: FormData): Promise<DocState & { ok?: boolean }> {
  const s = await requireSession();
  const kind = String(fd.get("kind")), id = String(fd.get("id"));
  const to = String(fd.get("to") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: "required" };
  const company = await db.query.companySettings.findFirst();
  try {
    if (kind === "offer") {
      const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, id) });
      if (!o) return { error: "notFound" };
      await sendMail({
        to, subject: `Angebot ${o.number} – ${company?.name ?? ""}`,
        text: `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unser Angebot ${o.number}. Es ist gültig bis ${formatDate(o.validUntil)}.\n\nMit freundlichen Grüßen\n${company?.name ?? ""}`,
        attachments: [{ filename: `Angebot-${o.number}.pdf`, content: Buffer.from(await offerPdf(id)) }],
      });
      if (o.status === "DRAFT") await setOfferStatus(id, "SENT", "", s.uid);
    } else {
      const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) });
      if (!inv?.number) return { error: "notFound" };
      const label = inv.kind === "CANCELLATION" ? "Stornorechnung" : "Rechnung";
      await sendMail({
        to, subject: `${label} ${inv.number} – ${company?.name ?? ""}`,
        text: `Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unsere ${label} ${inv.number}.${inv.dueDate && inv.kind === "INVOICE" ? ` Zahlbar bis ${formatDate(inv.dueDate)}.` : ""}\n\nMit freundlichen Grüßen\n${company?.name ?? ""}`,
        attachments: [{ filename: `${label}-${inv.number}.pdf`, content: Buffer.from(await archivedInvoicePdf(id)) }],
      });
      await db.update(schema.invoices).set({ sentAt: new Date() }).where(eq(schema.invoices.id, id));
    }
  } catch (e) {
    console.error(e);
    return { error: "mail" };
  }
  revalidatePath(`/sales/${kind === "offer" ? "offers" : "invoices"}/${id}`);
  return { ok: true };
}
