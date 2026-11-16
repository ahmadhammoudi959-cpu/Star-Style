"use server";
/** WhatsApp: senden (Text, Datei, Vorlage), neuer Chat, Kunde verknüpfen, gelesen (Recht „WhatsApp“). Ohne revalidatePath. */
import { z } from "zod";
import { requirePerm } from "@/lib/auth";
import { linkChatCustomer, listTemplates, markChatRead, openChat, sendWaFile, sendWaTemplate, sendWaText, WaError, type WaTemplate } from "@/lib/whatsapp";

export type WaResult<T = undefined> = { ok: true; data?: T } | { ok: false; error: string; detail?: string };
const fail = (e: unknown): WaResult<never> => {
  if (e instanceof WaError) return { ok: false, error: e.code, detail: e.code === "auth" ? undefined : e.message };
  console.error("whatsapp", e);
  return { ok: false, error: "error" };
};
const Id = z.string().min(1).max(100);

export async function waSendTextAction(raw: unknown): Promise<WaResult> {
  const s = await requirePerm("whatsapp");
  const p = z.object({ chatId: Id, text: z.string().min(1).max(4096) }).safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid" };
  try { await sendWaText(p.data.chatId, p.data.text, s.uid); return { ok: true }; } catch (e) { return fail(e); }
}

export async function waSendFileAction(fd: FormData): Promise<WaResult> {
  const s = await requirePerm("whatsapp");
  const chatId = String(fd.get("chatId") ?? "");
  const file = fd.get("file");
  if (!chatId || !file || typeof file !== "object" || !("arrayBuffer" in file) || !(file as File).size) return { ok: false, error: "invalid" };
  const f = file as File;
  try {
    await sendWaFile(chatId, { name: f.name, type: f.type || "application/octet-stream", data: Buffer.from(await f.arrayBuffer()) }, String(fd.get("caption") ?? ""), s.uid);
    return { ok: true };
  } catch (e) { return fail(e); }
}

export async function waTemplatesAction(): Promise<WaResult<WaTemplate[]>> {
  await requirePerm("whatsapp");
  try { return { ok: true, data: await listTemplates() }; } catch (e) { return fail(e); }
}

export async function waSendTemplateAction(raw: unknown): Promise<WaResult> {
  const s = await requirePerm("whatsapp");
  const p = z.object({ chatId: Id, name: z.string().min(1).max(512), language: z.string().min(2).max(15), params: z.array(z.string().max(500)).max(20) }).safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid" };
  try { await sendWaTemplate(p.data.chatId, p.data, s.uid); return { ok: true }; } catch (e) { return fail(e); }
}

export async function waOpenChatAction(raw: unknown): Promise<WaResult<string>> {
  await requirePerm("whatsapp");
  const p = z.object({ phone: z.string().min(3).max(40), customerId: z.string().max(100).nullable().optional() }).safeParse(raw);
  if (!p.success) return { ok: false, error: "phone" };
  try { return { ok: true, data: await openChat(p.data.phone, p.data.customerId ?? null) }; } catch (e) { return e instanceof WaError && e.message === "phone" ? { ok: false, error: "phone" } : fail(e); }
}

export async function waLinkAction(raw: unknown): Promise<WaResult> {
  const s = await requirePerm("whatsapp");
  const p = z.object({ chatId: Id, customerId: z.string().max(100).nullable() }).safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid" };
  try { await linkChatCustomer(p.data.chatId, p.data.customerId || null, s.uid); return { ok: true }; } catch (e) { return fail(e); }
}

export async function waReadAction(raw: unknown): Promise<WaResult> {
  await requirePerm("whatsapp");
  const p = Id.safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid" };
  try { await markChatRead(p.data); return { ok: true }; } catch (e) { return fail(e); }
}
