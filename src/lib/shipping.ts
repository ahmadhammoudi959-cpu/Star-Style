/**
 * Versand mit Sendungsverfolgung – reine Logik (getestet in tests/shipping.test.ts), auch im Browser benutzt.
 * Wunsch Inhaber 12.11.2026: Mitarbeiter tragen die Sendungsnummern NUR im System ein (nie im Shopify-Admin); bei Shop-Bestellungen
 * meldet das System die Sendung an Shopify, Shopify schickt dem Kunden die Versandbestätigung mit Link.
 * Ein Paket bis 31,5 kg = eine Nummer (DHL Paket); Möbel/Stühle gehen mit einer Spedition (OTHER + Name).
 */
import type { ShipmentItem } from "@/db/schema";

export const CARRIERS = ["DHL", "DPD", "GLS", "HERMES", "UPS", "OTHER"] as const;
export type Carrier = (typeof CARRIERS)[number];
export const isCarrier = (v: unknown): v is Carrier => typeof v === "string" && (CARRIERS as readonly string[]).includes(v);

type Known = Exclude<Carrier, "OTHER">;
/** Anzeigename = Name, den Shopify für Shops in Deutschland kennt (Shopify baut dann selbst Link + Zustellstatus) */
const NAMES: Record<Known, string> = { DHL: "DHL", DPD: "DPD", GLS: "GLS", HERMES: "Hermes", UPS: "UPS" };

/** Name für Anzeige und Shopify; OTHER = eingegebener Name der Spedition */
export function carrierLabel(carrier: string, carrierName = ""): string {
  return carrier === "OTHER" ? carrierName.trim() : NAMES[carrier as Known] ?? carrier;
}

const URLS: Record<Known, (n: string) => string> = {
  DHL: (n) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}`,
  DPD: (n) => `https://tracking.dpd.de/status/de_DE/parcel/${n}`,
  GLS: (n) => `https://gls-group.com/DE/de/paketverfolgung?match=${n}`,
  HERMES: (n) => `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#${n}`,
  UPS: (n) => `https://www.ups.com/track?loc=de_DE&tracknum=${n}`,
};

/** Link zur Sendungsverfolgung. OTHER: Link der Spedition, „{n}“ darin wird durch die Nummer ersetzt (ohne Nummer dann kein Link). */
export function trackingUrl(carrier: string, n: string, customUrl = ""): string | null {
  const num = encodeURIComponent(n);
  if (carrier !== "OTHER") return n && URLS[carrier as Known] ? URLS[carrier as Known](num) : null;
  const u = customUrl.trim();
  if (!u) return null;
  if (!u.includes("{n}")) return u;
  return n ? u.split("{n}").join(num) : null;
}

/** Link eines eingebauten Versanddienstes als Vorlage mit {n} (Anzeige auf der Seite „Versanddienste“) */
export const carrierUrlTemplate = (carrier: string): string | null => (carrier !== "OTHER" && URLS[carrier as Known] ? URLS[carrier as Known]("{n}") : null);

/** Nummer vom Etikett/Handscanner: Leerzeichen weg, Großbuchstaben */
export const normalizeTrackingNumber = (s: string) => s.replace(/[\s ]+/g, "").toUpperCase();
const NUM_RE = /^[A-Z0-9][A-Z0-9-]{4,48}[A-Z0-9]$/; // 6–50 Zeichen
export const MAX_PARCELS = 20;

export type NumbersProblem = "format" | "duplicate" | "missing" | "tooMany";
/**
 * Nummern prüfen: bekannte Versanddienste brauchen mindestens eine; Spedition darf ohne (dann nur Name/Link).
 * required: im Formular auch für eigene Versanddienste mit {n} im Link (der Server lässt sie wie jede Spedition ohne zu).
 */
export function checkNumbers(carrier: string, raw: string[], required = carrier !== "OTHER"): { numbers: string[]; problem: NumbersProblem | null; bad?: string } {
  const numbers = raw.map(normalizeTrackingNumber).filter(Boolean);
  if (numbers.length > MAX_PARCELS) return { numbers, problem: "tooMany" };
  const bad = numbers.find((n) => !NUM_RE.test(n));
  if (bad) return { numbers, problem: "format", bad };
  const dup = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (dup) return { numbers, problem: "duplicate", bad: dup };
  if (!numbers.length && required) return { numbers, problem: "missing" };
  return { numbers, problem: null };
}

/** Link der Spedition: leer oder https (mit oder ohne {n}) */
export function customUrlOk(u: string): boolean {
  const s = u.trim();
  if (!s) return true;
  try { return new URL(s.split("{n}").join("1")).protocol === "https:"; } catch { return false; }
}

