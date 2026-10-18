import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { SupplierForm } from "../SupplierForm";

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t } = await getI18n();
  const empty = { name: "", contact: "", email: "", phone: "", street: "", zip: "", city: "", country: "DE", vatId: "", notes: "" };
  if (id === "new") return <div><PageHeader title={t.supplier.new} back="/suppliers" /><SupplierForm t={t} initial={empty} /></div>;
  const s = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, id) });
  if (!s) notFound();
  return <div><PageHeader title={s.name} back="/suppliers" /><SupplierForm t={t} initial={s} /></div>;
}
