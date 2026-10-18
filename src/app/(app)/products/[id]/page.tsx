import { notFound } from "next/navigation";
import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { ProductForm } from "../ProductForm";
import { formLookups } from "../helpers";

const toInput = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export default async function EditProduct({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { id } = await params;
  const { saved } = await searchParams;
  const { t } = await getI18n();
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
  if (!p) notFound();
  const vs = await db.select().from(schema.variants)
    .where(and(eq(schema.variants.productId, id), eq(schema.variants.active, true))).orderBy(asc(schema.variants.createdAt));
  const { suppliers, categories } = await formLookups();
  return (
    <div>
      <PageHeader title={p.nameDe} subtitle={p.sku} back="/products"
        actions={vs[0] && <Link href={`/stock/${vs[0].id}`} className="btn-ghost group"><Icon name="layers" className="h-4 w-4" />{t.nav.stock}</Link>} />
      {saved && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700 ring-1 ring-brand-100"><Icon name="check" className="h-4 w-4" />{t.common.saved}</div>}
      <ProductForm t={t} suppliers={suppliers} categories={categories} initial={{
        id: p.id, sku: p.sku, nameDe: p.nameDe, nameNl: p.nameNl, descriptionDe: p.descriptionDe, descriptionNl: p.descriptionNl,
        category: p.category, supplierId: p.supplierId ?? "", vatRateBp: p.vatRateBp,
        purchasePrice: toInput(p.purchasePriceCents), wholesalePrice: toInput(p.wholesalePriceCents), retailPrice: toInput(p.retailPriceCents),
        tracksExpiry: p.tracksExpiry, inBrandShop: p.inBrandShop, inGeneralShop: p.inGeneralShop,
        variants: vs.map((v) => ({ id: v.id, size: v.size, color: v.color, barcode: v.barcode ?? "", minStock: v.minStock, stockQty: v.stockQty })),
      }} />
    </div>
  );
}
