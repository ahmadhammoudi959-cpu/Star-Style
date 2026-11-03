import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { fill, getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { formatCents } from "@/lib/money";
import { daysBetween, formatDate, todayIso } from "@/lib/dates";
import { variantLabel } from "@/lib/queries";
import { AdjustForm } from "./AdjustForm";

export default async function VariantStock({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t, intl } = await getI18n();
  const v = await db.query.variants.findFirst({ where: eq(schema.variants.id, id), with: { product: true } });
  if (!v) notFound();
  const [bs, moves, res] = await Promise.all([
    db.select().from(schema.batches).where(and(eq(schema.batches.variantId, id), gt(schema.batches.qtyLeft, 0))).orderBy(schema.batches.expiryDate),
    db.select().from(schema.stockMovements).where(eq(schema.stockMovements.variantId, id)).orderBy(desc(schema.stockMovements.createdAt)).limit(100),
    db.execute<{ reserved: number }>(sql`select coalesce(sum(qty), 0)::int as reserved from reservations where variant_id = ${id} and active and expires_at > now()`),
  ]);
  const reserved = Number(res.rows[0]?.reserved ?? 0);
  const variant = [v.size, v.color].filter(Boolean).join(" · ");
  const low = v.minStock > 0 && v.stockQty <= v.minStock;
  const today = todayIso();
  const typeColor: Record<string, string> = {
    RECEIPT: "bg-sky-100 text-sky-800", SALE: "bg-brand-100 text-brand-700", RETURN: "bg-violet-100 text-violet-800",
    WRITE_OFF: "bg-red-100 text-red-800", ADJUSTMENT: "bg-amber-100 text-amber-800", CANCEL: "bg-gray-100 text-gray-700",
  };
  // Bewegung → Beleg dahinter (Verlustprotokoll, Wareneingang)
  const refLink = (refType: string | null, refId: string | null) =>
    !refId ? null : refType === "writeoff" ? { href: `/write-offs/${refId}`, label: t.writeOff.protocol }
      : refType === "receipt" ? { href: `/receive/${refId}`, label: t.receive.openReceipt } : null;

  return (
    <div>
      <PageHeader title={variantLabel(v.product.nameDe, v.size, v.color)} back="/stock"
        actions={<Link href={`/products/${v.productId}`} className="btn-primary group"><Icon name="edit" className="h-4 w-4" />{t.product.edit}</Link>} />
      {/* Das Produkt auf einen Blick: Foto, Nummern, Kategorie */}
      <section className="card mb-4 flex flex-col gap-4 p-4 animate-rise sm:flex-row sm:items-center">
        <Thumb id={v.imageFileId ?? v.product.imageFileId} size={96} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="text-lg font-bold leading-snug [overflow-wrap:anywhere]" dir="auto">{v.product.nameDe}</div>
          {v.product.nameNl && <div className="text-sm text-ink-soft [overflow-wrap:anywhere]" dir="auto">{v.product.nameNl}</div>}
          <div className="flex flex-wrap gap-1.5 text-xs">
            {variant && <span className="badge bg-brand-50 text-brand-700" dir="auto">{variant}</span>}
            {v.product.category && <span className="badge bg-black/5 text-ink-soft">{v.product.category}</span>}
            <span className="badge bg-white text-ink ring-1 ring-black/10">{t.product.sku}: <bdi dir="ltr" className="tabular-nums">{v.product.sku}</bdi></span>
            {v.barcode && <span className="badge bg-white text-ink ring-1 ring-black/10">{t.product.barcode}: <bdi dir="ltr" className="tabular-nums">{v.barcode}</bdi></span>}
          </div>
        </div>
      </section>
      <div className="stagger grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className={`card p-5 ${v.stockQty < 0 ? "ring-2 ring-red-200" : low ? "ring-2 ring-amber-200" : ""}`}>
          <div className="text-sm text-ink-soft">{t.product.stock}</div>
          <div className={`num text-3xl font-bold ${v.stockQty < 0 ? "text-red-600" : low ? "text-amber-600" : ""}`}>{v.stockQty}</div>
          {v.minStock > 0 && <div className="text-xs text-ink-soft">{t.product.minStock}: {v.minStock}</div>}
        </div>
        <div className="card p-5">
          <div className="text-sm text-ink-soft">{t.product.available}</div>
          <div className="num text-3xl font-bold">{v.stockQty - reserved}</div>
          {reserved > 0 && <div className="text-xs text-ink-soft">{t.product.reserved}: {reserved}</div>}
        </div>
        <div className="card p-5"><div className="text-sm text-ink-soft">{t.stock.avgCost}</div><div className="num text-2xl font-bold">{formatCents(v.avgCostCents, intl)}</div></div>
        <div className="card p-5"><div className="text-sm text-ink-soft">{t.stock.value}</div><div className="num text-2xl font-bold">{formatCents(Math.max(v.stockQty, 0) * v.avgCostCents, intl)}</div></div>
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
                  const ref = refLink(m.refType, m.refId);
                  return (
                    <tr key={m.id}>
                      <td className="num whitespace-nowrap">{formatDate(m.createdAt.toISOString(), intl)}</td>
                      <td><span className={`badge ${typeColor[m.type]}`}>{t.stock.type[m.type]}</span></td>
                      <td className={`num text-end font-semibold ${m.qty < 0 ? "text-red-600" : "text-brand-700"}`} dir="ltr">{m.qty > 0 ? `+${m.qty}` : m.qty}</td>
                      <td className="num text-end">{formatCents(m.unitCostCents, intl)}</td>
                      <td className="text-ink-soft">{ref ? <Link className="font-semibold text-brand-700 underline" href={ref.href}>{ref.label}</Link> : (t.writeOff.reasons as Record<string, string>)[m.note] ?? m.note}</td>
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
