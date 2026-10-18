import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { nextNumber } from "./numbering";

const { variants, batches, stockMovements } = schema;

export class StockError extends Error {
  constructor(public code: "NOT_ENOUGH" | "UNKNOWN_VARIANT" | "EXPIRY_REQUIRED" | "INVALID", public detail?: string) {
    super(code);
  }
}

type MovementType = (typeof schema.movementType.enumValues)[number];
type Channel = (typeof schema.channel.enumValues)[number];

/** Schreibt eine Bewegung und hält den Bestands-Cache synchron. */
export async function bookMovement(tx: Tx, m: {
  variantId: string; qty: number; type: MovementType; unitCostCents: number; batchId?: string | null;
  refType?: string; refId?: string; note?: string; userId?: string; channel?: Channel | null;
}) {
  if (!Number.isInteger(m.qty) || m.qty === 0) throw new StockError("INVALID", "qty");
  await tx.insert(stockMovements).values({
    variantId: m.variantId, qty: m.qty, type: m.type, unitCostCents: m.unitCostCents, batchId: m.batchId ?? null,
    refType: m.refType, refId: m.refId, note: m.note ?? "", userId: m.userId, channel: m.channel ?? null,
  });
  await tx.update(variants).set({ stockQty: sql`${variants.stockQty} + ${m.qty}` }).where(eq(variants.id, m.variantId));
  await markDirty(tx, [m.variantId]);
}

/** Bestand an die Shops melden (wird nach dem Speichern im Hintergrund erledigt) */
export async function markDirty(tx: Tx, variantIds: string[]) {
  for (const v of new Set(variantIds)) {
    await tx.execute(sql`insert into stock_dirty (variant_id, at) values (${v}, now()) on conflict (variant_id) do update set at = now()`);
  }
}

/** Sperrt die Variante für die Dauer der Transaktion (verhindert Doppelverkäufe). */
async function lockVariant(tx: Tx, variantId: string) {
  const rows = await tx.execute<{ id: string; stock_qty: number; avg_cost_cents: number; tracks_expiry: boolean }>(sql`
    select v.id, v.stock_qty, v.avg_cost_cents, p.tracks_expiry
    from variants v join products p on p.id = v.product_id
    where v.id = ${variantId} for update of v`);
  const v = rows.rows[0];
  if (!v) throw new StockError("UNKNOWN_VARIANT", variantId);
  return { stockQty: Number(v.stock_qty), avgCostCents: Number(v.avg_cost_cents), tracksExpiry: Boolean(v.tracks_expiry) };
}

/** Zugang: legt eine Charge an und aktualisiert den gleitenden Durchschnitts-EK. */
export async function addStock(tx: Tx, a: {
  variantId: string; qty: number; unitCostCents: number; batchNo?: string; expiryDate?: string | null;
  type: MovementType; refType: string; refId: string; note?: string; userId?: string;
}) {
  if (!Number.isInteger(a.qty) || a.qty <= 0) throw new StockError("INVALID", "qty");
  if (!Number.isInteger(a.unitCostCents) || a.unitCostCents < 0) throw new StockError("INVALID", "cost");
  const v = await lockVariant(tx, a.variantId);
  if (v.tracksExpiry && !a.expiryDate && a.type === "RECEIPT") throw new StockError("EXPIRY_REQUIRED", a.variantId);
  const [batch] = await tx.insert(batches).values({
    variantId: a.variantId, batchNo: a.batchNo ?? "", expiryDate: a.expiryDate || null,
    unitCostCents: a.unitCostCents, qtyReceived: a.qty, qtyLeft: a.qty,
  }).returning({ id: batches.id });
  const base = Math.max(v.stockQty, 0);
  const newAvg = base > 0 ? Math.round((base * v.avgCostCents + a.qty * a.unitCostCents) / (base + a.qty)) : a.unitCostCents;
  await tx.update(variants).set({ avgCostCents: newAvg }).where(eq(variants.id, a.variantId));
  await bookMovement(tx, { ...a, batchId: batch.id });
  return batch.id;
}

/**
 * Abgang nach FEFO (zuerst ablaufende Charge, dann älteste).
 * Liefert die verbrauchten Chargen mit ihrem EK (für Wareneinsatz und Protokolle).
 */
