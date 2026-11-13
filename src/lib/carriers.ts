/**
 * Versanddienste verwalten (Wunsch Inhaber 13.11.2026: „شركات الشحن دي من وين نعدلها من السيستم او نضيف جديد“) –
 * rein, getestet in tests/carriers.test.ts, auch im Browser benutzt (Seite „Versanddienste“, Karte „Versand“ der Rechnung).
 *
 * Gespeichert in `company_settings.carriers`; {} = wie bisher (DHL, DPD, GLS, Hermes, UPS, Spedition – DHL vorgewählt).
 * - eingebaute Versanddienste (DHL …): ausblenden, Reihenfolge, vorwählen; Name und Link fest (Shopify kennt sie).
 * - eigene Versanddienste: Name + Link (mit {n}); für die Sendung sind sie eine „Spedition“ mit festem Namen und Link
 *   (carrier OTHER + carrier_name + tracking_url). Die Sendung behält Namen und Link, auch wenn der Versanddienst später
 *   geändert oder entfernt wird. Shopify bekommt den Namen – steht er in Shopifys Liste (z. B. „FedEx“), baut der Shop
 *   den Link für den Kunden auch selbst.
 * - „Spedition“ (OTHER): Name und Link bei jeder Sendung frei eintragen.
 * Immer mindestens ein Knopf sichtbar; der vorgewählte ist sichtbar.
 */
import { CARRIERS, carrierLabel, customUrlOk, type Carrier } from "./shipping";

export const MAX_CUSTOM_CARRIERS = 20;
export const CARRIER_NAME_MAX = 60;
export const CARRIER_URL_MAX = 300;

export type CustomCarrier = { id: string; name: string; url: string };
export type CarrierSettings = { order: string[]; hidden: string[]; default: string; custom: CustomCarrier[] };

const BUILTIN = CARRIERS as readonly string[];
const ID_RE = /^c[a-z0-9]{6,20}$/;
export const isCustomCarrierId = (k: unknown): k is string => typeof k === "string" && ID_RE.test(k);

/** Name: Steuerzeichen weg, Leerraum zusammengefasst */
export const cleanCarrierName = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "");
/** Link: ohne Steuerzeichen und Leerzeichen (beim Kopieren aus der Adresszeile kommt manchmal eins mit) */
export const cleanCarrierUrl = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f\s]+/g, "") : "");
const nameKey = (s: string) => s.normalize("NFC").toLowerCase();
const BUILTIN_NAMES = BUILTIN.filter((k) => k !== "OTHER").map((k) => nameKey(carrierLabel(k)));

export const DEFAULT_CARRIERS: CarrierSettings = { order: [...CARRIERS], hidden: [], default: "DHL", custom: [] };

/** Gespeicherter Stand → gültige Einstellungen. Wirft nie; Unbekanntes, Doppeltes und Ungültiges fällt weg. */
export function parseCarrierSettings(raw: unknown): CarrierSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const custom: CustomCarrier[] = [];
  const names = new Set(BUILTIN_NAMES);
  for (const c of Array.isArray(o.custom) ? o.custom : []) {
    if (custom.length >= MAX_CUSTOM_CARRIERS) break;
    if (!c || typeof c !== "object") continue;
    const { id, name: rawName, url: rawUrl } = c as Record<string, unknown>;
    const name = cleanCarrierName(rawName);
    if (!isCustomCarrierId(id) || !name || name.length > CARRIER_NAME_MAX || names.has(nameKey(name)) || custom.some((x) => x.id === id)) continue;
    const u = cleanCarrierUrl(rawUrl);
    names.add(nameKey(name));
    custom.push({ id, name, url: u.length <= CARRIER_URL_MAX && customUrlOk(u) ? u : "" });
  }
  const known = [...BUILTIN, ...custom.map((c) => c.id)];
  const order: string[] = [];
  for (const k of Array.isArray(o.order) ? o.order : []) if (typeof k === "string" && known.includes(k) && !order.includes(k)) order.push(k);
  // fehlende Einträge (z. B. neu im Programm): vor „Spedition“, die bleibt so hinten, wie sie stand
  for (const k of known) {
    if (order.includes(k)) continue;
    const i = order.indexOf("OTHER");
    if (k !== "OTHER" && i >= 0) order.splice(i, 0, k);
    else order.push(k);
  }
  const hiddenSet = new Set((Array.isArray(o.hidden) ? o.hidden : []).filter((k): k is string => typeof k === "string" && known.includes(k)));
  const wanted = typeof o.default === "string" && known.includes(o.default) ? o.default : "DHL";
  if (order.every((k) => hiddenSet.has(k))) hiddenSet.delete(wanted);
  const hidden = order.filter((k) => hiddenSet.has(k));
  const def = !hiddenSet.has(wanted) ? wanted : order.find((k) => !hiddenSet.has(k))!;
  return { order, hidden, default: def, custom };
}

