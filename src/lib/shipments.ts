import "server-only";
/**
 * Versand mit Sendungsverfolgung (Wunsch Inhaber 12.11.2026): Sendung speichern, an Shopify melden, ändern, zurücknehmen,
 * im Shopify-Admin angelegte Sendungen übernehmen. Regeln rein + getestet in ./shipping.ts, Shopify-Aufrufe in ./shopify/fulfill.ts.
 * Nichts wird gelöscht: zurückgenommene Sendungen bleiben mit cancelled_at stehen, jede Änderung steht im audit_log.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { audit } from "./stock";
import { todayIso } from "./dates";
import {
  carrierFromCompany, carrierLabel, checkNumbers, customUrlOk, isCarrier, isDeliveryState, normalizeTrackingNumber, remapItems, resolveItems,
  shippingState, urlTemplate, type ShippingState,
} from "./shipping";
import { getShop, ShopifyError, type ShopChannel } from "./shopify/client";
import { cancelFulfillments, createFulfillment, FulfillError, SCOPE_RE, updateFulfillmentTracking } from "./shopify/fulfill";
import { withOrderLock } from "./shopify/order-lock";
import { berlinDate, type ShopOrder } from "./shopify/order-map";

export type Shipment = typeof schema.shipments.$inferSelect;
export class ShipmentError extends Error {
  constructor(public code: string, public detail = "") { super(code); }
}

/** Zustände, die noch an den Shop müssen (Worker versucht alle 5 min) */
export const SHOP_TODO = ["pending", "update", "cancel"];

type Input = { carrier: string; carrierName: string; numbers: string[]; trackingUrl: string; notify: boolean };
function clean(i: Input) {
  if (!isCarrier(i.carrier)) throw new ShipmentError("carrier");
  const carrierName = i.carrier === "OTHER" ? i.carrierName.trim().slice(0, 60) : "";
  if (i.carrier === "OTHER" && !carrierName) throw new ShipmentError("carrierName");
  const trackingUrl = i.carrier === "OTHER" ? i.trackingUrl.trim().slice(0, 300) : "";
  if (!customUrlOk(trackingUrl)) throw new ShipmentError("url");
  const c = checkNumbers(i.carrier, i.numbers);
  if (c.problem) throw new ShipmentError(c.problem, c.bad ?? "");
  return { carrier: i.carrier, carrierName, trackingUrl, trackingNumbers: c.numbers, notifyCustomer: i.notify };
}
const isShopOrder = (inv: { channel: string; externalOrderId: string | null }) => inv.channel !== "STORE" && Boolean(inv.externalOrderId);

async function shopEvent(channel: string, level: "info" | "warn" | "error", message: string, ref: string, invoiceId: string | null) {
  await db.insert(schema.shopEvents).values({ channel: channel as ShopChannel, level, kind: "shipment", message: message.slice(0, 1000), ref, invoiceId });
}
async function once(key: string) {
  return (await db.insert(schema.shopProcessed).values({ key }).onConflictDoNothing().returning({ key: schema.shopProcessed.key })).length > 0;
}

// ───────────────────────── Speichern, ändern, zurücknehmen ─────────────────────────

