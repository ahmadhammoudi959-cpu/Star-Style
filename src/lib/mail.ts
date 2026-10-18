import "server-only";
import nodemailer from "nodemailer";

/** E-Mail-Versand über das eigene Postfach der Firma (SMTP). Ohne Zugangsdaten ist der Versand ausgeblendet. */
export function mailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}

export async function sendMail(o: { to: string; subject: string; text: string; attachments: { filename: string; content: Buffer }[] }) {
  if (!mailConfigured()) throw new Error("mailNotConfigured");
  const port = Number(process.env.SMTP_PORT ?? 587);
  const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port, secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await t.sendMail({ from: process.env.SMTP_FROM, to: o.to, bcc: process.env.SMTP_BCC || undefined, subject: o.subject, text: o.text, attachments: o.attachments });
}
