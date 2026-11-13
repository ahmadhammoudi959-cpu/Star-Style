import "server-only";
/**
 * Sendungen an Shopify melden (Wunsch Inhaber 12.11.2026: Mitarbeiter arbeiten nur im System, nie im Shopify-Admin).
 * fulfillmentCreate mit Sendungsnummern → Shopify markiert die Bestellung als versendet und schickt dem Kunden (notifyCustomer)
 * die Versandbestätigung mit Link. Recht: write_merchant_managed_fulfillment_orders (liest auch die Fulfillment-Aufträge).
 */
import { gql, ShopifyError, type Shop } from "./client";
import { planFulfillment, shopTrackingInput, type FoNode } from "../shipping";

/** fehlendes App-Recht (Shopify meldet „Access denied … Required access: …“) */
export const SCOPE_RE = /access denied|not approved|required access|access scope/i;

export class FulfillError extends Error {
  constructor(public code: "alreadyFulfilled" | "notFound", message = code) { super(message); }
}

type Tracking = { carrier: string; carrierName: string; trackingNumbers: string[]; trackingUrl: string };
type UserError = { field: string[] | null; message: string };
const userErrors = (errs: UserError[] | undefined) => {
  if (errs?.length) throw new ShopifyError("userErrors", errs.map((e) => e.message).join("; ").slice(0, 500));
};

const FO_Q = `query($id: ID!) { order(id: $id) { id name fulfillmentOrders(first: 20) { nodes {
  id status assignedLocation { location { id } } supportedActions { action }
  lineItems(first: 100) { nodes { id remainingQuantity lineItem { id } } } } } } }`;
type FoQ = { order: { id: string; name: string; fulfillmentOrders: { nodes: {
  id: string; status: string; assignedLocation: { location: { id: string } | null } | null; supportedActions: { action: string }[];
  lineItems: { nodes: { id: string; remainingQuantity: number; lineItem: { id: string } }[] } }[] } } | null };

const CREATE_M = `mutation($f: FulfillmentInput!) { fulfillmentCreate(fulfillment: $f) { fulfillment { id status } userErrors { field message } } }`;
const UPDATE_M = `mutation($id: ID!, $t: FulfillmentTrackingInput!, $notify: Boolean) {
  fulfillmentTrackingInfoUpdate(fulfillmentId: $id, trackingInfoInput: $t, notifyCustomer: $notify) { fulfillment { id } userErrors { field message } } }`;
const CANCEL_M = `mutation($id: ID!) { fulfillmentCancel(id: $id) { fulfillment { id status } userErrors { field message } } }`;

/** offene Fulfillment-Aufträge der Bestellung (je Lagerort) */
export async function fulfillmentOrders(shop: Shop, orderId: string): Promise<{ name: string; fos: FoNode[] }> {
  const d = await gql<FoQ>(shop, FO_Q, { id: orderId });
  if (!d.order) throw new FulfillError("notFound");
  return {
    name: d.order.name,
    fos: d.order.fulfillmentOrders.nodes.map((f) => ({
      id: f.id, locationId: f.assignedLocation?.location?.id ?? "", actions: f.supportedActions.map((a) => a.action),
      lines: f.lineItems.nodes.map((l) => ({ id: l.id, lineItemId: l.lineItem.id, remaining: l.remainingQuantity })),
    })),
  };
}

/**
 * Sendung als Fulfillment anlegen (je Lagerort eins). onCreated wird nach JEDEM angelegten Fulfillment sofort aufgerufen,
 * damit die ID gespeichert ist, bevor der Webhook „Bestellung geändert“ kommt.
 */
export async function createFulfillment(shop: Shop, orderId: string, want: { externalLineId: string; qty: number }[], t: Tracking, notify: boolean,
  onCreated: (id: string) => Promise<void>): Promise<{ ids: string[]; name: string; missing: number }> {
  const { name, fos } = await fulfillmentOrders(shop, orderId);
  const plan = planFulfillment(fos, want);
  if (!plan.groups.length) throw new FulfillError("alreadyFulfilled");
  const ids: string[] = [];
  for (const g of plan.groups) {
    const d = await gql<{ fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: UserError[] } }>(shop, CREATE_M, {
      f: { lineItemsByFulfillmentOrder: g.lineItemsByFulfillmentOrder, notifyCustomer: notify, trackingInfo: shopTrackingInput(t) },
    });
    userErrors(d.fulfillmentCreate.userErrors);
    if (d.fulfillmentCreate.fulfillment) { ids.push(d.fulfillmentCreate.fulfillment.id); await onCreated(d.fulfillmentCreate.fulfillment.id); }
  }
  return { ids, name, missing: plan.missing.reduce((s, m) => s + m.qty, 0) };
}

/** geänderte Nummern/Versanddienst melden (Shopify schickt bei notify eine „Versand-Aktualisierung“) */
export async function updateFulfillmentTracking(shop: Shop, ids: string[], t: Tracking, notify: boolean) {
  for (const id of ids) {
    const d = await gql<{ fulfillmentTrackingInfoUpdate: { userErrors: UserError[] } }>(shop, UPDATE_M, { id, t: shopTrackingInput(t), notify });
    userErrors(d.fulfillmentTrackingInfoUpdate.userErrors);
  }
}

/** Sendung im Shop zurücknehmen (Bestellung gilt dort wieder als nicht versendet) */
export async function cancelFulfillments(shop: Shop, ids: string[]) {
  for (const id of ids) {
    const d = await gql<{ fulfillmentCancel: { userErrors: UserError[] } }>(shop, CANCEL_M, { id });
    // schon storniert → Ziel erreicht
    if (d.fulfillmentCancel.userErrors.some((e) => /already (been )?(cancel|storn)/i.test(e.message))) continue;
    userErrors(d.fulfillmentCancel.userErrors);
  }
}

const PICKUP_Q = `query($id: ID!) { order(id: $id) { id fulfillmentOrders(first: 20) { nodes { id status deliveryMethod { methodType } } } } }`;
const PICKUP_M = `mutation($input: FulfillmentOrderLineItemsPreparedForPickupInput!) {
  fulfillmentOrderLineItemsPreparedForPickup(input: $input) { userErrors { field message } } }`;

/**
 * Abholung im Lager: offene Abhol-Aufträge als „bereit zur Abholung“ melden – Shopify schickt dem Kunden dann die
 * Abhol-E-Mail (mit dem Text aus Einstellungen → Versand → Abholung, z. B. Abholzeiten 11–19 Uhr).
 */
export async function prepareForPickup(shop: Shop, orderId: string): Promise<number> {
  const d = await gql<{ order: { fulfillmentOrders: { nodes: { id: string; status: string; deliveryMethod: { methodType: string } | null }[] } } | null }>(shop, PICKUP_Q, { id: orderId });
  if (!d.order) throw new FulfillError("notFound");
  const fos = d.order.fulfillmentOrders.nodes.filter((f) => f.deliveryMethod?.methodType === "PICK_UP" && ["OPEN", "IN_PROGRESS"].includes(f.status));
  if (!fos.length) return 0;
  const r = await gql<{ fulfillmentOrderLineItemsPreparedForPickup: { userErrors: UserError[] } }>(shop, PICKUP_M, {
    input: { lineItemsByFulfillmentOrder: fos.map((f) => ({ fulfillmentOrderId: f.id })) },
  });
  userErrors(r.fulfillmentOrderLineItemsPreparedForPickup.userErrors);
  return fos.length;
}