/** Tracking-Angaben für Shopify: Firma UND Links mitschicken (empfiehlt Shopify), mehrere Pakete = mehrere Nummern */
export function shopTrackingInput(s: { carrier: string; carrierName: string; trackingNumbers: string[]; trackingUrl: string }) {
  const company = carrierLabel(s.carrier, s.carrierName) || undefined;
  if (!s.trackingNumbers.length) {
    const url = trackingUrl(s.carrier, "", s.trackingUrl);
    return { company, ...(url ? { url } : {}) };
  }
  const urls = s.trackingNumbers.map((n) => trackingUrl(s.carrier, n, s.trackingUrl));
  return { company, numbers: s.trackingNumbers, ...(urls.every(Boolean) ? { urls: urls as string[] } : {}) };
}

/** Im Shopify-Admin versendet → unser Versanddienst (sonst Spedition mit dem Namen aus Shopify) */
export function carrierFromCompany(company: string | null | undefined): { carrier: Carrier; carrierName: string } {
  const c = (company ?? "").trim();
  const hit = (Object.keys(NAMES) as Known[]).find((k) => NAMES[k].toLowerCase() === c.toLowerCase());
  return hit ? { carrier: hit, carrierName: "" } : { carrier: "OTHER", carrierName: c.slice(0, 60) };
}
/** Link aus Shopify → Vorlage mit {n}, damit er für jede Nummer passt */
export function urlTemplate(url: string | null | undefined, n: string | null | undefined): string {
  const u = (url ?? "").trim();
  return n && u.includes(n) ? u.split(n).join("{n}") : u;
}

// ───────────────────────── Was ist schon verschickt? ─────────────────────────

export type ShipLine = { id: string; variantId: string | null; externalLineId: string | null; description: string; qty: number };
export type ShipRecord = { items: ShipmentItem[]; cancelledAt: Date | string | null };
const SHOP_LINE = "gid://shopify/LineItem/";

/** Positionen, die verschickt werden: Shop-Positionen (ohne Versandkosten) bzw. Artikel aus dem Lager; Freitext zählt nicht */
export function shippableLines<L extends ShipLine>(lines: L[]): L[] {
  return lines.filter((l) => l.qty > 0 && l.externalLineId !== "shipping" && (l.variantId != null || (l.externalLineId ?? "").startsWith(SHOP_LINE)));
}

/** verschickte Menge je Position (gültige Sendungen; Zuordnung über Position, sonst Shopify-Position, sonst Artikel) */
export function shippedQuantities(lines: ShipLine[], shipments: ShipRecord[]): Map<string, number> {
  const ship = shippableLines(lines);
  const done = new Map(ship.map((l) => [l.id, 0]));
  const room = (l: ShipLine) => l.qty - (done.get(l.id) ?? 0);
  for (const s of shipments) {
    if (s.cancelledAt) continue;
    for (const it of s.items) {
      let left = it.qty;
      const candidates = [
        ...ship.filter((l) => it.lineId && l.id === it.lineId),
        ...ship.filter((l) => it.externalLineId && l.externalLineId === it.externalLineId),
        ...ship.filter((l) => it.variantId && l.variantId === it.variantId),
      ];
      for (const l of candidates) {
        if (left <= 0) break;
        const take = Math.min(left, room(l));
        if (take > 0) { done.set(l.id, (done.get(l.id) ?? 0) + take); left -= take; }
      }
    }
  }
  return done;
}

export type ShippingState = "none" | "partial" | "done" | "nothing";
/** Versandstand einer Rechnung: nichts / teilweise / alles verschickt; „nothing“ = keine Ware (nur Freitext/Versandkosten) */
export function shippingState<L extends ShipLine>(lines: L[], shipments: ShipRecord[]) {
  const ship = shippableLines(lines);
  const done = shippedQuantities(lines, shipments);
  const open = ship.map((l) => ({ line: l, qty: l.qty - (done.get(l.id) ?? 0) })).filter((x) => x.qty > 0);
  const total = ship.reduce((s, l) => s + l.qty, 0);
  const shipped = [...done.values()].reduce((s, n) => s + n, 0);
  const anyShipment = shipments.some((s) => !s.cancelledAt);
  const state: ShippingState = !ship.length ? (anyShipment ? "done" : "nothing") : !open.length ? "done" : shipped > 0 ? "partial" : "none";
  return { state, open, shippedUnits: shipped, totalUnits: total };
}

export type ItemsProblem = "nothingOpen" | "qtyTooHigh" | "empty";
/**
 * Inhalt einer neuen Sendung: gewählte Mengen je Position oder (pick = null) alles, was noch offen ist.
 * Rechnungen ohne Ware (nur Freitext) dürfen eine Sendung ohne Positionen haben.
 */
