/**
 * DATEV-Export im Format EXTF (Version 700): Buchungsstapel und Debitoren/Kreditoren.
 * Reine Funktionen ohne Datenbank – vollständig getestet.
 *
 * Wichtig für den Import beim Steuerberater:
 * - Zeichensatz Windows-1252, Trennzeichen Semikolon, Zeilenende CRLF
 * - Betrag immer positiv mit Komma, Richtung über Soll/Haben-Kennzeichen (bezogen auf „Konto“)
 * - Belegdatum TTMM, alle Buchungen innerhalb des Zeitraums im Kopf (ein Monat)
 */
import { BOOKING_COLUMNS, CONTACT_COLUMNS } from "./datev-columns";

export type DatevBooking = {
  amountCents: number;         // > 0
  side: "S" | "H";             // bezogen auf account
  account: number;
  contra: number;
  bu?: string;                 // Steuerschlüssel
  date: string;                // YYYY-MM-DD (Belegdatum)
  ref1?: string;               // Belegfeld 1 (Rechnungsnummer)
  ref2?: string;               // Belegfeld 2
  text?: string;               // Buchungstext
  euVatId?: string;            // EU-Land u. USt-IdNr. (z. B. NL859048165B01 oder nur NL bei OSS)
  euRateBp?: number;           // EU-Steuersatz (OSS)
  serviceDate?: string;        // Leistungsdatum YYYY-MM-DD
};

export type DatevContact = {
  account: number; name: string; person?: boolean; euCountry?: string; vatId?: string;
  street?: string; zip?: string; city?: string; country?: string; email?: string; phone?: string;
};

export type DatevHeader = {
  consultant: number; client: number; fiscalYearStart: string; from: string; to: string;
  label: string; createdAt: Date; exportedBy: string;
};

// ───────────── Zeichensatz Windows-1252 ─────────────
const CP1252_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c,
  "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};
export function toCp1252(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (CP1252_EXTRA[ch] !== undefined) out.push(CP1252_EXTRA[ch]);
    else out.push(0x3f); // „?“ für Zeichen, die DATEV nicht darstellen kann (z. B. Arabisch)
  }
  return Buffer.from(out);
}

// ───────────── Feld-Formatierung ─────────────
const q = (s: string | undefined | null) => (s ? `"${s.replace(/[\r\n;]+/g, " ").replace(/"/g, '""')}"` : "");
const amount = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");
const ddmm = (iso: string) => iso.slice(8, 10) + iso.slice(5, 7);
const ddmmyyyy = (iso: string) => iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4);
const yyyymmdd = (iso: string) => iso.replace(/-/g, "");
const stamp = (d: Date) => d.toISOString().replace(/[-:TZ.]/g, "").slice(0, 17);
/** Belegfeld: nur A–Z, 0–9 und $ & % * + - / erlaubt */
export const cleanRef = (s: string | undefined, max: number) => (s ?? "").replace(/[^a-zA-Z0-9$&%*+\-/]/g, "").slice(0, max);
const cleanText = (s: string | undefined, max: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max).trim();

function headerLine(h: DatevHeader, category: 21 | 16) {
  if (category === 21) {
    return [q("EXTF"), 700, 21, q("Buchungsstapel"), 13, stamp(h.createdAt), "", q("RE"), q(cleanText(h.exportedBy, 25)), "",
      h.consultant, h.client, yyyymmdd(h.fiscalYearStart), 4, yyyymmdd(h.from), yyyymmdd(h.to), q(cleanText(h.label, 30)), "", 1, "", 0, q("EUR"),
      "", "", "", "", "", "", "", "", ""].join(";");
  }
  return [q("EXTF"), 700, 16, q("Debitoren/Kreditoren"), 5, stamp(h.createdAt), "", q("RE"), q(cleanText(h.exportedBy, 25)), "",
    h.consultant, h.client, yyyymmdd(h.fiscalYearStart), 4, "", "", q("Kunden und Lieferanten"),
    "", "", "", "", "", "", "", "", "", "", "", "", "", ""].join(";");
}

const BI = (name: (typeof BOOKING_COLUMNS)[number]) => BOOKING_COLUMNS.indexOf(name);
const CI = (name: (typeof CONTACT_COLUMNS)[number]) => CONTACT_COLUMNS.indexOf(name);

