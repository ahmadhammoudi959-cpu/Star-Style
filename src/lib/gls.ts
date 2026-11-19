/**
 * GLS-Anbindung (ShipIT REST) – reine Logik, getestet in tests/gls.test.ts.
 * Wunsch Inhaber 13.11.2026: Pakete gehen mit GLS; das System erstellt das Etikett direkt bei GLS (Sendungsnummer kommt zurück,
 * Etikett als PDF zum Drucken), meldet die Sendung an den Shop (Kunde bekommt die Versand-E-Mail) und kann sie bei GLS stornieren.
 * Möbel/schwere Ware (> 40 kg je Stück) gehen mit einer Spedition (Versanddienste).
 *
 * ShipIT: POST {endpoint}/shipments (anlegen), POST {endpoint}/shipments/cancel/{TrackID} (stornieren),
 * POST {endpoint}/shipments/validate (prüfen, legt nichts an). Basic-Auth, JSON mit Header „application/glsVersion1+json“.
 * Fehler: HTTP 4xx/5xx mit den Kopfzeilen „message“ / „error“ / „args“. Endpoint, Benutzer, Passwort und Contact-ID kommen von GLS.
 */

export const GLS_MAX_KG = 40; // GLS-Paket höchstens 40 kg (Vertrag 19.11.2026: national und EuroBusinessParcel; AGB 4.2)
export const GLS_MIN_KG = 0.1;
export const GLS_MAX_PARCELS = 20;
export const GLS_SERVICES = ["flex"] as const; // FlexDeliveryService (Kunde wird per E-Mail informiert, kann Zustellung umleiten)

export type GlsSettings = {
  endpoint: string; // z. B. https://shipit-wbm-de01.gls-group.eu:443/backend/rs
  user: string;
  password: string; // verschlüsselt gespeichert (crypto.ts); hier nur „gesetzt / nicht gesetzt“ bzw. der entschlüsselte Wert auf dem Server
  contactId: string; // Shipper ContactID von GLS
  flex: boolean;
};
export const EMPTY_GLS: GlsSettings = { endpoint: "", user: "", password: "", contactId: "", flex: false };

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");

/** Endpoint: nur https (lokale Tests: http://localhost erlaubt), ohne „/shipments“ am Ende und ohne „/“ */
export function normalizeEndpoint(raw: string, allowLocalHttp = false): string {
  let u = raw.trim().replace(/\s+/g, "");
  if (!u) return "";
  u = u.replace(/\/+$/, "").replace(/\/shipments$/i, "").replace(/\/+$/, "");
  try {
    const x = new URL(u);
    const local = allowLocalHttp && x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname);
    if ((x.protocol !== "https:" && !local) || x.username || x.password) return "";
    return u;
  } catch { return ""; }
}

/** Gespeicherter Stand → gültige Einstellungen. Wirft nie. */
export function parseGlsSettings(raw: unknown, allowLocalHttp = false): GlsSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    endpoint: normalizeEndpoint(str(o.endpoint, 300), allowLocalHttp),
    user: str(o.user, 100),
    password: typeof o.password === "string" ? o.password.slice(0, 2000) : "",
    contactId: str(o.contactId, 60),
    flex: o.flex === true,
  };
}

export const glsReady = (s: GlsSettings) => Boolean(s.endpoint && s.user && s.password && s.contactId);

// ───────────────────────── Anschrift ─────────────────────────

