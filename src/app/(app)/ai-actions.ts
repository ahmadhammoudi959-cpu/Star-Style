"use server";
import { requireSession } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { db } from "@/db";
import { AiError, aiConfigured } from "@/lib/ai/client";
import { readReceipt } from "@/lib/ai/receipt";
import { ask, summarizeMonth } from "@/lib/ai/ask";
import type { ReceiptSuggestion } from "@/lib/ai/receipt-map";
import { shiftMonth } from "@/lib/periods";

const errCode = (e: unknown) => (e instanceof AiError ? e.code : "other");
const AI_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

export async function readReceiptAction(fd: FormData): Promise<{ ok: ReceiptSuggestion } | { error: string }> {
  await requireSession();
  if (!aiConfigured()) return { error: "notConfigured" };
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "pickFirst" };
  if (!AI_MIME.includes(file.type) || file.size > 9 * 1024 * 1024) return { error: "fileType" };
  try {
    return { ok: await readReceipt(Buffer.from(await file.arrayBuffer()), file.type) };
  } catch (e) { console.error("readReceipt", e); return { error: errCode(e) }; }
}

export async function askAction(history: { role: "user" | "assistant"; text: string }[]): Promise<{ answer: string } | { error: string }> {
  await requireSession();
  if (!aiConfigured()) return { error: "notConfigured" };
  const clean = history.filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.text === "string" && h.text.trim()).map((h) => ({ role: h.role, text: h.text.slice(0, 2000) }));
  if (!clean.length || clean[clean.length - 1].role !== "user") return { error: "other" };
  const { locale } = await getI18n();
  const company = (await db.query.companySettings.findFirst())?.name ?? "";
  try {
    const r = await ask(clean, locale, company);
    return r.answer ? { answer: r.answer } : { error: "other" };
  } catch (e) { console.error("ask", e); return { error: errCode(e) }; }
}

export async function summaryAction(month: string): Promise<{ text: string } | { error: string }> {
  await requireSession();
  if (!aiConfigured()) return { error: "notConfigured" };
  if (!/^\d{4}-\d{2}$/.test(month)) return { error: "other" };
  const { locale } = await getI18n();
  const company = (await db.query.companySettings.findFirst())?.name ?? "";
  try { return { text: await summarizeMonth(month, shiftMonth(month, -1), locale, company) }; }
  catch (e) { console.error("summary", e); return { error: errCode(e) }; }
}
