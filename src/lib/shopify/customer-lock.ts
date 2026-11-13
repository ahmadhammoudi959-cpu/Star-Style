import "server-only";
/**
 * Dieselbe E-Mail nie gleichzeitig zu einem Kunden machen (Kunden-Abgleich, Webhooks, Bestell-Import, beide Shops) – sonst
 * entstehen zwei Kunden. Auf globalThis, weil Next das Modul für Worker und Routen getrennt laden kann (wie der
 * Sitzungs-Zwischenspeicher); gilt nur im Prozess → nur EINE Server-Instanz betreiben (wie der Hintergrund-Abgleich).
 */
type Locks = Map<string, Promise<void>>;
const g = globalThis as { __ssCustomerLocks?: Locks };
const locks: Locks = (g.__ssCustomerLocks ??= new Map());

export async function withCustomerLock<T>(email: string, run: () => Promise<T>): Promise<T> {
  const key = email.trim().toLowerCase();
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  locks.set(key, tail);
  await prev;
  try { return await run(); } finally { release(); if (locks.get(key) === tail) locks.delete(key); }
}