/** Neue Sendung: Versanddienst, Nummer je Paket, Inhalt (pick = null → alles, was noch offen ist) */
export async function createShipment(input: Input & { invoiceId: string; pick: Record<string, number> | null }, userId?: string): Promise<string> {
  const data = clean(input);
  return db.transaction(async (tx) => {
    // gleichzeitiges Speichern (Doppelklick) wartet, damit nichts doppelt verschickt wird
    await tx.execute(sql`select id from invoices where id = ${input.invoiceId} for update`);
    const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, input.invoiceId), with: { lines: true } });
    if (!inv) throw new ShipmentError("notFound");
    if (inv.kind !== "INVOICE" || inv.status !== "ISSUED") throw new ShipmentError("notIssued");
    const existing = await tx.select().from(schema.shipments).where(eq(schema.shipments.invoiceId, inv.id));
    const r = resolveItems(inv.lines, existing, input.pick);
    if (r.problem) throw new ShipmentError(r.problem);
    const shop = isShopOrder(inv);
    const [row] = await tx.insert(schema.shipments).values({
      invoiceId: inv.id, channel: inv.channel, externalOrderId: inv.externalOrderId, ...data, notifyCustomer: shop && data.notifyCustomer,
      items: r.items, shippedOn: todayIso(), shopStatus: shop ? "pending" : "none", createdBy: userId ?? null,
    }).returning({ id: schema.shipments.id });
    await audit(tx, { entity: "shipment", entityId: row.id, action: "create", after: { invoice: inv.number, ...data, items: r.items }, userId });
    return row.id;
  });
}

/** Versanddienst/Nummern korrigieren (z. B. Tippfehler); schon im Shop → Änderung wird dort nachgetragen */
export async function editShipment(id: string, input: Input, userId?: string) {
  const data = clean(input);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from shipments where id = ${id} for update`);
    const s = await tx.query.shipments.findFirst({ where: eq(schema.shipments.id, id) });
    if (!s) throw new ShipmentError("notFound");
    if (s.cancelledAt || s.shopStatus === "cancel") throw new ShipmentError("cancelled");
    const shop = s.shopStatus !== "none";
    const next = !shop ? "none" : s.shopFulfillmentIds.length ? "update" : "pending";
    await tx.update(schema.shipments).set({ ...data, notifyCustomer: shop && data.notifyCustomer, shopStatus: next, shopError: "", shopTries: 0 })
      .where(eq(schema.shipments.id, id));
    await audit(tx, {
      entity: "shipment", entityId: id, action: "edit", userId, after: data,
      before: { carrier: s.carrier, carrierName: s.carrierName, trackingNumbers: s.trackingNumbers, trackingUrl: s.trackingUrl },
    });
  });
}

/** Sendung zurücknehmen (falsche Bestellung erwischt); im Shop gilt die Bestellung dann wieder als nicht versendet */
export async function cancelShipment(id: string, userId?: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from shipments where id = ${id} for update`);
    const s = await tx.query.shipments.findFirst({ where: eq(schema.shipments.id, id) });
    if (!s) throw new ShipmentError("notFound");
    if (s.cancelledAt) return;
    if (s.shopFulfillmentIds.length) await tx.update(schema.shipments).set({ shopStatus: "cancel", shopError: "", shopTries: 0 }).where(eq(schema.shipments.id, id));
    else await tx.update(schema.shipments).set({ cancelledAt: new Date(), shopStatus: s.shopStatus === "none" ? "none" : "cancelled", shopError: "" }).where(eq(schema.shipments.id, id));
    await audit(tx, { entity: "shipment", entityId: id, action: "cancel", before: { trackingNumbers: s.trackingNumbers, shopStatus: s.shopStatus }, userId });
  });
}

/** Ausgestellte Korrektur: Sendungen der alten Rechnung wandern mit (wie die Zahlungen), Positionen werden umgehängt */
export async function moveShipments(tx: Tx, fromInvoiceId: string, toInvoiceId: string, userId?: string) {
  const rows = await tx.select().from(schema.shipments).where(eq(schema.shipments.invoiceId, fromInvoiceId));
  if (!rows.length) return;
  const lines = await tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, toInvoiceId));
  for (const r of rows) await tx.update(schema.shipments).set({ invoiceId: toInvoiceId, items: remapItems(r.items, lines) }).where(eq(schema.shipments.id, r.id));
  await audit(tx, { entity: "invoice", entityId: toInvoiceId, action: "shipments_moved", after: { from: fromInvoiceId, count: rows.length }, userId });
}

// ───────────────────────── An Shopify melden ─────────────────────────

