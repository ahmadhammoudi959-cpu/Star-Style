import Link from "next/link";
import { asc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { fill, getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";

export default async function SuppliersPage() {
  const { t } = await getI18n();
  // nur Warenlieferanten; Firmen aus Ausgaben (Baumarkt, Steuerbüro …) stehen unter Ausgaben → Firmen (Wunsch Inhaber 12.11.2026)
  const [rows, [other]] = await Promise.all([
    db.select().from(schema.suppliers).where(eq(schema.suppliers.kind, "GOODS")).orderBy(asc(schema.suppliers.name)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.suppliers).where(eq(schema.suppliers.kind, "EXPENSE")),
  ]);
  return (
    <div>
      <PageHeader title={t.supplier.title} actions={<Link href="/suppliers/new" className="btn-primary group"><Icon name="plus" className="h-4 w-4" />{t.supplier.new}</Link>} />
      <div className="stagger grid grid-cols-2 gap-2 sm:gap-4 lg:grid-cols-3">
        {rows.length === 0 && <div className="card col-span-2 p-10 text-center text-ink-soft lg:col-span-3">{t.supplier.empty}</div>}
        {rows.map((s) => (
          <Link key={s.id} href={`/suppliers/${s.id}`} className="card card-hover group flex flex-col p-3 sm:p-5">
            <div className="mb-1.5 flex items-center gap-2 sm:mb-2 sm:gap-3">
              <div className="hidden h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600 sm:grid"><Icon name="users" /></div>
              <div className="font-bold [overflow-wrap:anywhere]">{s.name}</div>
            </div>
            <div className="text-xs text-ink-soft sm:text-sm">{[s.contact, s.city, s.country].filter(Boolean).join(" · ")}</div>
            {s.email && <div className="truncate text-xs text-ink-soft sm:text-sm" dir="ltr">{s.email}</div>}
            <span className="btn mt-auto w-full gap-1.5 bg-brand-600 px-2 py-1.5 text-xs text-white shadow-card group-hover:bg-brand-700 sm:mt-3 sm:py-2"><Icon name="eye" className="h-4 w-4" />{t.product.open}</span>
          </Link>
        ))}
      </div>
      {other.n > 0 && (
        <Link href="/expenses/vendors" className="group mt-5 inline-flex items-center gap-2 text-sm text-ink-soft hover:text-brand-700">
          <Icon name="receipt" className="icon-pop h-4 w-4" />{fill(t.supplier.expenseVendors, { n: other.n })}
          <Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" />
        </Link>
      )}
    </div>
  );
}
