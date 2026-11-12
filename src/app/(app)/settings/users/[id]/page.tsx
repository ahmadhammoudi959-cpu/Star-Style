import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requireAdmin } from "@/lib/auth";
import { normalizePerms } from "@/lib/permissions";
import { UserForm, type UserView } from "./UserForm";

/** Adresse zum Anmelden für die Nachricht an den neuen Mitarbeiter (öffentliche Adresse des Dienstes) */
async function loginUrl() {
  const fixed = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL;
  if (fixed) return `${fixed.replace(/\/+$/, "")}/login`;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}/login`;
}

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireAdmin();
  const { t, locale } = await getI18n();
  const { id } = await params;
  const u = id === "new" ? null : await db.query.users.findFirst({ where: eq(schema.users.id, id) });
  if (id !== "new" && !u) notFound();
  const view: UserView = u
    ? {
        id: u.id, name: u.name, email: u.email, locale: u.locale, admin: u.isAdmin, perms: normalizePerms(u.permissions),
        active: u.active, mustChange: u.mustChangePassword, twoOn: !!u.totpEnabledAt, self: u.id === me.uid,
      }
    : { id: "", name: "", email: "", locale, admin: false, perms: [], active: true, mustChange: true, twoOn: false, self: false };
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={u ? u.name : t.users.new} subtitle={u ? u.email : t.users.subtitle} back="/settings/users" />
      <UserForm t={t} u={view} loginUrl={await loginUrl()} />
    </div>
  );
}
