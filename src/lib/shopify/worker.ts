import "server-only";
/**
 * Hintergrund-Abgleich im Server-Prozess (eine Instanz auf Render):
 * - alle 20 s: geänderte Bestände an die Shops melden
 * - alle 5 min: Bestellungen abholen (falls ein Webhook verloren ging) und alle Bestände vergleichen
 */
import { runCycle } from "./sync";

let started = false, busy = false, ticks = 0;

export function startWorker() {
  if (started || process.env.SHOPIFY_WORKER === "off") return;
  started = true;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const full = ticks % 15 === 0; // 15 × 20 s = 5 min
      await runCycle({ orders: full, reconcile: full });
    } catch (e) { console.error("shopify worker", e); }
    finally { busy = false; ticks++; }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, 20_000).unref();
}
