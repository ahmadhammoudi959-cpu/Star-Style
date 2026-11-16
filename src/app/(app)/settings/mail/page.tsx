import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requirePerm } from "@/lib/auth";
import { loadMailSettings } from "@/lib/mailbox";
import { mailboxReady } from "@/lib/mail-rules";
import { db } from "@/db";
import { MailForm } from "./MailForm";

export const dynamic = "force-dynamic";

/**
 * Postfach info@ im System (Wunsch Inhaber 16.11.2026) – Recht „Einstellungen“. Hostinger: IMAP/SMTP mit App-Passwort
 * (das Postfach hat Zwei-Schritt). Das Passwort trägt der Inhaber selbst ein; angezeigt wird es nie.
 */
export default async function MailSettingsPage() {
  await requirePerm("settings");
  const { t } = await getI18n();
  const [s, company] = await Promise.all([loadMailSettings(), db.query.companySettings.findFirst()]);
  const defaultSignature = [company?.name, [company?.street, [company?.zip, company?.city].filter(Boolean).join(" ")].filter(Boolean).join(", "), company?.phone ? `Tel./WhatsApp ${company.phone}` : "", company?.website].filter(Boolean).join("\n");
  return (
    <div>
      <PageHeader title={t.mailSet.title} subtitle={t.mailSet.subtitle} back="/settings" />
      <MailForm t={t} ready={mailboxReady(s)} initial={{
        imapHost: s.imapHost, imapPort: s.imapPort, smtpHost: s.smtpHost, smtpPort: s.smtpPort, user: s.user,
        fromName: s.fromName || company?.name || "", signature: s.signature || (defaultSignature ? `--\n${defaultSignature}` : ""), hasPassword: Boolean(s.password),
      }} />
    </div>
  );
}
