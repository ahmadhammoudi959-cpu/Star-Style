/**
 * Zahlungsstand einer Rechnung – reine Funktion (keine Datenbank), vollständig getestet.
 * Zahlungen werden der Reihe nach auf die Raten angerechnet (älteste Rate zuerst).
 */
import { daysBetween } from "./dates";

export type PayStatus = "PAID" | "OPEN" | "PARTIAL" | "OVERDUE" | "CREDIT";

export type PaymentState = {
  paidCents: number;
  openCents: number;          // > 0 offen, < 0 Guthaben des Kunden (zu erstatten)
  overdueCents: number;       // Summe der fälligen, unbezahlten Raten
  daysOverdue: number;        // Tage seit der ältesten unbezahlten fälligen Rate
  nextDueDate: string | null; // nächste (noch nicht voll bezahlte) Rate
  nextDueCents: number;
  status: PayStatus;
  schedule: { dueDate: string; amountCents: number; paidCents: number; openCents: number }[];
};

export function paymentState(inv: {
  grossCents: number; dueDate: string | null; issueDate: string | null;
  installments: { dueDate: string; amountCents: number }[];
  payments: { amountCents: number; skontoCents?: number; cancelledAt?: Date | string | null }[];
}, today: string): PaymentState {
  // Gewährtes Skonto zählt wie bezahlt (Rechnung ist damit erledigt)
  const paidCents = inv.payments.filter((p) => !p.cancelledAt).reduce((s, p) => s + p.amountCents + (p.skontoCents ?? 0), 0);
  const openCents = inv.grossCents - paidCents;
  const plan = inv.installments.length
    ? [...inv.installments].sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    : [{ dueDate: inv.dueDate ?? inv.issueDate ?? today, amountCents: inv.grossCents }];

  let pool = Math.max(paidCents, 0);
  const schedule = plan.map((r) => {
    const paid = Math.min(pool, r.amountCents);
    pool -= paid;
    return { dueDate: r.dueDate, amountCents: r.amountCents, paidCents: paid, openCents: r.amountCents - paid };
  });
  const unpaid = schedule.filter((r) => r.openCents > 0);
  const overdue = unpaid.filter((r) => r.dueDate < today);
  const overdueCents = overdue.reduce((s, r) => s + r.openCents, 0);
  const daysOverdue = overdue.length ? daysBetween(overdue[0].dueDate, today) : 0;
  const next = unpaid[0] ?? null;

  let status: PayStatus;
  if (openCents < 0) status = "CREDIT";
  else if (openCents === 0) status = "PAID";
  else if (overdueCents > 0) status = "OVERDUE";
  else if (paidCents > 0) status = "PARTIAL";
  else status = "OPEN";

  return { paidCents, openCents, overdueCents, daysOverdue, nextDueDate: next?.dueDate ?? null, nextDueCents: next?.openCents ?? 0, status, schedule };
}

/** Ampel: grün = im Plan, gelb = fällig in ≤ 7 Tagen, rot = überfällig */
export function trafficLight(s: PaymentState, today: string): "green" | "yellow" | "red" | "none" {
  if (s.status === "PAID" || s.status === "CREDIT") return "none";
  if (s.overdueCents > 0) return "red";
  if (s.nextDueDate && daysBetween(today, s.nextDueDate) <= 7) return "yellow";
  return "green";
}

/** Gleichmäßiger Ratenplan; Rundungsrest auf die letzte Rate. */
export function splitInstallments(totalCents: number, firstCents: number, count: number, firstDate: string, everyDays: number, addDays: (d: string, n: number) => string) {
  const rows: { dueDate: string; amountCents: number }[] = [];
  let rest = totalCents;
  if (firstCents > 0) { rows.push({ dueDate: firstDate, amountCents: firstCents }); rest -= firstCents; }
  const n = Math.max(count - (firstCents > 0 ? 1 : 0), 0);
  if (n > 0 && rest > 0) {
    const each = Math.floor(rest / n);
    for (let i = 0; i < n; i++) {
      rows.push({ dueDate: addDays(firstDate, everyDays * (firstCents > 0 ? i + 1 : i)), amountCents: i === n - 1 ? rest - each * (n - 1) : each });
    }
  }
  return rows;
}