export class DatevError extends Error {}

export function validateBooking(b: DatevBooking, h: DatevHeader) {
  if (!Number.isInteger(b.amountCents) || b.amountCents <= 0) throw new DatevError(`Betrag ungültig: ${b.ref1 ?? ""}`);
  if (b.date < h.from || b.date > h.to) throw new DatevError(`Datum außerhalb des Zeitraums: ${b.date} (${b.ref1 ?? ""})`);
  if (!b.account || !b.contra) throw new DatevError(`Konto fehlt: ${b.ref1 ?? ""}`);
}

export function bookingCsv(h: DatevHeader, rows: DatevBooking[]): Buffer {
  const lines = [headerLine(h, 21), BOOKING_COLUMNS.join(";")];
  for (const b of rows) {
    validateBooking(b, h);
    const f: string[] = new Array(BOOKING_COLUMNS.length).fill("");
    f[BI("Umsatz (ohne Soll/Haben-Kz)")] = amount(b.amountCents);
    f[BI("Soll/Haben-Kennzeichen")] = q(b.side);
    f[BI("Konto")] = String(b.account);
    f[BI("Gegenkonto (ohne BU-Schlüssel)")] = String(b.contra);
    f[BI("BU-Schlüssel")] = q(b.bu);
    f[BI("Belegdatum")] = ddmm(b.date);
    f[BI("Belegfeld 1")] = q(cleanRef(b.ref1, 36));
    f[BI("Belegfeld 2")] = q(cleanRef(b.ref2, 12));
    f[BI("Buchungstext")] = q(cleanText(b.text, 60));
    if (b.euVatId) f[BI("EU-Land u. USt-IdNr.")] = q(b.euVatId.replace(/\s/g, "").toUpperCase().slice(0, 15));
    if (b.euRateBp) f[BI("EU-Steuersatz")] = (b.euRateBp / 100).toFixed(2).replace(".", ",");
    if (b.serviceDate) f[BI("Leistungsdatum")] = ddmmyyyy(b.serviceDate);
    lines.push(f.join(";"));
  }
  return toCp1252(lines.join("\r\n") + "\r\n");
}

export function contactCsv(h: DatevHeader, contacts: DatevContact[]): Buffer {
  const lines = [headerLine(h, 16), CONTACT_COLUMNS.join(";")];
  for (const c of contacts) {
    const f: string[] = new Array(CONTACT_COLUMNS.length).fill("");
    f[CI("Konto")] = String(c.account);
    if (c.person) f[CI("Name (Adressatentyp natürl. Person)")] = q(cleanText(c.name, 30));
    else f[CI("Name (Adressatentyp Unternehmen)")] = q(cleanText(c.name, 50));
    f[CI("Adressatentyp")] = q(c.person ? "1" : "2");
    f[CI("Kurzbezeichnung")] = q(cleanText(c.name, 15));
    if (c.vatId) {
      const v = c.vatId.replace(/\s/g, "").toUpperCase();
      f[CI("EU-Land")] = q(v.slice(0, 2));
      f[CI("EU-USt-IdNr.")] = q(v.slice(2, 15));
    }
    if (c.street || c.city) {
      f[CI("Adressart")] = q("STR");
      f[CI("Straße")] = q(cleanText(c.street, 36));
      f[CI("Postleitzahl")] = q(cleanText(c.zip, 10));
      f[CI("Ort")] = q(cleanText(c.city, 30));
      f[CI("Land")] = q((c.country ?? "").slice(0, 2).toUpperCase());
    }
    if (c.phone) f[CI("Telefon")] = q(cleanText(c.phone, 60));
    if (c.email) f[CI("E-Mail")] = q(cleanText(c.email, 60));
    lines.push(f.join(";"));
  }
  return toCp1252(lines.join("\r\n") + "\r\n");
}

/** Prüfsumme: Soll und Haben aller Buchungen je Konto (für die Übersicht und Tests). */
export function balances(rows: DatevBooking[]) {
  const m = new Map<number, number>();
  for (const b of rows) {
    const s = b.side === "S" ? b.amountCents : -b.amountCents;
    m.set(b.account, (m.get(b.account) ?? 0) + s);
    m.set(b.contra, (m.get(b.contra) ?? 0) - s);
  }
  return m;
}