/**
 * Offene Aufgabe einer Sendung im Shop erledigen (anlegen / Nummern ändern / zurücknehmen).
 * Shop nicht erreichbar → bleibt vorgemerkt (Worker versucht es wieder); App-Recht fehlt → vorgemerkt + Hinweis „needScope“;
 * Shop lehnt ab → „failed“ mit Meldung. Läuft unter der Sperre der Bestellung (kein Doppel durch den Webhook).
 */
export async function syncShipment(id: string): Promise<Shipment | null> {
  const first = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id) });
  if (!first || !SHOP_TODO.includes(first.shopStatus) || !first.externalOrderId) return first ?? null;
  return withOrderLock(`${first.channel}:${first.externalOrderId}`, async () => {
    const s = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id) });
    if (!s || !SHOP_TODO.includes(s.shopStatus) || !s.externalOrderId) return s ?? null;
    const set = (v: Partial<Shipment>) => db.update(schema.shipments).set(v).where(eq(schema.shipments.id, id));
    const reload = async () => (await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id) })) ?? null;
    const shop = await getShop(s.channel as ShopChannel);
    if (!shop?.domain) { await set({ shopError: "notConfigured" }); return reload(); }
    if (!shop.active) { await set({ shopError: "syncOff" }); return reload(); }
    const label = `${carrierLabel(s.carrier, s.carrierName)} ${s.trackingNumbers.join(" ")}`.trim();
    try {
      if (s.shopStatus === "pending") {
        const want = s.items.flatMap((i) => (i.externalLineId ? [{ externalLineId: i.externalLineId, qty: i.qty }] : []));
        const ids = [...s.shopFulfillmentIds];
        const r = await createFulfillment(shop, s.externalOrderId, want, s, s.notifyCustomer, async (fid) => { ids.push(fid); await set({ shopFulfillmentIds: ids }); });
        await set({ shopStatus: "sent", shopError: r.missing ? `missing:${r.missing}` : "", shopTries: s.shopTries + 1 });
        await shopEvent(s.channel, "info", `shipped:${label}|${s.notifyCustomer ? 1 : 0}`, r.name, s.invoiceId);
      } else if (s.shopStatus === "update") {
        await updateFulfillmentTracking(shop, s.shopFulfillmentIds, s, s.notifyCustomer);
        await set({ shopStatus: "sent", shopError: "", shopTries: s.shopTries + 1 });
        await shopEvent(s.channel, "info", `trackingUpdated:${label}|${s.notifyCustomer ? 1 : 0}`, "", s.invoiceId);
      } else {
        await cancelFulfillments(shop, s.shopFulfillmentIds);
        await set({ shopStatus: "cancelled", cancelledAt: new Date(), shopError: "", shopTries: s.shopTries + 1 });
        await shopEvent(s.channel, "info", `shipmentCancelled:${label}`, "", s.invoiceId);
      }
    } catch (e) {
      const tries = s.shopTries + 1;
      if (e instanceof FulfillError) {
        await set({ shopStatus: "failed", shopError: e.code, shopTries: tries });
      } else if (e instanceof ShopifyError && ["network", "throttled", "auth", "notConfigured"].includes(e.code)) {
        await set({ shopError: e.code, shopTries: tries }); // später noch einmal
      } else if (e instanceof ShopifyError && e.code === "graphql" && SCOPE_RE.test(e.message)) {
        // App-Recht „Bestellungen versenden“ fehlt noch → bleibt vorgemerkt und geht raus, sobald es freigeschaltet ist
        await set({ shopError: "needScope", shopTries: tries });
        if (await once(`scope:fulfil:${s.channel}:${todayIso()}`)) await shopEvent(s.channel, "warn", "needScopeFulfillment", "", s.invoiceId);
      } else {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        // Zurücknehmen abgelehnt → Sendung bleibt im Shop bestehen
        await set(s.shopStatus === "cancel" ? { shopStatus: "sent", shopError: `cancelFailed:${msg}`, shopTries: tries } : { shopStatus: "failed", shopError: msg, shopTries: tries });
        await shopEvent(s.channel, "error", `shipmentFailed:${msg}`, "", s.invoiceId);
      }
    }
    return reload();
  });
}

