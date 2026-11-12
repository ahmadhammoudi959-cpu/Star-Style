import "server-only";
/**
 * Hintergrund-Abgleich im Server-Prozess (eine Instanz auf Render):
 * - alle 20 s: geänderte Bestände an die Shops melden
 * - alle 5 min: Bestellungen abholen (falls ein Webhook verloren ging) und alle Bestände vergleichen;
 *   im Shop zu löschende Galerie-Fotos und geänderte Preise, bei denen das noch nicht geklappt hat, erneut versuchen
 */
import { runCycle } from "./sync";
import { retryGalleryDeletes } from "./gallery";
import { pushDirtyPrices } from "./prices";
import { retryShipments } from "../shipments";
import { pushResellerPricesPeriodically, retryShopCompanies } from "./b2b";

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
      // im Shop zu löschende Fotos, bei denen es noch nicht geklappt hat (Wahl des Nutzers beim Entfernen)
      if (full) await retryGalleryDeletes().catch((e) => console.error("shopify gallery retry", e));
      // geänderte Preise, die noch nicht im Shop angekommen sind (Shop war kurz nicht erreichbar)
      if (full) await pushDirtyPrices().catch((e) => console.error("shopify prices retry", e));
      // Sendungen, die noch nicht im Shop sind (Shop kurz weg, Abgleich aus, App-Recht fehlte)
      if (full) await retryShipments().catch((e) => console.error("shopify shipments retry", e));
      // Großhandelskunden (جملة الجملة), deren Verbindung im Shop noch aussteht; Preisliste höchstens alle 30 min ganz vergleichen
      if (full) await retryShopCompanies().catch((e) => console.error("shopify b2b retry", e));
      if (full) await pushResellerPricesPeriodically().catch((e) => console.error("shopify reseller prices", e));
    } catch (e) { console.error("shopify worker", e); }
    finally { busy = false; ticks++; }
  };
  setTimeout(tick, 15_000);
  setInterval(tick, 20_000).unref();
}
