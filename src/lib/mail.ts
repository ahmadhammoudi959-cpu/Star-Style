import "server-only";
import nodemailer from "nodemailer";
import { mailboxConfigured, sendFromMailbox } from "./mailbox";
import { parseAddressList } from "./mail-rules";

/**
 * E-Mail-Versand von Belegen (Angebot, Rechnung, Monatsmappe). Seit 16.11.2026 über das Postfach im System
 * (Einstellungen → E-Mail-Postfach, Kopie landet in „Gesendet“); die alten SMTP_*-Umgebungsvariablen gehen weiter vor.
 * Ohne beides ist der Versand ausgeblendet.
 */
const envConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);

export async function mailConfigured() {
  return envConfigured() || (await mailboxConfigured());
}

export async function sendMail(o: { to: string; subject: string; text: string; attachments: { filename: string; content: Buffer }[]; userId?: string }) {
  if (envConfigured()) {
    const port = Number(process.env.SMTP_PORT ?? 587);
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await t.sendMail({ from: process.env.SMTP_FROM, to: o.to, bcc: process.env.SMTP_BCC || undefined, subject: o.subject, text: o.text, attachments: o.attachments });
    return;
  }
  if (!(await mailboxConfigured())) throw new Error("mailNotConfigured");
  const to = parseAddressList(o.to);
  if (!to.ok.length || to.bad.length) throw new Error("mailAddress");
  await sendFromMailbox({ to: to.ok, cc: [], subject: o.subject, text: o.text, attachments: o.attachments, withSignature: true }, o.userId);
}
