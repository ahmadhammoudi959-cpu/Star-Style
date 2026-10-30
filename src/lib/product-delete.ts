import "server-only";
/**
 * Artikel endgültig löschen – nur für Test- oder Fehleinträge (Wunsch Inhaber).
 * Erlaubt nur, solange der Artikel nie in Angebot, Rechnung oder Verlust stand und kein Shop dafür Bestand zeigt
 * (verbunden mit laufendem Abgleich oder schon Bestand gemeldet).
 * Löscht mit: Varianten, Chargen, Lagerbewegungen, Wareneingangszeilen (leer gewordene Wareneingänge ganz), Reservierungen, Fotos.
 * Der Vorher-Stand bleibt im audit_log.
 */
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";

export class ProductDeleteError extends Error {
  constructor(public code: "notFound" | "productUsed" | "productLinked") { super(code); }
}

/** true, wenn der Artikel gelöscht werden darf (nie in Angebot, Rechnung oder Verlust) */
export async function productDeletable(productId: string) {
  const r = await db.execute<{ used: boolean }>(sql`select
      exists(select 1 from invoice_lines x join variants v on v.id = x.variant_id where v.product_id = ${productId})
   or exists(select 1 from offer_lines x join variants v on v.id = x.variant_id where v.product_id = ${productId})
   or exists(select 1 from write_off_lines x join variants v on v.id = x.variant_id where v.product_id = ${productId}) as used`);
  return !r.rows[0]?.used;
}

export async function deleteProduct(id: string, userId?: string) {
  return db.transaction(async (tx) => {
    const p = await tx.query.products.findFirst({ where: eq(schema.products.id, id), with: { variants: true } });
    if (!p) throw new ProductDeleteError("notFound");
    const vids = p.variants.map((v) => v.id);

    let receipts: { id: string; number: string }[] = [];
    let removedReceipts: string[] = [];
    if (vids.length) {
      const used = [
        ...(await tx.select({ id: schema.invoiceLines.id }).from(schema.invoiceLines).where(inArray(schema.invoiceLines.variantId, vids)).limit(1)),
        ...(await tx.select({ id: schema.offerLines.id }).from(schema.offerLines).where(inArray(schema.offerLines.variantId, vids)).limit(1)),
        ...(await tx.select({ id: schema.writeOffLines.id }).from(schema.writeOffLines).where(inArray(schema.writeOffLines.variantId, vids)).limit(1)),
      ];
      if (used.length) throw new ProductDeleteError("productUsed");
      // gesperrt, solange der Shop dafür Bestand zeigt: Abgleich läuft oder schon Bestand gemeldet (sonst bliebe der Shop-Bestand stehen)
      const linked = await tx.select({ ch: schema.shopVariants.channel }).from(schema.shopVariants)
        .innerJoin(schema.shops, eq(schema.shops.channel, schema.shopVariants.channel))
        .where(and(inArray(schema.shopVariants.variantId, vids), or(eq(schema.shops.active, true), gt(schema.shopVariants.lastPushedQty, 0)))).limit(1);
      if (linked.length) throw new ProductDeleteError("productLinked");

      const receiptIds = [...new Set((await tx.select({ r: schema.receiptLines.receiptId }).from(schema.receiptLines)
        .where(inArray(schema.receiptLines.variantId, vids))).map((x) => x.r))];
      if (receiptIds.length) receipts = await tx.select({ id: schema.goodsReceipts.id, number: schema.goodsReceipts.number }).from(schema.goodsReceipts)
        .where(inArray(schema.goodsReceipts.id, receiptIds));

      await tx.delete(schema.stockDirty).where(inArray(schema.stockDirty.variantId, vids));
      await tx.delete(schema.stockMovements).where(inArray(schema.stockMovements.variantId, vids));
      await tx.delete(schema.receiptLines).where(inArray(schema.receiptLines.variantId, vids));
      if (receiptIds.length) {
        removedReceipts = (await tx.delete(schema.goodsReceipts).where(and(inArray(schema.goodsReceipts.id, receiptIds),
          sql`not exists (select 1 from receipt_lines rl where rl.receipt_id = ${schema.goodsReceipts.id})`)).returning({ number: schema.goodsReceipts.number }))
          .map((r) => r.number);
      }
    }
    // Varianten, Chargen und Reservierungen per Kaskade; Shop-Zuordnungen (nur pausierte Shops) werden gelöst
    await tx.delete(schema.products).where(eq(schema.products.id, id));

    // Fotos löschen, die sonst niemand benutzt
    const files = [...new Set([p.imageFileId, ...p.variants.map((v) => v.imageFileId)].filter((f): f is string => Boolean(f)))];
    for (const f of files) {
      const still = await tx.execute(sql`select 1 from products where image_file_id = ${f} union all select 1 from variants where image_file_id = ${f} limit 1`);
      if (!still.rows.length) await tx.delete(schema.storedFiles).where(eq(schema.storedFiles.id, f));
    }

    const { variants, ...product } = p;
    await audit(tx, {
      entity: "product", entityId: id, action: "delete", userId,
      before: {
        product, variants: variants.map((v) => ({ id: v.id, size: v.size, color: v.color, barcode: v.barcode, stockQty: v.stockQty, avgCostCents: v.avgCostCents })),
        receipts: receipts.map((r) => r.number), removedReceipts,
      },
    });
    return { removedReceipts };
  });
}