/** In ShipIT-Textfeldern verbotene Zeichen ( " { } , ; ( ) | ) durch Leerzeichen ersetzen, kürzen */
export function glsText(s: string | null | undefined, max: number): string {
  return (s ?? "").replace(/["{},;()|\\]/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

/** „Provinzialstraße 45a“ → Straße + Hausnummer (Nummer am Ende; „45 - 47“, „12/3“, „7 b“ gehen auch). Ohne Nummer → alles in Straße. */
export function splitStreet(raw: string): { street: string; number: string } {
  const s = raw.replace(/\s+/g, " ").trim();
  const m = s.match(/^(.*?\D)[\s,]*(\d+(?:\s?[a-zA-Z])?(?:\s?[-/]\s?\d+(?:\s?[a-zA-Z])?)?)$/);
  if (m && m[1].trim().length >= 2) return { street: m[1].replace(/[\s,]+$/, "").trim(), number: m[2].replace(/\s+/g, "") };
  // Hausnummer vorne (z. B. Frankreich „12 Rue de Rivoli“)
  const f = s.match(/^(\d+(?:\s?[a-zA-Z])?)[\s,]+(\D.*)$/);
  if (f) return { street: f[2].trim(), number: f[1].replace(/\s+/g, "") };
  return { street: s, number: "" };
}

export type GlsConsignee = {
  name: string; contact?: string; street: string; zip: string; city: string; country: string;
  email?: string; phone?: string; business: boolean;
};
export type ConsigneeProblem = "name" | "street" | "zip" | "city" | "country";

/** Fehlt etwas an der Anschrift, das GLS braucht? (gleiche Prüfung im Formular und auf dem Server) */
export function consigneeProblem(c: GlsConsignee): ConsigneeProblem | null {
  if (!glsText(c.name, 40)) return "name";
  if (!glsText(c.street, 40)) return "street";
  if (!glsText(c.zip, 10)) return "zip";
  if (!glsText(c.city, 40)) return "city";
  if (!/^[A-Z]{2}$/.test(c.country)) return "country";
  return null;
}

// ───────────────────────── Gewicht / Pakete ─────────────────────────

/** kg als Zahl mit höchstens 2 Nachkommastellen; „1,5“ geht auch */
export function parseKg(v: string | number): number | null {
  const n = typeof v === "number" ? v : Number(String(v).replace(",", ".").trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

export type WeightsProblem = "none" | "tooMany" | "tooLight" | "tooHeavy";
export function checkWeights(kgs: (number | null)[]): WeightsProblem | null {
  if (!kgs.length) return "none";
  if (kgs.length > GLS_MAX_PARCELS) return "tooMany";
  if (kgs.some((k) => k == null || k < GLS_MIN_KG)) return "tooLight";
  if (kgs.some((k) => (k ?? 0) > GLS_MAX_KG)) return "tooHeavy";
  return null;
}

/**
 * Vorschlag für die Pakete aus dem Gewicht der Ware (Gramm; null = unbekannt): bis 31,5 kg ein Paket, sonst gleichmäßig verteilt.
 * Unbekanntes Gewicht → 1 kg je Stück als Schätzung (unknown zählt die Positionen ohne Gewicht, damit das Formular darauf hinweist).
 */
export function suggestParcels(items: { grams: number | null; qty: number }[]): { kgs: number[]; unknown: number; heavy: boolean } {
  let total = 0, unknown = 0, heavy = false;
  for (const i of items) {
    if (i.qty <= 0) continue;
    if (i.grams == null || i.grams <= 0) { unknown++; total += 1000 * i.qty; continue; }
    if (i.grams / 1000 > GLS_MAX_KG) heavy = true;
    total += i.grams * i.qty;
  }
  const kg = Math.max(GLS_MIN_KG, total / 1000);
  const n = Math.min(GLS_MAX_PARCELS, Math.max(1, Math.ceil(kg / 31.5)));
  const each = Math.max(GLS_MIN_KG, Math.round((kg / n) * 10) / 10);
  return { kgs: Array.from({ length: n }, () => each), unknown, heavy };
}

// ───────────────────────── Anfrage / Antwort ─────────────────────────

export type GlsCreateInput = {
  reference: string; // Rechnungsnummer (steht auf dem Etikett)
  shippingDate: string; // JJJJ-MM-TT
  consignee: GlsConsignee;
  parcelsKg: number[];
  contactId: string;
  flex: boolean;
};

/** Körper für POST /shipments (und /shipments/validate) */
export function buildGlsShipment(i: GlsCreateInput) {
  const c = i.consignee;
  const { street, number } = splitStreet(c.street);
  const email = (c.email ?? "").trim();
  const phone = glsText(c.phone, 30);
  const address: Record<string, string> = {
    Name1: glsText(c.name, 40),
    ...(glsText(c.contact, 40) && glsText(c.contact, 40) !== glsText(c.name, 40) ? { Name2: glsText(c.contact, 40) } : {}),
    CountryCode: c.country,
    ZIPCode: glsText(c.zip, 10),
    City: glsText(c.city, 40),
    Street: glsText(street, 40),
    ...(number ? { StreetNumber: glsText(number, 10) } : {}),
    ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { eMail: email.slice(0, 80) } : {}),
    ...(phone ? { MobilePhoneNumber: phone } : {}),
  };
  const ref = glsText(i.reference, 40);
  const services = i.flex && address.eMail ? [{ Service: { ServiceName: "service_flexdelivery" } }] : [];
  return {
    Shipment: {
      ...(ref ? { ShipmentReference: [ref] } : {}),
      ShippingDate: i.shippingDate,
      Middleware: "StarStyle",
      Product: "PARCEL",
      Consignee: { Category: c.business ? "BUSINESS" : "PRIVATE", Address: address },
      Shipper: { ContactID: i.contactId },
      ShipmentUnit: i.parcelsKg.map((kg) => ({ ...(ref ? { ShipmentUnitReference: [ref] } : {}), Weight: kg.toFixed(2) })),
      ...(services.length ? { Service: services } : {}),
    },
    PrintingOptions: { ReturnLabels: { TemplateSet: "NONE", LabelFormat: "PDF" } },
    ReturnOptions: { ReturnPrintData: true, ReturnRoutingInfo: true },
  };
}

export type GlsParcel = { trackId: string; parcelNumber: string };
export type GlsCreated = { parcels: GlsParcel[]; labels: string[] /* PDF als Base64 */ };

/** Antwort von POST /shipments lesen; wirft, wenn keine Pakete darin stehen */
export function parseGlsCreated(json: unknown): GlsCreated {
  const o = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const cs = (o.CreatedShipment && typeof o.CreatedShipment === "object" ? o.CreatedShipment : {}) as Record<string, unknown>;
  const parcels = (Array.isArray(cs.ParcelData) ? cs.ParcelData : []).flatMap((p): GlsParcel[] => {
    if (!p || typeof p !== "object") return [];
    const x = p as Record<string, unknown>;
    const trackId = typeof x.TrackID === "string" ? x.TrackID.trim() : "";
    const parcelNumber = typeof x.ParcelNumber === "string" ? x.ParcelNumber.trim() : typeof x.ParcelNumber === "number" ? String(x.ParcelNumber) : "";
    return trackId || parcelNumber ? [{ trackId, parcelNumber }] : [];
  });
  const labels = (Array.isArray(cs.PrintData) ? cs.PrintData : []).flatMap((p) => {
    if (!p || typeof p !== "object") return [];
    const d = (p as Record<string, unknown>).Data;
    return typeof d === "string" && d.length > 20 ? [d.replace(/\s+/g, "")] : [];
  });
  if (!parcels.length) throw new Error("glsNoParcels");
  return { parcels, labels };
}

/** Nummer für Sendungsverfolgung und Shop: Paketnummer (steht auf dem Etikett), sonst TrackID */
export const trackingNumberOf = (p: GlsParcel) => (p.parcelNumber || p.trackId).replace(/\s+/g, "").toUpperCase();

/** Fehlertext von ShipIT (Kopfzeilen message/error/args, sonst Text der Antwort) – kurz und ohne Steuerzeichen */
export function glsErrorText(status: number, headers: { get(name: string): string | null }, body: string): string {
  const parts = [headers.get("message"), headers.get("error"), headers.get("args")].filter((x): x is string => Boolean(x && x.trim()));
  let text = parts.join(" · ");
  if (!text) {
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      text = [j.message, j.error, j.args].filter((x) => typeof x === "string" && x).join(" · ");
    } catch { /* kein JSON */ }
  }
  if (!text) text = body.replace(/<[^>]*>/g, " ");
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return `HTTP ${status}${text ? `: ${text}` : ""}`;
}

/** Storno-Antwort: CANCELLED / CANCELLATION_PENDING = ok */
export function glsCancelOk(json: unknown): boolean {
  const r = json && typeof json === "object" ? String((json as Record<string, unknown>).result ?? "") : "";
  return /^CANCELL?ED$|^CANCELL?ATION_PENDING$/i.test(r);
}
