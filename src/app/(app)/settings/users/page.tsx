import Link from "next/link";
import { asc, desc, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { fill, getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { OpenButton } from "@/components/OpenButton";
import { requireAdmin } from "@/lib/auth";
import { effectivePerms } from "@/lib/permissions";
import { formatDateTime } from "@/lib/dates";

/** Mitarbeiter & Rechte (nur Admin): Liste mit Rolle/Rechten, Stand, letzter Anmeldung */
export default async function UsersPage() {
  const me = await requireAdmin();
  const { t, intl } = await getI18n();
  const U = t.users;
  const [rows, last] = await Promise.all([
    db.select().from(schema.users).orderBy(desc(schema.users.isAdmin), asc(schema.users.createdAt)),
    db.execute<{ user_id: string; at: string }>(sql`
      select user_id, max(at) as at from login_attempts where ok and reason = 'success' and user_id is not null group by user_id`),
  ]);
  const lastLogin = new Map(last.rows.map((r) => [r.user_id, new Date(r.at).toISOString()]));
  return (
    <div>
      <PageHeader title={U.title} subtitle={U.subtitle} back="/settings"
        actions={<Link href="/settings/users/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{U.new}</Link>} />
      <ul className="stagger grid gap-2 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((u) => {
          const at = lastLogin.get(u.id);
          const n = effectivePerms(u.permissions, false).size;
          const status = !u.active ? { text: U.inactive, tone: "bg-red-100 text-red-800" }
            : u.mustChangePassword ? { text: U.waiting, tone: "bg-amber-100 text-amber-900" }
            : { text: U.active, tone: "bg-emerald-100 text-emerald-800" };
          return (
            <li key={u.id} className={`card card-hover group flex flex-col gap-2 p-4 ${u.active ? "" : "opacity-75"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${u.isAdmin ? "bg-accent-50 text-accent-600" : "bg-brand-50 text-brand-600"}`}>
                    <Icon name={u.isAdmin ? "shield" : "users"} className="icon-pop h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="font-bold [overflow-wrap:anywhere]" dir="auto">{u.name}{u.id === me.uid && <span className="ms-2 text-xs font-semibold text-ink-soft">({U.you})</span>}</div>
                    <div className="truncate text-xs text-ink-soft" dir="ltr">{u.email}</div>
                  </div>
                </div>
                <OpenButton href={`/settings/users/${u.id}`} label={t.product.open} />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`badge ${u.isAdmin ? "bg-accent-100 text-accent-800" : "bg-brand-50 text-brand-700"}`}>{u.isAdmin ? U.admin : fill(U.rights, { n })}</span>
                <span className={`badge ${status.tone}`}>{status.text}</span>
                {u.totpEnabledAt && <span className="badge bg-emerald-50 text-emerald-800"><Icon name="shield" className="me-1 h-3 w-3" />{U.twoFactor}</span>}
              </div>
              <div className="text-xs text-ink-soft">{at ? fill(U.lastLogin, { d: formatDateTime(at, intl) }) : U.never}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