export async function removeStock(tx: Tx, r: {
  variantId: string; qty: number; type: MovementType; refType: string; refId: string; note?: string; userId?: string;
  channel?: Channel | null; batchId?: string | null; allowNegative?: boolean;
}) {
  if (!Number.isInteger(r.qty) || r.qty <= 0) throw new StockError("INVALID", "qty");
  const v = await lockVariant(tx, r.variantId);
  if (!r.allowNegative && v.stockQty < r.qty) throw new StockError("NOT_ENOUGH", `${v.stockQty}`);

  const open = await tx.select().from(batches)
    .where(and(eq(batches.variantId, r.variantId), gt(batches.qtyLeft, 0), r.batchId ? eq(batches.id, r.batchId) : undefined))
    .orderBy(sql`${batches.expiryDate} asc nulls last`, asc(batches.receivedAt))
    .for("update");

  let left = r.qty;
  const used: { batchId: string | null; qty: number; unitCostCents: number }[] = [];
  for (const b of open) {
    if (left === 0) break;
    const take = Math.min(left, b.qtyLeft);
    await tx.update(batches).set({ qtyLeft: b.qtyLeft - take }).where(eq(batches.id, b.id));
    used.push({ batchId: b.id, qty: take, unitCostCents: b.unitCostCents });
    left -= take;
  }
  if (left > 0) {
    if (r.batchId && !r.allowNegative) throw new StockError("NOT_ENOUGH", "batch");
    // Rest ohne Charge (z. B. Bestand aus Inventur) zum Durchschnitts-EK
    used.push({ batchId: null, qty: left, unitCostCents: v.avgCostCents });
  }
  for (const u of used) {
    await bookMovement(tx, {
      variantId: r.variantId, qty: -u.qty, type: r.type, unitCostCents: u.unitCostCents, batchId: u.batchId,
      refType: r.refType, refId: r.refId, note: r.note, userId: r.userId, channel: r.channel,
    });
  }
  return used;
}

export async function audit(tx: Tx, entry: { entity: string; entityId: string; action: string; before?: unknown; after?: unknown; userId?: string }) {
  await tx.insert(schema.auditLog).values({
    entity: entry.entity, entityId: entry.entityId, action: entry.action,
    before: entry.before ?? null, after: entry.after ?? null, userId: entry.userId,
  });
}

// ───────────────────────── Anwendungsfälle ─────────────────────────

export type ReceiptInput = {
  supplierId?: string | null; date: string; supplierInvoiceNo?: string; note?: string;
  lines: { variantId: string; qty: number; unitCostCents: number; batchNo?: string; expiryDate?: string | null }[];
};

export async function receiveGoods(input: ReceiptInput, userId?: string) {
  if (!input.lines.length) throw new StockError("INVALID", "lines");
  return db.transaction(async (tx) => {
    const number = await nextNumber(tx, "RECEIPT", Number(input.date.slice(0, 4)));
    const [rec] = await tx.insert(schema.goodsReceipts).values({
      number, supplierId: input.supplierId || null, date: input.date,
      supplierInvoiceNo: input.supplierInvoiceNo ?? "", note: input.note ?? "",
    }).returning();
    for (const l of input.lines) {
      const batchId = await addStock(tx, { ...l, type: "RECEIPT", refType: "receipt", refId: rec.id, userId });
      await tx.insert(schema.receiptLines).values({
        receiptId: rec.id, variantId: l.variantId, batchId, qty: l.qty, unitCostCents: l.unitCostCents,
        batchNo: l.batchNo ?? "", expiryDate: l.expiryDate || null,
      });
    }
    await audit(tx, { entity: "goods_receipt", entityId: rec.id, action: "create", after: input, userId });
    return rec;
  });
}

type WriteOffReason = (typeof schema.writeOffReason.enumValues)[number];

export async function bookWriteOff(input: {
  date: string; reason: WriteOffReason; note?: string; photoFileId?: string | null;
  lines: { variantId: string; qty: number; batchId?: string | null }[];
}, userId?: string) {
  if (!input.lines.length) throw new StockError("INVALID", "lines");
  return db.transaction(async (tx) => {
    const number = await nextNumber(tx, "WRITE_OFF", Number(input.date.slice(0, 4)));
    const [wo] = await tx.insert(schema.writeOffs).values({
      number, date: input.date, reason: input.reason, note: input.note ?? "", photoFileId: input.photoFileId ?? null,
    }).returning();
    for (const l of input.lines) {
      const used = await removeStock(tx, {
        variantId: l.variantId, qty: l.qty, batchId: l.batchId, type: "WRITE_OFF", refType: "writeoff", refId: wo.id,
        note: input.reason, userId,
      });
      for (const u of used) {
        await tx.insert(schema.writeOffLines).values({
          writeOffId: wo.id, variantId: l.variantId, batchId: u.batchId, qty: u.qty, unitCostCents: u.unitCostCents,
        });
      }
    }
    await audit(tx, { entity: "write_off", entityId: wo.id, action: "create", after: input, userId });
    return wo;
  });
}

/** Inventur: setzt den Bestand auf die gezählte Menge. */
export async function adjustStock(variantId: string, counted: number, reason: string, userId?: string) {
  if (!Number.isInteger(counted) || counted < 0) throw new StockError("INVALID", "counted");
  return db.transaction(async (tx) => {
    const v = await lockVariant(tx, variantId);
    const diff = counted - v.stockQty;
    if (diff === 0) return 0;
    const refId = crypto.randomUUID();
    if (diff > 0) {
      await addStock(tx, { variantId, qty: diff, unitCostCents: v.avgCostCents, type: "ADJUSTMENT", refType: "adjustment", refId, note: reason, userId });
    } else {
      await removeStock(tx, { variantId, qty: -diff, type: "ADJUSTMENT", refType: "adjustment", refId, note: reason, userId, allowNegative: true });
    }
    await audit(tx, { entity: "variant", entityId: variantId, action: "stocktake", before: { qty: v.stockQty }, after: { qty: counted, reason }, userId });
    return diff;
  });
}
