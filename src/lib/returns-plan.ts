/**
 * Retoure planen – rein (keine Datenbank), auch im Browser (Vorschau im Formular) und auf dem Server (Buchung) benutzt.
 * Getestet in tests/returns.test.ts.
 *
 * Je Position der Rechnung: wie viele Stück zurück ins Lager (verkaufbar) und wie viele beschädigt (→ Verlust).
 * Positionen ohne Artikel (z. B. Versandkosten) können nur gutgeschrieben werden („zurück“ = Gutschrift, kein Lager).
 * Behalten = verkauft − zurück − beschädigt; nichts behalten = ganze Rechnung storniert, sonst Storno + neue Rechnung
 * mit den behaltenen Mengen (gleiche Preise, Rabatte, Steuer).
 */
import { computeTotals } from "./tax";

export const RETURN_REASONS = ["wrong", "damaged", "unwanted", "quality", "other"] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];
export const isReturnReason = (r: unknown): r is ReturnReason => typeof r === "string" && (RETURN_REASONS as readonly string[]).includes(r);

export type PlanLine = {
  id: string; position: number; variantId: string | null; description: string; qty: number;
  unitPriceCents: number; discountBp: number; vatRateBp: number; externalLineId?: string | null;
};
export type PlanInvoice = { grossCents: number; discountBp: number; pricesGross: boolean; paidCents: number; lines: PlanLine[] };
export type PlanPick = { lineId: string; restock: number; damaged: number };

export type ReturnPlan =
  | { ok: false; error: "nothing" | "qty" | "unknownLine" | "damagedNoGoods"; lineId?: string }
  | {
    ok: true;
    /** alles zurück → nur Storno, keine neue Rechnung */
    full: boolean;
    /** Positionen der neuen Rechnung (Menge = behalten) */
    keep: PlanLine[];
    /** je Position und Zustand (nur Mengen > 0), in der Reihenfolge der Rechnung */
    lines: { line: PlanLine; qty: number; condition: "RESTOCK" | "DAMAGED" }[];
    newGrossCents: number;
    /** Gutschrift brutto = alter − neuer Rechnungsbetrag */
    creditCents: number;
    /** höchstens auszahlbar: bisher bezahlt − neuer Rechnungsbetrag */
    refundableCents: number;
    units: number;
  };

const whole = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function planReturn(inv: PlanInvoice, picks: PlanPick[]): ReturnPlan {
  const byId = new Map(inv.lines.map((l) => [l.id, l]));
  const back = new Map<string, { restock: number; damaged: number }>();
  for (const p of picks) {
    const l = byId.get(p.lineId);
    if (!l) return { ok: false, error: "unknownLine", lineId: p.lineId };
    if (!whole(p.restock) || !whole(p.damaged)) return { ok: false, error: "qty", lineId: p.lineId };
    if (p.damaged > 0 && !l.variantId) return { ok: false, error: "damagedNoGoods", lineId: p.lineId };
    const prev = back.get(p.lineId) ?? { restock: 0, damaged: 0 };
    const next = { restock: prev.restock + p.restock, damaged: prev.damaged + p.damaged };
    if (next.restock + next.damaged > l.qty) return { ok: false, error: "qty", lineId: p.lineId };
    back.set(p.lineId, next);
  }
  const ordered = [...inv.lines].sort((a, b) => a.position - b.position);
  const lines: { line: PlanLine; qty: number; condition: "RESTOCK" | "DAMAGED" }[] = [];
  const keep: PlanLine[] = [];
  let units = 0;
  for (const l of ordered) {
    const b = back.get(l.id) ?? { restock: 0, damaged: 0 };
    if (b.restock > 0) lines.push({ line: l, qty: b.restock, condition: "RESTOCK" });
    if (b.damaged > 0) lines.push({ line: l, qty: b.damaged, condition: "DAMAGED" });
    units += b.restock + b.damaged;
    const rest = l.qty - b.restock - b.damaged;
    if (rest > 0) keep.push({ ...l, qty: rest });
  }
  if (units === 0) return { ok: false, error: "nothing" };
  const full = keep.length === 0;
  const newGrossCents = full ? 0 : computeTotals(keep, inv.discountBp, { gross: inv.pricesGross }).grossCents;
  return {
    ok: true, full, keep, lines, newGrossCents, units,
    creditCents: Math.max(inv.grossCents - newGrossCents, 0),
    refundableCents: Math.max(inv.paidCents - newGrossCents, 0),
  };
}

/**
 * Beschädigte Ware gezielt aus den Chargen nehmen, die mit dieser Retoure zurückgekommen sind (Verlust zum EK der verkauften
 * Ware); reicht das nicht (sollte nie passieren), den Rest ohne feste Charge (FEFO).
 */
export function allocateDamaged(qty: number, batches: { id: string; qtyLeft: number }[]): { batchId: string | null; qty: number }[] {
  const out: { batchId: string | null; qty: number }[] = [];
  let left = qty;
  for (const b of batches) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(b.qtyLeft, 0));
    if (take > 0) { out.push({ batchId: b.id, qty: take }); left -= take; }
  }
  if (left > 0) out.push({ batchId: null, qty: left });
  return out;
}
