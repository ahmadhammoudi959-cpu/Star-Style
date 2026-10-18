import Link from "next/link";
import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";

export default async function SuppliersPage() {
  const { t } = await getI18n();
  const rows = await db.select().from(schema.suppliers).orderBy(asc(schema.suppliers.name));
  return (
    <div>
      <PageHeader title={t.supplier.title} actions={<Link href="/suppliers/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.supplier.new}</Link>} />
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.length === 0 && <div className="card p-10 text-center text-ink-soft sm:col-span-2 lg:col-span-3">{t.supplier.empty}</div>}
        {rows.map((s) => (
          <Link key={s.id} href={`/suppliers/${s.id}`} className="card card-hover group p-5">
            <div className="mb-2 flex items-center gap-3">
              <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="users" /></div>
              <div className="font-bold">{s.name}</div>
            </div>
            <div className="text-sm text-ink-soft">{[s.contact, s.city, s.country].filter(Boolean).join(" · ")}</div>
            {s.email && <div className="text-sm text-ink-soft" dir="ltr">{s.email}</div>}
          </Link>
        ))}
      </div>
    </div>
  );
}
