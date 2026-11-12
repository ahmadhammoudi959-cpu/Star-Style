/**
 * Eine Shop-Bestellung nie gleichzeitig zweimal bearbeiten (Webhook, 5-min-Abgleich, Sendung melden).
 * Sonst könnte z. B. der Webhook nach unserem Fulfillment die Sendung als „im Shop versendet“ doppelt übernehmen.
 */
const locks = new Map<string, Promise<unknown>>();

export function withOrderLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
}
