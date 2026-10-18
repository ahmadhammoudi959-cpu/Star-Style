/**
 * Intelligente Hinweise ohne KI-Dienst (reine Rechenregeln, vollständig getestet):
 * - Nachbestellen: Verkaufstempo der letzten 90 Tage → Reichweite → Bestellmenge
 * - Ablauf-Risiko: welche Chargen (FEFO) vor dem Ablauf voraussichtlich NICHT verkauft werden
 * - Ladenhüter: Bestand ohne Verkauf in 90 Tagen
 */
import { daysBetween } from "./dates";

export const WINDOW_DAYS = 90;

export type StockItem = {
  variantId: string; name: string; sku: string; supplierId: string | null; supplierName: string;
  stock: number; reserved: number; minStock: number; sold: number; // verkauft in WINDOW_DAYS
  unitCostCents: number; lastReceipt: string | null;
};

export type Reorder = StockItem & { available: number; perDay: number; daysLeft: number | null; qty: number; costCents: number; urgency: "out" | "urgent" | "soon"; belowMin: boolean };

export function reorderSuggestions(items: StockItem[], o: { leadDays?: number; coverDays?: number } = {}): Reorder[] {
  const lead = o.leadDays ?? 14, cover = o.coverDays ?? 60;
  const out: Reorder[] = [];
  for (const it of items) {
    const available = it.stock - it.reserved;
    const perDay = it.sold / WINDOW_DAYS;
    const daysLeft = perDay > 0 ? Math.max(0, Math.floor(available / perDay)) : null;
    const belowMin = it.minStock > 0 && available <= it.minStock;
    const runningOut = perDay > 0 && daysLeft! < lead + 7;
    if (!belowMin && !runningOut) continue;
    const target = Math.ceil(perDay * (lead + cover)) + it.minStock;
    const qty = Math.max(target - available, it.minStock > 0 ? it.minStock - available + 1 : 1, 1);
    const urgency = available <= 0 ? "out" : (daysLeft !== null && daysLeft < lead) || belowMin ? "urgent" : "soon";
    out.push({ ...it, available, perDay, daysLeft, qty, costCents: qty * it.unitCostCents, urgency, belowMin });
  }
  const rank = { out: 0, urgent: 1, soon: 2 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
}

export type BatchItem = { batchId: string; variantId: string; name: string; expiry: string; qtyLeft: number; unitCostCents: number };
export type ExpiryRisk = BatchItem & { daysToExpiry: number; expectedSold: number; riskQty: number; riskCents: number; action: "writeOff" | "discount" | "watch" };

/** Chargen werden nach FEFO verkauft: frühere Chargen verbrauchen zuerst das Verkaufstempo. */
export function expiryRisks(batches: BatchItem[], perDayByVariant: Map<string, number>, today: string, horizonDays = 120): ExpiryRisk[] {
  const byVariant = new Map<string, BatchItem[]>();
  for (const b of batches) byVariant.set(b.variantId, [...(byVariant.get(b.variantId) ?? []), b]);
  const out: ExpiryRisk[] = [];
  for (const [variantId, list] of byVariant) {
    const perDay = perDayByVariant.get(variantId) ?? 0;
    let consumedBefore = 0; // Menge, die frühere Chargen bereits „verbrauchen“
    for (const b of [...list].sort((x, y) => x.expiry.localeCompare(y.expiry))) {
      const days = daysBetween(today, b.expiry);
      if (days > horizonDays) break;
      if (days < 0) {
        out.push({ ...b, daysToExpiry: days, expectedSold: 0, riskQty: b.qtyLeft, riskCents: b.qtyLeft * b.unitCostCents, action: "writeOff" });
        continue;
      }
      const capacity = Math.max(0, Math.floor(perDay * days) - consumedBefore);
      const expectedSold = Math.min(b.qtyLeft, capacity);
      consumedBefore += expectedSold;
      const riskQty = b.qtyLeft - expectedSold;
      if (riskQty <= 0) continue;
      out.push({ ...b, daysToExpiry: days, expectedSold, riskQty, riskCents: riskQty * b.unitCostCents, action: days <= 30 || expectedSold === 0 ? "discount" : "watch" });
    }
  }
  return out.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

export type SlowMover = StockItem & { valueCents: number; daysSinceReceipt: number | null };
export function slowMovers(items: StockItem[], today: string, minAgeDays = 60): SlowMover[] {
  return items
    .filter((i) => i.stock > 0 && i.sold === 0)
    .map((i) => ({ ...i, valueCents: i.stock * i.unitCostCents, daysSinceReceipt: i.lastReceipt ? daysBetween(i.lastReceipt, today) : null }))
    .filter((i) => i.daysSinceReceipt === null || i.daysSinceReceipt >= minAgeDays)
    .sort((a, b) => b.valueCents - a.valueCents);
}
