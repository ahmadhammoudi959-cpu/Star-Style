import { sql } from "drizzle-orm";
import type { Tx } from "@/db";

const PREFIX = {
  OFFER: "AN",
  INVOICE: "RE",
  CANCELLATION: "ST",
  RECEIPT: "WE",
  WRITE_OFF: "AB",
  PAYMENT: "QU",
} as const;
export type DocKind = keyof typeof PREFIX;

/**
 * Vergibt die nächste lückenlose Nummer (z. B. RE-2026-0001).
 * Muss innerhalb derselben Transaktion wie das Dokument laufen:
 * wird die Transaktion zurückgerollt, wird auch die Nummer nicht verbraucht.
 */
export async function nextNumber(tx: Tx, kind: DocKind, year = new Date().getFullYear()): Promise<string> {
  const res = await tx.execute<{ value: number }>(sql`
    insert into number_sequences (id, kind, year, next)
    values (${crypto.randomUUID()}, ${kind}, ${year}, 2)
    on conflict (kind, year) do update set next = number_sequences.next + 1
    returning next - 1 as value
  `);
  const n = Number(res.rows[0].value);
  return `${PREFIX[kind]}-${year}-${String(n).padStart(4, "0")}`;
}
