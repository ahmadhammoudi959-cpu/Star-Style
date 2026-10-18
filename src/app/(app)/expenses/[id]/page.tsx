import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { todayIso } from "@/lib/dates";
import { lockedMonths } from "@/lib/periods";
import { ExpenseForm, type ExpenseFormData } from "../ExpenseForm";

export const dynamic = "force-dynamic";

export default async function ExpensePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ copy?: string }> }) {
  const { id } = await params;
  const { copy } = await searchParams;
  const { t, intl, locale } = await getI18n();
  const [suppliers, locks] = await Promise.all([
    db.select({ name: schema.suppliers.name, country: schema.suppliers.country, vatId: schema.suppliers.vatId }).from(schema.suppliers).orderBy(asc(schema.suppliers.name)),
    lockedMonths(),
  ]);
  const today = todayIso();
  const srcId = id === "new" ? copy : id;
  const e = srcId ? await db.query.expenses.findFirst({ where: eq(schema.expenses.id, srcId), with: { supplier: true } }) : null;
  if (id !== "new" && !e) notFound();

  const initial: ExpenseFormData = e ? {
    id: id === "new" ? undefined : e.id,
    date: id === "new" ? today : e.date,
    vendorName: e.vendorName, vendorCountry: e.vendorCountry, vendorVatId: e.supplier?.vatId ?? "",
    invoiceNo: id === "new" ? "" : e.invoiceNo, category: e.category, taxCase: e.taxCase, channel: e.channel ?? "",
    amount: ((e.taxCase === "DOMESTIC" ? e.grossCents : e.netCents) / 100).toFixed(2).replace(".", ","), vatRateBp: e.vatRateBp,
    paid: e.paid, paidAt: id === "new" ? today : e.paidAt ?? "", paymentMethod: e.paymentMethod ?? "", note: id === "new" ? "" : e.note,
    fileId: id === "new" ? null : e.fileId,
  } : {
    date: today, vendorName: "", vendorCountry: "DE", vendorVatId: "", invoiceNo: "", category: "ADVERTISING", taxCase: "DOMESTIC", channel: "",
    amount: "", vatRateBp: 1900, paid: true, paidAt: today, paymentMethod: "BANK", note: "", fileId: null,
  };
  const locked = id !== "new" && !!e && (locks.has(e.date.slice(0, 7)) || (e.paid && !!e.paidAt && locks.has(e.paidAt.slice(0, 7))));

  return (
    <div>
      <PageHeader title={id === "new" ? t.exp.new : t.exp.edit} subtitle={id === "new" ? undefined : e?.vendorName} back={`/expenses?month=${initial.date.slice(0, 7)}`} />
      <ExpenseForm t={t} intl={intl} locale={locale} initial={initial} suppliers={suppliers} locked={locked} />
    </div>
  );
}