/** Zum Speichern: nur, was vom Standard abweicht – {} = wie bisher */
export function carrierStored(s: CarrierSettings): CarrierSettings | Record<string, never> {
  return JSON.stringify(s) === JSON.stringify(DEFAULT_CARRIERS) ? {} : s;
}

export type CarrierChoice = {
  key: string; // DHL … UPS, OTHER oder die ID eines eigenen Versanddienstes
  carrier: Carrier; // was an der Sendung steht (eigene = OTHER)
  name: string; // Anzeigename (OTHER: leer – Text „Spedition“ aus der Sprache)
  url: string; // eigener: Link-Vorlage; sonst leer
  kind: "builtin" | "custom" | "free";
  hidden: boolean;
};

/** Knöpfe in der eingestellten Reihenfolge (auch ausgeblendete – eine alte Sendung kann einen davon haben) */
export function carrierChoices(s: CarrierSettings): CarrierChoice[] {
  return s.order.map((k): CarrierChoice => {
    const hidden = s.hidden.includes(k);
    if (k === "OTHER") return { key: k, carrier: "OTHER", name: "", url: "", kind: "free", hidden };
    const c = s.custom.find((x) => x.id === k);
    if (c) return { key: k, carrier: "OTHER", name: c.name, url: c.url, kind: "custom", hidden };
    return { key: k, carrier: k as Carrier, name: carrierLabel(k), url: "", kind: "builtin", hidden };
  });
}

/** Was mit der Sendung gespeichert wird (Formularfelder carrier / carrierName / trackingUrl) */
export function shipmentFields(c: CarrierChoice, free: { name: string; url: string }) {
  if (c.kind === "free") return { carrier: c.carrier, carrierName: free.name, trackingUrl: free.url };
  if (c.kind === "custom") return { carrier: c.carrier, carrierName: c.name, trackingUrl: c.url };
  return { carrier: c.carrier, carrierName: "", trackingUrl: "" };
}

/** Braucht dieser Knopf eine Sendungsnummer? (eingebaut immer; eigener nur mit {n} im Link; Spedition nie) */
export const needsNumber = (c: CarrierChoice) => c.kind === "builtin" || (c.kind === "custom" && c.url.includes("{n}"));

/**
 * Welcher Knopf gehört zu einer gespeicherten Sendung? Eingebaut: der Code. Spedition: der eigene Versanddienst mit gleichem
 * Namen (wenn die Sendung keinen anderen Link hat), sonst freie Eingabe – so bleibt ein älterer Link erhalten.
 */
export function choiceKeyFor(choices: CarrierChoice[], s: { carrier: string; carrierName: string; trackingUrl: string }): string {
  if (s.carrier !== "OTHER") return choices.some((c) => c.key === s.carrier) ? s.carrier : "OTHER";
  const name = nameKey(cleanCarrierName(s.carrierName));
  const url = s.trackingUrl.trim();
  const hit = choices.find((c) => c.kind === "custom" && nameKey(c.name) === name && (!url || c.url === url));
  return hit ? hit.key : "OTHER";
}

