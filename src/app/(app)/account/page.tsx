import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { SecurityCard, type LogKey, type SecurityView } from "../settings/SecurityCard";
import { requireSession } from "@/lib/auth";
import { dbConnectionInternal, recentAttempts, type AttemptRow } from "@/lib/login";
import { deviceLabel } from "@/lib/login-guard";
import { formatDate, formatDateTime } from "@/lib/dates";

const logKey = (r: AttemptRow): LogKey =>
  r.step === "change" ? (r.ok ? (r.reason === "emailChanged" ? "emailChanged" : "changed") : r.reason === "code" ? "code" : "invalid")
  : r.ok && r.reason === "success" ? (r.step === "recovery" ? "recovery" : "success")
  : (["needCode", "invalid", "code", "locked", "disabled"].includes(r.reason) ? r.reason : "invalid") as LogKey;

/**
 * Mein Konto (jeder Angemeldete): eigenes Passwort, Anmelde-E-Mail, Zwei-Schritt-Anmeldung, andere Geräte abmelden, letzte Anmeldungen.
 * Admin sieht zusätzlich die Prüfliste des Systems und die Anmeldungen aller Konten.
 */
export default async function AccountPage() {
  const a = await requireSession();
  const { t, intl } = await getI18n();
  const [me, log] = await Promise.all([
    db.query.users.findFirst({ where: eq(schema.users.id, a.uid) }),
    recentAttempts(a.admin ? 20 : 15, a.admin ? undefined : a.uid),
  ]);
  const v: SecurityView = {
    email: me?.email ?? "",
    twoOn: !!me?.totpEnabledAt, twoSince: me?.totpEnabledAt ? formatDate(me.totpEnabledAt.toISOString(), intl) : null,
    codesLeft: me?.recoveryCodes.length ?? 0,
    passwordChanged: me?.passwordChangedAt ? formatDateTime(me.passwordChangedAt.toISOString(), intl) : null,
    dbInternal: dbConnectionInternal(),
    admin: a.admin,
    log: log.map((r) => ({ at: formatDateTime(r.at, intl), ok: r.ok, key: logKey(r), device: deviceLabel(r.userAgent), ip: r.ip, ...(a.admin ? { who: r.email } : {}) })),
  };
  return (
    <div>
      <PageHeader title={t.account.title} subtitle={t.account.subtitle} />
      <SecurityCard t={t} v={v} />
    </div>
  );
}
