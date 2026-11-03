import { notFound } from "next/navigation";
import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { ProductForm } from "../ProductForm";
import { formLookups } from "../helpers";
import { productDeletable } from "@/lib/product-delete";
import { DeleteProduct } from "./DeleteProduct";
import { decodePush, productShopStatus, type PushResult } from "@/lib/shopify/product-push";
import { fill, type Dict } from "@/i18n";

const toInput = (c: number) => (c / 100).toFixed(2).replace(".", ",");

export default async function EditProduct({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; push?: string }> }) {
  const { id } = await params;
  const { saved, push } = await searchParams;
  const { t } = await getI18n();
  const p = await db.query.products.findFirst({ where: eq(schema.products.id, id) });
  if (!p) notFound();
  const vs = await db.select().from(schema.variants)
    .where(and(eq(schema.variants.productId, id), eq(schema.variants.active, true))).orderBy(asc(schema.variants.createdAt));
  const [{ suppliers, categories }, deletable, shopStatus] = await Promise.all([formLookups(), productDeletable(id), productShopStatus(id)]);
  return (
    <div>
      <PageHeader title={p.nameDe} subtitle={p.sku} back="/products"
        actions={vs[0] && <Link href={`/stock/${vs[0].id}`} className="btn-ghost group"><Icon name="layers" className="h-4 w-4" />{t.nav.stock}</Link>} />
      {saved && <div className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm font-semibold text-brand-700 ring-1 ring-brand-100"><Icon name="check" className="h-4 w-4" />{t.common.saved}</div>}
      <PushNotes t={t} results={decodePush(push)} />
      <ProductForm t={t} suppliers={suppliers} categories={categories} shopStatus={shopStatus} initial={{
        id: p.id, sku: p.sku, nameDe: p.nameDe, nameNl: p.nameNl, descriptionDe: p.descriptionDe, descriptionNl: p.descriptionNl,
        category: p.category, supplierId: p.supplierId ?? "", vatRateBp: p.vatRateBp,
        purchasePrice: toInput(p.purchasePriceCents), wholesalePrice: toInput(p.wholesalePriceCents), retailPrice: toInput(p.retailPriceCents),
        tracksExpiry: p.tracksExpiry, inBrandShop: p.inBrandShop, inGeneralShop: p.inGeneralShop, imageFileId: p.imageFileId,
        variants: vs.map((v) => ({ id: v.id, size: v.size, color: v.color, barcode: v.barcode ?? "", minStock: v.minStock, stockQty: v.stockQty, imageFileId: v.imageFileId })),
      }} />
      {deletable && <DeleteProduct t={t} id={p.id} />}
    </div>
  );
}

/** Ergebnis „im Shop anlegen“ nach dem Speichern */
function PushNotes({ t, results }: { t: Dict; results: PushResult[] }) {
  if (!results.length) return null;
  const tone = { ok: "bg-emerald-50 text-emerald-800 ring-emerald-100", warn: "bg-amber-50 text-amber-900 ring-amber-200", bad: "bg-red-50 text-red-800 ring-red-200" };
  const notes: { text: string; kind: keyof typeof tone }[] = [];
  for (const r of results) {
    const shop = t.shop.names[r.channel];
    const kind = r.outcome === "created" || r.outcome === "linked" ? "ok" : r.outcome === "failed" ? "bad" : "warn";
    notes.push({ kind, text: fill(t.product.push[r.outcome], { shop, n: r.missing ?? 0, reason: r.reason ? t.product.pushReasons[r.reason] : "" }) });
    if (r.imagesFailed) notes.push({ kind: "warn", text: fill(t.product.push.imagesFailed, { shop }) });
  }
  return (
    <div className="mb-4 space-y-2">
      {notes.map((n, i) => (
        <div key={i} className={`flex animate-rise items-start gap-2 rounded-xl px-4 py-3 text-sm font-semibold ring-1 ${tone[n.kind]}`}>
          <Icon name={n.kind === "ok" ? "check" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />{n.text}
        </div>
      ))}
    </div>
  );
}
