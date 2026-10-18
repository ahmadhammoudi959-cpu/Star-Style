import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import { fill, getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import { daysBetween, formatDate, todayIso } from "@/lib/dates";
import { variantLabel } from "@/lib/queries";
import { AdjustForm } from "./AdjustForm";

export default async function VariantStock({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, intl } = await getI18n();
  const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, id), with: { product: true } });
  if (!v) notFound();
  const [bs, moves] = await Promise.all([
    db.select().from(schema.batches).where(and(eq(schema.batches.variantId, id), gt(schema.batches.qtyLeft, 0))).orderBy(schema.batches.expiryDate),
    db.select().from(schema.stockMovements).where(eq(schema.stockMovements.variantId, id)).orderBy(desc(schema.stockMovements.createdAt)).limit(100),
  ]);
  const today = todayIso();
  const typeColor: Record<string, string> = {
    RECEIPT: "bg-sky-100 text-sky-800", SALE: "bg-brand-100 text-brand-700", RETURN: "bg-violet-100 text-violet-800",
    WRITE_OFF: "bg-red-100 text-red-800", ADJUSTMENT: "bg-amber-100 text-amber-800", CANCEL: "bg-gray-100 text-gray-700",
  };
  const refLink = (refType: string | null, refId: string | null) =>
    refType === "writeoff" && refId ? `/write-offs/${refId}` : null;

  return (
    <div>
      <PageHeader title={variantLabel(v.product.nameDe, v.size, v.color)} subtitle={v.product.sku} back="/stock"
        actions={<Link href={`/products/${v.productId}`} className="btn-ghost group"><Icon name="edit" className="h-4 w-4" />{t.common.edit}</Link>} />
      <div className="stagger grid gap-4 md:grid-cols-3">
        <div className="card p-5"><div className="text-sm text-ink-soft">{t.product.stock}</div><div className="num text-3xl font-bold">{v.stockQty}</div></div>
        <div className="card p-5"><div className="text-sm text-ink-soft">{t.stock.avgCost}</div><div className="num text-3xl font-bold">{formatCents(v.avgCostCents, intl)}</div></div>
        <div className="card p-5"><div className="text-sm text-ink-soft">{t.stock.value}</div><div className="num text-3xl font-bold">{formatCents(Math.max(v.stockQty, 0) * v.avgCostCents, intl)}</div></div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <section className="card overflow-hidden animate-rise">
            <h2 className="px-5 pt-5 text-lg font-bold">{t.stock.batches}</h2>
            {bs.length === 0 ? <p className="p-5 text-sm text-ink-soft">{t.common.nothingYet}</p> : (
              <div className="table-wrap mt-3"><table className="tbl">
                <thead><tr><th>{t.receive.batchNo}</th><th>{t.receive.expiry}</th><th className="text-end">{t.common.qty}</th><th className="text-end">{t.receive.unitCost}</th></tr></thead>
                <tbody>{bs.map((b) => {
                  const d = b.expiryDate ? daysBetween(today, b.expiryDate) : null;
                  return (
                    <tr key={b.id}>
                      <td dir="ltr">{b.batchNo || t.common.none}</td>
                      <td>{b.expiryDate ? <span className={`badge ${d! < 0 ? "bg-red-100 text-red-800" : d! <= 60 ? "bg-orange-100 text-orange-800" : "bg-brand-50 text-brand-700"}`}>
                        {formatDate(b.expiryDate, intl)} · {d! < 0 ? t.stock.expired : fill(t.stock.expiresIn, { d: d! })}</span> : t.common.none}</td>
                      <td className="num text-end font-semibold">{b.qtyLeft}</td>
                      <td className="num text-end">{formatCents(b.unitCostCents, intl)}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </section>
          <section className="card overflow-hidden animate-rise">
            <h2 className="flex items-center gap-2 px-5 pt-5 text-lg font-bold"><Icon name="history" className="h-5 w-5 text-brand-600" />{t.stock.movements}</h2>
            {moves.length === 0 ? <p className="p-5 text-sm text-ink-soft">{t.common.nothingYet}</p> : (
              <div className="table-wrap mt-3"><table className="tbl">
                <thead><tr><th>{t.common.date}</th><th>{t.common.actions}</th><th className="text-end">{t.common.qty}</th><th className="text-end">{t.receive.unitCost}</th><th>{t.common.note}</th></tr></thead>
                <tbody>{moves.map((m) => {
                  const href = refLink(m.refType, m.refId);
                  return (
                    <tr key={m.id}>
                      <td className="num whitespace-nowrap">{formatDate(m.createdAt.toISOString(), intl)}</td>
                      <td><span className={`badge ${typeColor[m.type]}`}>{t.stock.type[m.type]}</span></td>
                      <td className={`num text-end font-semibold ${m.qty < 0 ? "text-red-600" : "text-brand-700"}`} dir="ltr">{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
                      <td className="num text-end">{formatCents(m.unitCostCents, intl)}</td>
                      <td className="text-ink-soft">{href ? <Link className="underline" href={href}>{t.writeOff.protocol}</Link> : (t.writeOff.reasons as Record<string, string>)[m.note] ?? m.note}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </section>
        </div>
        <aside className="card h-fit p-5 animate-rise">
          <h2 className="mb-3 text-lg font-bold">{t.stock.adjust}</h2>
          <AdjustForm t={t} variantId={v.id} current={v.stockQty} />
        </aside>
      </div>
    </div>
  );
}
