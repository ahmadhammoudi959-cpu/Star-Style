"use server";
/** Postfach: Nachricht markieren, in den Papierkorb, senden (Recht „E-Mail“). Ohne revalidatePath – der Browser lädt selbst neu. */
import { z } from "zod";
import { requirePerm } from "@/lib/auth";
import { attachmentsOf, MailboxError, moveToTrash, readMessage, sendFromMailbox, setFlags } from "@/lib/mailbox";
import { parseAddressList, replySubject } from "@/lib/mail-rules";

export type MailActionResult = { ok: true } | { ok: false; error: string; detail?: string };
const fail = (e: unknown): MailActionResult => {
  if (e instanceof MailboxError) return { ok: false, error: e.code, detail: e.code === "auth" ? undefined : e.message };
  console.error("mail", e);
  return { ok: false, error: "error" };
};
const Ref = z.object({ f: z.string().min(1).max(300), u: z.number().int().positive() });

export async function mailFlagAction(raw: unknown): Promise<MailActionResult> {
  await requirePerm("mail");
  const p = Ref.extend({ seen: z.boolean().optional(), flagged: z.boolean().optional() }).safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid" };
  try { await setFlags(p.data.f, p.data.u, { seen: p.data.seen, flagged: p.data.flagged }); return { ok: true }; } catch (e) { return fail(e); }
}

export async function mailTrashAction(raw: unknown): Promise<MailActionResult> {
  const s = await requirePerm("mail");
  const p = Ref.safeParse(raw);
  if (!p.success) return { ok: false, error: "invalid" };
  try { await moveToTrash(p.data.f, p.data.u, s.uid); return { ok: true }; } catch (e) { return fail(e); }
}

const MAX_TOTAL = 20 * 1024 * 1024; // Hostinger: Anhänge bis 25 MB, Nachricht bis 35 MB

/** Senden (FormData wegen Dateien): to, cc, subject, text, files[], mode (new|reply|all|fwd), f, u, withOriginal */
export async function sendMailAction(fd: FormData): Promise<MailActionResult> {
  const s = await requirePerm("mail");
  const to = parseAddressList(String(fd.get("to") ?? ""));
  const cc = parseAddressList(String(fd.get("cc") ?? ""));
  if (to.bad.length || cc.bad.length) return { ok: false, error: "address", detail: [...to.bad, ...cc.bad].join(", ").slice(0, 200) };
  if (!to.ok.length) return { ok: false, error: "noTo" };
  const subject = String(fd.get("subject") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 250);
  const text = String(fd.get("text") ?? "").slice(0, 200_000);
  if (!subject && !text.trim()) return { ok: false, error: "empty" };
  const files = fd.getAll("files").filter((x): x is File => typeof x === "object" && x !== null && "arrayBuffer" in x && (x as File).size > 0);
  let total = files.reduce((n, f) => n + f.size, 0);
  if (files.length > 20 || total > MAX_TOTAL) return { ok: false, error: "tooLarge" };
  const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
  for (const f of files) attachments.push({ filename: f.name.slice(0, 150) || "anhang", content: Buffer.from(await f.arrayBuffer()), contentType: f.type || undefined });

  // Antwort/Weiterleitung: Bezug immer aus der Originalnachricht auf dem Server (nicht aus dem Browser)
  const mode = String(fd.get("mode") ?? "new");
  const ref = Ref.safeParse({ f: String(fd.get("f") ?? ""), u: Number(fd.get("u") ?? 0) });
  let inReplyTo: string | undefined, references: string[] | undefined, answered: { path: string; uid: number } | undefined;
  try {
    if (ref.success && ["reply", "all", "fwd"].includes(mode)) {
      const orig = await readMessage(ref.data.f, ref.data.u, { markSeen: false });
      if (mode !== "fwd" && orig.messageId) { inReplyTo = orig.messageId; references = orig.references; answered = { path: ref.data.f, uid: ref.data.u }; }
      if (mode === "fwd" && fd.get("withOriginal") === "1") {
        const extra = await attachmentsOf(ref.data.f, ref.data.u);
        total += extra.reduce((n, a) => n + a.content.length, 0);
        if (total > MAX_TOTAL) return { ok: false, error: "tooLarge" };
        attachments.push(...extra);
      }
    }
    await sendFromMailbox({ to: to.ok, cc: cc.ok, subject: subject || replySubject(""), text, attachments, inReplyTo, references, answered }, s.uid);
    return { ok: true };
  } catch (e) { return fail(e); }
}