/** Sendungsnummer aus einem kopierten Link → {n} (Groß-/Kleinschreibung egal), damit der Link für jede Sendung passt */
export function withNumberPlaceholder(url: string, sample: string): string {
  const u = cleanCarrierUrl(url);
  const n = sample.replace(/\s+/g, "");
  if (!u || !n || u.includes("{n}")) return u;
  const low = u.toLowerCase(), key = n.toLowerCase();
  let out = "", i = 0;
  for (let j = low.indexOf(key); j >= 0; j = low.indexOf(key, i)) { out += u.slice(i, j) + "{n}"; i = j + n.length; }
  return out + u.slice(i);
}

export type CarrierProblem = "name" | "nameTaken" | "url" | "tooMany" | "lastVisible" | "notFound";

/** Name und Link eines eigenen Versanddienstes prüfen (gleich im Formular und auf dem Server) */
export function checkCustomCarrier(s: CarrierSettings, name: string, url: string, exceptId?: string): CarrierProblem | null {
  const n = cleanCarrierName(name);
  if (!n || n.length > CARRIER_NAME_MAX) return "name";
  const k = nameKey(n);
  if (BUILTIN_NAMES.includes(k) || s.custom.some((c) => c.id !== exceptId && nameKey(c.name) === k)) return "nameTaken";
  const u = cleanCarrierUrl(url);
  if (u.length > CARRIER_URL_MAX || !customUrlOk(u)) return "url";
  return null;
}

export type CarrierOp =
  | { op: "add"; name: string; url: string }
  | { op: "edit"; key: string; name: string; url: string }
  | { op: "remove" | "show" | "hide" | "default" | "up" | "down"; key: string };

/** Eine Änderung anwenden (Server, in einer Transaktion); newId liefert die ID für einen neuen Versanddienst */
export function applyCarrierOp(cur: CarrierSettings, op: CarrierOp, newId: () => string): { settings: CarrierSettings } | { problem: CarrierProblem } {
  const s: CarrierSettings = { order: [...cur.order], hidden: [...cur.hidden], default: cur.default, custom: cur.custom.map((c) => ({ ...c })) };
  const done = () => ({ settings: parseCarrierSettings(s) });
  if (op.op === "add") {
    if (s.custom.length >= MAX_CUSTOM_CARRIERS) return { problem: "tooMany" };
    const p = checkCustomCarrier(s, op.name, op.url);
    if (p) return { problem: p };
    const id = newId();
    if (!isCustomCarrierId(id) || s.order.includes(id)) return { problem: "notFound" };
    s.custom.push({ id, name: cleanCarrierName(op.name), url: cleanCarrierUrl(op.url) });
    const i = s.order.indexOf("OTHER");
    if (i >= 0) s.order.splice(i, 0, id); else s.order.push(id);
    return done();
  }
  if (!s.order.includes(op.key)) return { problem: "notFound" };
  const custom = s.custom.find((c) => c.id === op.key);
  switch (op.op) {
    case "edit": {
      if (!custom) return { problem: "notFound" };
      const p = checkCustomCarrier(s, op.name, op.url, custom.id);
      if (p) return { problem: p };
      custom.name = cleanCarrierName(op.name);
      custom.url = cleanCarrierUrl(op.url);
      return done();
    }
    case "remove":
      if (!custom) return { problem: "notFound" };
      s.custom = s.custom.filter((c) => c !== custom);
      s.order = s.order.filter((k) => k !== op.key);
      s.hidden = s.hidden.filter((k) => k !== op.key);
      return done(); // war es der einzige sichtbare, wird der vorgewählte (sonst DHL) wieder angezeigt
    case "show":
      s.hidden = s.hidden.filter((k) => k !== op.key);
      return done();
    case "hide":
      if (s.hidden.includes(op.key)) return done();
      if (s.order.filter((k) => !s.hidden.includes(k)).length <= 1) return { problem: "lastVisible" };
      s.hidden.push(op.key);
      return done();
    case "default":
      s.default = op.key;
      s.hidden = s.hidden.filter((k) => k !== op.key);
      return done();
    case "up":
    case "down": {
      const i = s.order.indexOf(op.key), j = op.op === "up" ? i - 1 : i + 1;
      if (j >= 0 && j < s.order.length) [s.order[i], s.order[j]] = [s.order[j], s.order[i]];
      return done();
    }
  }
}