export function resolveItems<L extends ShipLine>(lines: L[], shipments: ShipRecord[], pick: Record<string, number> | null): { items: ShipmentItem[]; problem: ItemsProblem | null } {
  const st = shippingState(lines, shipments);
  if (st.state === "nothing") return { items: [], problem: null };
  if (!st.open.length) return { items: [], problem: "nothingOpen" };
  const toItem = (l: ShipLine, qty: number): ShipmentItem => ({ lineId: l.id, externalLineId: l.externalLineId, variantId: l.variantId, description: l.description, qty });
  if (!pick) return { items: st.open.map((o) => toItem(o.line, o.qty)), problem: null };
  const items: ShipmentItem[] = [];
  for (const o of st.open) {
    const q = pick[o.line.id] ?? 0;
    if (!Number.isInteger(q) || q < 0 || q > o.qty) return { items: [], problem: "qtyTooHigh" };
    if (q > 0) items.push(toItem(o.line, q));
  }
  if (Object.keys(pick).some((id) => (pick[id] ?? 0) > 0 && !st.open.some((o) => o.line.id === id))) return { items: [], problem: "qtyTooHigh" };
  return items.length ? { items, problem: null } : { items: [], problem: "empty" };
}

/** Bei einer Korrektur: Sendungs-Positionen auf die Positionen der neuen Rechnung umhängen (Shopify-Position, sonst Artikel + Text) */
export function remapItems(items: ShipmentItem[], newLines: ShipLine[]): ShipmentItem[] {
  return items.map((it) => {
    const hit = newLines.find((l) => it.externalLineId && it.externalLineId !== "shipping" && l.externalLineId === it.externalLineId)
      ?? newLines.find((l) => it.variantId && l.variantId === it.variantId && l.description === it.description)
      ?? newLines.find((l) => it.variantId && l.variantId === it.variantId);
    return hit ? { ...it, lineId: hit.id } : it;
  });
}

// ───────────────────────── Shopify: welche Fulfillment-Positionen? ─────────────────────────

export type FoNode = { id: string; locationId: string; actions: string[]; lines: { id: string; lineItemId: string; remaining: number }[] };
export type FulfillGroup = { locationId: string; lineItemsByFulfillmentOrder: { fulfillmentOrderId: string; fulfillmentOrderLineItems: { id: string; quantity: number }[] }[] };

/**
 * Sendung → Fulfillment-Aufträge in Shopify: jede Position (Shopify-LineItem) auf offene Fulfillment-Positionen verteilen.
 * Nur Aufträge, die „CREATE_FULFILLMENT“ erlauben. Ein Fulfillment je Lagerort (Shopify verlangt denselben Ort).
 * missing = Mengen, die im Shop nicht (mehr) offen sind (z. B. dort schon versendet).
 */
export function planFulfillment(fos: FoNode[], want: { externalLineId: string; qty: number }[]): { groups: FulfillGroup[]; missing: { externalLineId: string; qty: number }[] } {
  const usable = fos.filter((f) => f.actions.includes("CREATE_FULFILLMENT"));
  const left = new Map(usable.flatMap((f) => f.lines.map((l) => [l.id, l.remaining] as const)));
  const sum = new Map<string, number>();
  for (const w of want) if (w.externalLineId.startsWith(SHOP_LINE) && w.qty > 0) sum.set(w.externalLineId, (sum.get(w.externalLineId) ?? 0) + w.qty);
  const take = new Map<string, Map<string, number>>(); // FO → (FO-Position → Menge)
  const missing: { externalLineId: string; qty: number }[] = [];
  for (const [lineItemId, qty] of sum) {
    let rest = qty;
    for (const f of usable) for (const l of f.lines) {
      if (rest <= 0 || l.lineItemId !== lineItemId) continue;
      const n = Math.min(rest, left.get(l.id) ?? 0);
      if (n <= 0) continue;
      left.set(l.id, (left.get(l.id) ?? 0) - n);
      rest -= n;
      const m = take.get(f.id) ?? new Map<string, number>();
      m.set(l.id, (m.get(l.id) ?? 0) + n);
      take.set(f.id, m);
    }
    if (rest > 0) missing.push({ externalLineId: lineItemId, qty: rest });
  }
  const groups = new Map<string, FulfillGroup>();
  for (const f of usable) {
    const m = take.get(f.id);
    if (!m) continue;
    const g = groups.get(f.locationId) ?? { locationId: f.locationId, lineItemsByFulfillmentOrder: [] };
    g.lineItemsByFulfillmentOrder.push({ fulfillmentOrderId: f.id, fulfillmentOrderLineItems: [...m].map(([id, quantity]) => ({ id, quantity })) });
    groups.set(f.locationId, g);
  }
  return { groups: [...groups.values()], missing };
}

/** Zustellstatus aus Shopify, die wir anzeigen (andere = nichts Besonderes) */
export const DELIVERY_STATES = ["IN_TRANSIT", "OUT_FOR_DELIVERY", "ATTEMPTED_DELIVERY", "DELAYED", "DELIVERED", "NOT_DELIVERED", "FAILURE"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export const isDeliveryState = (v: unknown): v is DeliveryState => typeof v === "string" && (DELIVERY_STATES as readonly string[]).includes(v);