/** „Erneut senden“ nach einer Ablehnung: wieder vormerken und gleich versuchen */
export async function retryShipment(id: string, userId?: string) {
  const s = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, id) });
  if (!s || s.cancelledAt) throw new ShipmentError("notFound");
  if (s.shopStatus === "failed") {
    await db.update(schema.shipments).set({ shopStatus: s.shopFulfillmentIds.length ? "update" : "pending", shopError: "", shopTries: 0 }).where(eq(schema.shipments.id, id));
    await db.insert(schema.auditLog).values({ entity: "shipment", entityId: id, action: "retry", userId });
  }
  return syncShipment(id);
}

/** Worker (alle 5 min): vorgemerkte Sendungen melden (Shop war weg, Abgleich aus, Recht fehlte) */
export async function retryShipments() {
  const rows = await db.select({ id: schema.shipments.id }).from(schema.shipments)
    .where(and(inArray(schema.shipments.shopStatus, SHOP_TODO), lt(schema.shipments.shopTries, 2000))).orderBy(asc(schema.shipments.createdAt)).limit(50);
  for (const r of rows) await syncShipment(r.id).catch((e) => console.error("shipment sync", e));
  return rows.length;
}

// ───────────────────────── Aus Shopify übernehmen ─────────────────────────

/**
 * Beim Bestell-Abgleich (unter der Sperre der Bestellung): im Shopify-Admin angelegte Sendungen übernehmen, dort stornierte
 * zurücknehmen, Zustellstatus nachführen. Eigene Sendungen erkennt man an der Fulfillment-ID (sonst an denselben Nummern).
 */
export async function importShopFulfillments(channel: ShopChannel, o: ShopOrder, invoiceId: string) {
  if (!o.fulfillments) return;
  const known = await db.select().from(schema.shipments).where(and(eq(schema.shipments.channel, channel), eq(schema.shipments.externalOrderId, o.id)));
  const lines = await db.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoiceId));
  for (const f of o.fulfillments) {
    const numbers = f.trackingInfo.map((x) => normalizeTrackingNumber(x.number ?? "")).filter(Boolean);
    const delivery = isDeliveryState(f.displayStatus) ? f.displayStatus : "";
    const mine = known.find((s) => s.shopFulfillmentIds.includes(f.id))
      ?? known.find((s) => !s.cancelledAt && numbers.length > 0 && s.trackingNumbers.length === numbers.length && numbers.every((n) => s.trackingNumbers.includes(n)));
    if (mine) {
      const ids = mine.shopFulfillmentIds.includes(f.id) ? mine.shopFulfillmentIds : [...mine.shopFulfillmentIds, f.id];
      if (f.status === "CANCELLED" && !mine.cancelledAt && mine.shopStatus !== "cancel") {
        await db.update(schema.shipments).set({ cancelledAt: new Date(), shopStatus: "cancelled", shopFulfillmentIds: ids }).where(eq(schema.shipments.id, mine.id));
        await db.insert(schema.auditLog).values({ entity: "shipment", entityId: mine.id, action: "cancel", after: { source: "shop" } });
        await shopEvent(channel, "info", `shipmentCancelledInShop:${numbers.join(" ")}`, o.name, invoiceId);
      } else if (ids !== mine.shopFulfillmentIds || (delivery && delivery !== mine.deliveryStatus)) {
        await db.update(schema.shipments).set({ shopFulfillmentIds: ids, ...(delivery ? { deliveryStatus: delivery } : {}) }).where(eq(schema.shipments.id, mine.id));
      }
      continue;
    }
    if (f.status !== "SUCCESS") continue;
    const { carrier, carrierName } = carrierFromCompany(f.trackingInfo[0]?.company);
    const items = f.fulfillmentLineItems.nodes.map((n) => {
      const l = lines.find((x) => x.externalLineId === n.lineItem.id);
      return { lineId: l?.id ?? null, externalLineId: n.lineItem.id, variantId: l?.variantId ?? null, description: l?.description ?? "", qty: n.quantity };
    });
    const [row] = await db.insert(schema.shipments).values({
      invoiceId, channel, externalOrderId: o.id, carrier, carrierName: carrier === "OTHER" ? carrierName || "?" : "", trackingNumbers: numbers,
      trackingUrl: carrier === "OTHER" ? urlTemplate(f.trackingInfo[0]?.url, f.trackingInfo[0]?.number).slice(0, 300) : "", items,
      shippedOn: berlinDate(f.createdAt), notifyCustomer: false, source: "shop", shopFulfillmentIds: [f.id], shopStatus: "sent", deliveryStatus: delivery,
    }).returning({ id: schema.shipments.id });
    await db.insert(schema.auditLog).values({ entity: "shipment", entityId: row.id, action: "create", after: { source: "shop", fulfillment: f.id, trackingNumbers: numbers } });
    await shopEvent(channel, "info", `shippedInShop:${numbers.join(" ")}`, o.name, invoiceId);
  }
}

