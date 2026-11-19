"use server";
/**
 * Versand: Server-Actions OHNE revalidatePath (wie ShopControls): Die Übernahme des neuen Seitenbaums nach einer Action mit
 * revalidatePath blieb im Browser ab und zu hängen (hier beim 2. Speichern nachgestellt, 12.11.2026) – der Browser lädt die
 * Seite danach selbst neu (mit Hinweis ?ship=…). Alle Seiten sind dynamisch, nichts Veraltetes im Zwischenspeicher.
 */
import { z } from "zod";
import { requirePerm } from "@/lib/auth";
import { cancelShipment, createGlsShipment, createShipment, editShipment, markPickedUp, markPickupReady, retryShipment, ShipmentError, syncShipment } from "@/lib/shipments";
import { parseKg } from "@/lib/gls";

/** shop = Stand im Shop nach dem Speichern (sent / pending / failed / none …) für den Hinweis unter dem Knopf */
export type ShipState = { ok?: boolean; error?: string; detail?: string; shop?: string; notify?: boolean; at?: number; label?: string } | undefined;

const fields = z.object({
  invoiceId: z.string().min(1).max(64), carrier: z.string().max(20), carrierName: z.string().max(200).default(""),
  trackingUrl: z.string().max(500).default(""), numbers: z.string().max(5000).default("[]"), notify: z.string().optional(), pick: z.string().max(20000).optional(),
  note: z.string().max(1000).default(""),
});
const numbersOf = (s: string) => z.array(z.string().max(100)).max(50).parse(JSON.parse(s));

function fail(e: unknown): ShipState {
  if (e instanceof ShipmentError) return { error: e.code, detail: e.detail };
  if (e instanceof SyntaxError || e instanceof z.ZodError) return { error: "required" };
  console.error(e);
  return { error: "error" };
}

/** gleich an den Shop melden, höchstens 8 s warten – sonst übernimmt der Worker (Ergebnis steht dann an der Sendung) */
async function pushNow(id: string): Promise<string> {
  const timeout = new Promise<string>((res) => setTimeout(() => res("pending"), 8000));
  return Promise.race([syncShipment(id).then((s) => s?.shopStatus ?? "none").catch(() => "pending"), timeout]);
}

export async function createShipmentAction(_: ShipState, fd: FormData): Promise<ShipState> {
  const s = await requirePerm("sales.shipping");
  const p = fields.safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  let id: string;
  try {
    const pick = p.data.pick ? z.record(z.string(), z.number().int().min(0).max(1_000_000)).parse(JSON.parse(p.data.pick)) : null;
    id = await createShipment({
      invoiceId: p.data.invoiceId, carrier: p.data.carrier, carrierName: p.data.carrierName, trackingUrl: p.data.trackingUrl,
      numbers: numbersOf(p.data.numbers), notify: p.data.notify === "1", pick, note: p.data.note,
    }, s.uid);
  } catch (e) { return fail(e); }
  const shop = await pushNow(id);
  return { ok: true, shop, notify: p.data.notify === "1", at: Date.now() };
}

export async function editShipmentAction(_: ShipState, fd: FormData): Promise<ShipState> {
  const s = await requirePerm("sales.shipping");
  const p = fields.extend({ id: z.string().min(1).max(64) }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  try {
    await editShipment(p.data.id, {
      carrier: p.data.carrier, carrierName: p.data.carrierName, trackingUrl: p.data.trackingUrl, numbers: numbersOf(p.data.numbers), notify: p.data.notify === "1",
      note: p.data.note,
    }, s.uid);
  } catch (e) { return fail(e); }
  const shop = await pushNow(p.data.id);
  return { ok: true, shop, notify: p.data.notify === "1", at: Date.now() };
}

export async function cancelShipmentAction(_: ShipState, fd: FormData): Promise<ShipState> {
  const s = await requirePerm("sales.shipping");
  const id = String(fd.get("id") ?? ""), invoiceId = String(fd.get("invoiceId") ?? "");
  if (!id || !invoiceId) return { error: "required" };
  try { await cancelShipment(id, s.uid); } catch (e) { return fail(e); }
  const shop = await pushNow(id);
  return { ok: true, shop, at: Date.now() };
}

export async function retryShipmentAction(_: ShipState, fd: FormData): Promise<ShipState> {
  const s = await requirePerm("sales.shipping");
  const id = String(fd.get("id") ?? ""), invoiceId = String(fd.get("invoiceId") ?? "");
  if (!id || !invoiceId) return { error: "required" };
  let shop: string, notify = false;
  try {
    const timeout = new Promise<string>((res) => setTimeout(() => res("pending"), 8000));
    const r = retryShipment(id, s.uid);
    shop = await Promise.race([r.then((x) => x?.shopStatus ?? "none"), timeout]);
    notify = Boolean((await Promise.race([r, timeout.then(() => null)]))?.notifyCustomer);
  } catch (e) { return fail(e); }
  return { ok: true, shop, notify, at: Date.now() };
}

/** GLS-Etikett erstellen (Gewicht je Paket in kg) → Sendung mit GLS-Nummern, Etikett zum Drucken, gleich an den Shop melden */
export async function createGlsShipmentAction(_: ShipState, fd: FormData): Promise<ShipState> {
  const s = await requirePerm("sales.shipping");
  const p = z.object({
    invoiceId: z.string().min(1).max(64), weights: z.string().max(2000), notify: z.string().optional(), pick: z.string().max(20000).optional(), note: z.string().max(1000).default(""),
    consent: z.string().optional(),
  }).safeParse(Object.fromEntries(fd));
  if (!p.success) return { error: "required" };
  let id: string;
  try {
    const raw = z.array(z.union([z.string().max(20), z.number()])).max(50).parse(JSON.parse(p.data.weights));
    const pick = p.data.pick ? z.record(z.string(), z.number().int().min(0).max(1_000_000)).parse(JSON.parse(p.data.pick)) : null;
    id = await createGlsShipment({
      invoiceId: p.data.invoiceId, parcelsKg: raw.map((w) => parseKg(w) ?? 0), pick, notify: p.data.notify === "1", note: p.data.note, consent: p.data.consent === "1",
    }, s.uid);
  } catch (e) { return fail(e); }
  const shop = await pushNow(id);
  return { ok: true, shop, notify: p.data.notify === "1", at: Date.now(), label: id };
}

/** Abholung: „Bereit zur Abholung“ (Shop schickt dem Kunden die Abhol-E-Mail) */
export async function pickupReadyAction(_: ShipState, fd: FormData): Promise<ShipState> {
  const s = await requirePerm("sales.shipping");
  const invoiceId = String(fd.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "required" };
  try {
    const r = await markPickupReady(invoiceId, s.uid);
    if (r.shop === "failed") return { error: "pickupFailed", detail: r.error ?? "" };
    return { ok: true, shop: r.shop, at: Date.now() };
  } catch (e) { return fail(e); }
}

/** Abholung: „Abgeholt“ (Sendung „Abholung“, im Shop erledigt) */
export async function pickedUpAction(_: ShipState, fd: FormData): Promise<ShipState> {
  const s = await requirePerm("sales.shipping");
  const invoiceId = String(fd.get("invoiceId") ?? "");
  if (!invoiceId) return { error: "required" };
  let id: string;
  try { id = await markPickedUp(invoiceId, s.uid); } catch (e) { return fail(e); }
  const shop = await pushNow(id);
  return { ok: true, shop, at: Date.now() };
}
