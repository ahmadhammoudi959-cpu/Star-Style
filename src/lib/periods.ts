/** Monatsabschluss: Belege in abgeschlossenen Monaten können nicht mehr angelegt oder geändert werden. */
import { eq } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { todayIso } from "./dates";

export class PeriodLockedError extends Error {
  constructor(public month: string) { super("periodLocked"); }
}

export const monthOf = (iso: string) => iso.slice(0, 7);

export async function lockedMonths(tx: Tx | typeof db = db): Promise<Set<string>> {
  const rows = await tx.select({ month: schema.periodLocks.month }).from(schema.periodLocks);
  return new Set(rows.map((r) => r.month));
}

export async function assertOpen(tx: Tx | typeof db, ...dates: (string | null | undefined)[]) {
  const locked = await lockedMonths(tx);
  for (const d of dates) if (d && locked.has(monthOf(d))) throw new PeriodLockedError(monthOf(d));
}

/** Nur vergangene Monate können abgeschlossen werden. */
export async function lockMonth(month: string, userId?: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("month");
  if (month >= monthOf(todayIso())) throw new Error("notPast");
  await db.insert(schema.periodLocks).values({ month, userId }).onConflictDoNothing();
}

export async function unlockMonth(month: string) {
  await db.delete(schema.periodLocks).where(eq(schema.periodLocks.month, month));
}

/** Erster und letzter Tag eines Monats */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
