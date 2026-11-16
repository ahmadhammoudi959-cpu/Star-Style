"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { sendMail } from "@/lib/mail";
import { loadMailSettings } from "@/lib/mailbox";
import { fillDocText } from "@/lib/mail-rules";
import { validatePlan } from "@/lib/payments";
import { archivedInvoicePdf, offerPdf } from "@/lib/pdf";
import { formatDate } from "@/lib/dates";
import { can, requirePerm } from "@/lib/auth";
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

/** Rabatt nur mit eigenem Recht (Positions- oder Gesamtrabatt) */
const hasDiscount = (d: { discountBp: number; lines: { discountBp: number }[] }) => d.discountBp > 0 || d.lines.some((l) => l.discountBp > 0);

/** Preis unter dem Listenpreis der Preisgruppe des Kunden ist auch ein Rabatt (sonst ginge es über den Einzelpreis) */
async function belowListPrice(customerId: string, ls: { variantId: string | null; unitPriceCents: number }[]): Promise<boolean> {
  const ids = [...new Set(ls.map((l) => l.variantId).filter((x): x is string => !!x))];
  if (!ids.length) return false;
  const [c, vs] = await Promise.all([
    db.query.customers.findFirst({ where: eq(schema.customers.id, customerId), columns: { priceGroup: true } }),
    db.query.variants.findMany({ where: inArray(schema.variants.id, ids), with: { product: true } }),
  ]);
  const list = new Map(vs.map((v) => [v.id, c?.priceGroup === "RETAIL"
    ? v.retailPriceCents ?? v.product.retailPriceCents : v.wholesalePriceCents ?? v.product.wholesalePriceCents]));
  return ls.some((l) => l.variantId != null && list.has(l.variantId) && l.unitPriceCents < list.get(l.variantId)!);
}
const discountDenied = async (s: Parameters<typeof can>[0], d: { customerId: string; discountBp: number; lines: { variantId: string | null; unitPriceCents: number; discountBp: number }[] }) =>
  !can(s, "sales.discount") && (hasDiscount(d) || (await belowListPrice(d.customerId, d.lines)));

export async function saveOfferAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requirePerm("sales.offers");
  const p = OfferIn.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0]?.path[0] === "customerId" ? "noCustomer" : "required" };
  if (!p.data.lines.length) return { error: "noLines" };
  if (await discountDenied(s, p.data)) return { error: "noRight" };
  let id: string;
  try { id = await saveOffer(p.data, s.uid); } catch (e) { return fail(e); }
  revalidatePath("/sales");
  redirect(`/sales/offers/${id}`);
}

export async function offerStatusAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requirePerm("sales.offers");
  const id = String(fd.get("id")), status = String(fd.get("status")) as "SENT" | "ACCEPTED" | "REJECTED";
  try { await setOfferStatus(id, status, String(fd.get("acceptedVia") ?? ""), s.uid); } catch (e) { return fail(e); }
  revalidatePath(`/sales/offers/${id}`); revalidatePath("/sales");
  return undefined;
}

export async function convertOfferAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requirePerm("sales.invoices");
  let inv: string;
  try { inv = await offerToInvoice(String(fd.get("id")), s.uid); } catch (e) { return fail(e); }
  revalidatePath("/sales");
  redirect(`/sales/invoices/${inv}`);
}

const InvoiceIn = z.object({
  id: z.string().optional(), customerId: z.string().min(1), offerId: z.string().optional(), replacesInvoiceId: z.string().optional(),
  channel: z.enum(["STORE", "BRAND_SHOP", "GENERAL_SHOP"]), deliveryDate: date.or(z.literal("")).default(""),
  discountBp: z.coerce.number().int().min(0).max(10000),
  notes: z.string().max(2000).default(""),
  retentionOfTitle: z.string().optional().transform((v) => v === "on"), intent: z.enum(["save", "issue"]).default("save"), lines,
  initialPaymentCents: z.coerce.number().int().min(0).default(0),
  initialPaymentMethod: z.enum(["CASH", "BANK", "CARD", "ONLINE"]).default("CASH"),
  installments: z.string().default("[]").transform((s) => JSON.parse(s)).pipe(z.array(z.object({ dueDate: date, amountCents: z.number().int().positive() }))),
});

export async function saveInvoiceAction(_: DocState, fd: FormData): Promise<DocState> {
  const s = await requirePerm("sales.invoices");
  const p = InvoiceIn.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: p.error.issues[0]?.path[0] === "customerId" ? "noCustomer" : "required" };
  if (!p.data.lines.length) return { error: "noLines" };
  const { intent, ...d } = p.data;
  // Rabatt, Zahlung bei Ausstellung, Ratenplan und Korrektur einer ausgestellten Rechnung = eigene Rechte
  if ((await discountDenied(s, d)) || (d.initialPaymentCents > 0 && !can(s, "payments.record"))
    || (d.installments.length > 0 && !can(s, "payments.plans")) || (d.replacesInvoiceId && !can(s, "sales.correct"))) return { error: "noRight" };
  let id: string;
  try {
    if (d.installments.length) validatePlan(d.installments, d.installments.reduce((s, r) => s + r.amountCents, 0));
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
  const s = await requirePerm("sales.invoices", "sales.correct");
  const id = String(fd.get("id")), op = String(fd.get("op"));
  if (!can(s, op === "cancel" || op === "correct" ? "sales.correct" : "sales.invoices")) return { error: "noRight" };
  // Korrekturentwurf ausstellen storniert die alte Rechnung → auch dafür das Recht „ändern/stornieren“
  if (op === "issue" && !can(s, "sales.correct")) {
    const draft = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id), columns: { replacesInvoiceId: true } });
    if (draft?.replacesInvoiceId) return { error: "noRight" };
  }
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
  const s = await requirePerm("sales.email");
  const kind = String(fd.get("kind")), id = String(fd.get("id"));
  const to = String(fd.get("to") ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: "required" };
  const company = await db.query.companySettings.findFirst();
  const ms = await loadMailSettings().catch(() => null);
  // Absender in Betreff und Gruß = Absendername aus E-Mail-Einstellungen (z. B. „Star Style“), sonst Firmenname
  const sender = ms?.fromName.trim() || company?.name || "";
  try {
    if (kind === "offer") {
      const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, id) });
      if (!o) return { error: "notFound" };
      await sendMail({
        to, subject: `Angebot ${o.number} – ${sender}`,
        text: fillDocText("offer", ms?.offerText ?? "", { number: o.number, valid: formatDate(o.validUntil), sender }),
        attachments: [{ filename: `Angebot-${o.number}.pdf`, content: Buffer.from(await offerPdf(id)) }],
      });
      if (o.status === "DRAFT") await setOfferStatus(id, "SENT", "", s.uid);
    } else {
      const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) });
      if (!inv?.number) return { error: "notFound" };
      const label = inv.kind === "CANCELLATION" ? "Stornorechnung" : "Rechnung";
      await sendMail({
        to, subject: `${label} ${inv.number} – ${sender}`,
        text: fillDocText("invoice", ms?.invoiceText ?? "", {
          doc: label, number: inv.number, sender,
          due: inv.dueDate && inv.kind === "INVOICE" ? `Zahlbar bis ${formatDate(inv.dueDate)}.` : "",
        }),
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