// ───────────────────────── Übersichten ─────────────────────────

/** Versandstand je Rechnung (für Listen; höchstens ein paar hundert Rechnungen auf einmal) */
export async function shippingStates(invoiceIds: string[]): Promise<Map<string, ShippingState>> {
  const out = new Map<string, ShippingState>();
  if (!invoiceIds.length) return out;
  const [lines, ships] = await Promise.all([
    db.select({ id: schema.invoiceLines.id, invoiceId: schema.invoiceLines.invoiceId, variantId: schema.invoiceLines.variantId,
      externalLineId: schema.invoiceLines.externalLineId, description: schema.invoiceLines.description, qty: schema.invoiceLines.qty })
      .from(schema.invoiceLines).where(inArray(schema.invoiceLines.invoiceId, invoiceIds)),
    db.select({ invoiceId: schema.shipments.invoiceId, items: schema.shipments.items, cancelledAt: schema.shipments.cancelledAt })
      .from(schema.shipments).where(inArray(schema.shipments.invoiceId, invoiceIds)),
  ]);
  for (const id of invoiceIds) out.set(id, shippingState(lines.filter((l) => l.invoiceId === id), ships.filter((s) => s.invoiceId === id)).state);
  return out;
}

/**
 * Shop-Bestellungen (ausgestellt), die noch nicht ganz verschickt sind – Startseite und Filter „Zu versenden“.
 * Vorauswahl in SQL (verschickte Menge < Warenmenge), genauer Stand dann je Position.
 */
export async function shopOrdersToShip(): Promise<{ id: string; state: ShippingState }[]> {
  const ids = (await db.execute<{ id: string }>(sql`
    select i.id from invoices i
    where i.kind = 'INVOICE' and i.status = 'ISSUED' and i.channel <> 'STORE' and i.external_order_id is not null
      and (select coalesce(sum(l.qty), 0) from invoice_lines l where l.invoice_id = i.id and l.qty > 0
             and coalesce(l.external_line_id, '') <> 'shipping' and (l.variant_id is not null or l.external_line_id like 'gid://shopify/LineItem/%'))
        > (select coalesce(sum((it ->> 'qty')::int), 0) from shipments s cross join lateral jsonb_array_elements(s.items) it
             where s.invoice_id = i.id and s.cancelled_at is null)
    order by i.issue_date, i.created_at`)).rows.map((r) => r.id);
  const st = await shippingStates(ids);
  return ids.map((id) => ({ id, state: st.get(id) ?? "none" })).filter((x) => x.state === "none" || x.state === "partial");
}
