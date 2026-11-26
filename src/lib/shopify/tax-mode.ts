import "server-only";
/**
 * Preise im Shop mit oder ohne MwSt. (Wunsch Inhaber 26.11.2026: „الأسعار بالمتجر كلياتها ناتو، وعلى التشيك أوت بروتو“ –
 * im Shop Nettopreise, die 19 % kommen erst an der Kasse dazu; mit gültiger USt-IdNr. aus einem anderen EU-Land keine).
 * Eingestellt wird das in Shopify: Einstellungen → Steuern und Zölle → „Umsatzsteuer im Produktpreis und Versandtarif
 * einschließen“ (Admin API `shop.taxesIncluded`). Das System meldet Preise schon immer passend dazu (pushPrices,
 * pushResellerPrices lesen die Einstellung bei jedem Senden) – aber nur, wenn sich ein Preis ändert. Darum merkt sich das
 * System die Einstellung je Shop (shops.taxes_included); ändert sie sich, schickt der Worker sofort ALLE Preise neu
 * (Shop-Preise + Festpreise der Wiederverkäufer), sonst gälten die alten Bruttopreise im Shop als Nettopreise (+19 % an der Kasse).
 * Prüfung im Worker jede Minute. Klappt das Senden nicht ganz (Shop kurz weg), bleibt der alte Wert stehen → nächster Versuch.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { gql, getShop, type ShopChannel } from "./client";
import { CHANNELS, logEvent } from "./sync";
import { pushPrices } from "./prices";
import { pushResellerPrices } from "./b2b";
import { shopConfigured as configured, taxModeAction, type TaxModeAction } from "./tax-mode-map";

async function remember(channel: ShopChannel, taxesIncluded: boolean) {
  await db.update(schema.shops).set({ taxesIncluded }).where(eq(schema.shops.channel, channel));
}

/** Worker: Einstellung beider Shops nachsehen; bei Änderung alle Preise neu senden. Gibt je Shop zurück, was passiert ist. */
export async function watchTaxModes(): Promise<{ channel: ShopChannel; action: TaxModeAction; ok: boolean }[]> {
  const out: { channel: ShopChannel; action: TaxModeAction; ok: boolean }[] = [];
  for (const channel of CHANNELS) {
    const shop = await getShop(channel);
    if (!shop || !configured(shop)) continue;
    let current: boolean;
    try {
      current = (await gql<{ shop: { taxesIncluded: boolean } }>(shop, `{ shop { taxesIncluded } }`)).shop.taxesIncluded;
    } catch { continue; } // Shop kurz weg → nächste Minute
    const action = taxModeAction(shop.taxesIncluded, current);
    if (action === "none") continue;
    if (action === "store") { await remember(channel, current); out.push({ channel, action, ok: true }); continue; }
    await logEvent(channel, "info", "products", `taxMode:${current ? "gross" : "net"}`);
    const prices = await pushPrices(undefined, channel);
    const resale = await pushResellerPrices(undefined, channel).catch((e) => { console.error("shopify reseller prices", e); return [{ retry: true }]; });
    const ok = !prices.some((r) => r.retry) && !resale.some((r) => r.retry);
    if (ok) await remember(channel, current);
    out.push({ channel, action, ok });
  }
  return out;
}
