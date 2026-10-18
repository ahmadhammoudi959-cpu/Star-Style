import { describe, expect, it } from "vitest";
import { accountMap, expenseAccount, expenseAmounts, revenueAccount, suggestTaxCase } from "../src/lib/accounts";
import { balances, bookingCsv, cleanRef, contactCsv, toCp1252, type DatevHeader } from "../src/lib/datev";
import { BOOKING_COLUMNS, CONTACT_COLUMNS } from "../src/lib/datev-columns";
import { monthRange, shiftMonth } from "../src/lib/periods";

const h: DatevHeader = { consultant: 1234567, client: 12345, fiscalYearStart: "2026-01-01", from: "2026-10-01", to: "2026-10-31", label: "Star Style 2026-10", createdAt: new Date("2026-11-02T09:30:00.123Z"), exportedBy: "Ahmad" };
const decode = (b: Buffer) => new TextDecoder("windows-1252").decode(b);

describe("Konten", () => {
  const m3 = accountMap("SKR03"), m4 = accountMap("SKR04");
  it("Erlöskonten je Steuerfall", () => {
    expect(revenueAccount(m3, "DOMESTIC", 1900, null)).toBe(8400);
    expect(revenueAccount(m3, "DOMESTIC", 700, null)).toBe(8300);
    expect(revenueAccount(m3, "EU_REVERSE_CHARGE", 0, null)).toBe(8125);
    expect(revenueAccount(m3, "EXPORT", 0, null)).toBe(8120);
    expect(revenueAccount(m3, "EU_PENDING_VATID", 1900, null)).toBe(8400);
    expect(revenueAccount(m3, "EU_B2C", 2100, "NL")).toBe(8320);
    expect(revenueAccount(m4, "DOMESTIC", 1900, null)).toBe(4400);
  });
  it("Ausgaben: Automatikkonto ohne Schlüssel, sonst Schlüssel", () => {
    expect(expenseAccount(m3, "GOODS", "DOMESTIC", 1900)).toEqual({ account: 3400, bu: "" });
    expect(expenseAccount(m3, "GOODS", "EU_GOODS", 1900)).toEqual({ account: 3425, bu: "" });
    expect(expenseAccount(m3, "ADVERTISING", "EU_SERVICE", 1900)).toEqual({ account: 4600, bu: "94" });
    expect(expenseAccount(m3, "SOFTWARE", "DOMESTIC", 1900)).toEqual({ account: 4806, bu: "9" });
    expect(expenseAccount(m4, "ADVERTISING", "DOMESTIC", 700)).toEqual({ account: 6600, bu: "8" });
    expect(expenseAccount(m3, "INSURANCE", "NO_VAT", 0)).toEqual({ account: 4360, bu: "" });
  });
  it("eigene Konten überschreiben Standard", () => {
    expect(accountMap("SKR03", { exp_ADVERTISING: 4610 }).exp_ADVERTISING).toBe(4610);
    expect(accountMap("SKR03", { bank: -5 }).bank).toBe(1200);
  });
  it("Beträge: brutto → netto, Reverse-Charge netto", () => {
    expect(expenseAmounts("DOMESTIC", 11900, 1900)).toMatchObject({ netCents: 10000, vatCents: 1900, grossCents: 11900 });
    expect(expenseAmounts("DOMESTIC", 1000, 700)).toMatchObject({ netCents: 935, vatCents: 65 });
    expect(expenseAmounts("EU_SERVICE", 50000, 1900)).toMatchObject({ netCents: 50000, vatCents: 0, grossCents: 50000, selfAssessedVatCents: 9500 });
    expect(expenseAmounts("NO_VAT", 3000, 0)).toMatchObject({ netCents: 3000, vatCents: 0, selfAssessedVatCents: 0 });
  });
  it("Steuerfall-Vorschlag", () => {
    expect(suggestTaxCase("IE", "ADVERTISING")).toBe("EU_SERVICE");
    expect(suggestTaxCase("NL", "GOODS")).toBe("EU_GOODS");
    expect(suggestTaxCase("US", "SOFTWARE")).toBe("NON_EU_SERVICE");
    expect(suggestTaxCase("DE", "RENT")).toBe("DOMESTIC");
  });
});

describe("DATEV-Datei", () => {
  it("Kopfzeile, Spalten und Buchung im richtigen Format", () => {
    const csv = decode(bookingCsv(h, [
      { amountCents: 142729, side: "S", account: 10002, contra: 8400, date: "2026-10-05", ref1: "RE-2026-0001", text: "Salon Müller, Köln", serviceDate: "2026-10-05" },
      { amountCents: 50000, side: "S", account: 4600, contra: 70003, bu: "94", date: "2026-10-07", ref1: "FBADS 101/2026#4", text: "Meta Platforms Ireland Werbung", euVatId: "IE 9692928F" },
    ]));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe('"EXTF";700;21;"Buchungsstapel";13;20261102093000123;;"RE";"Ahmad";;1234567;12345;20260101;4;20261001;20261031;"Star Style 2026-10";;1;;0;"EUR";;;;;;;;;');
    expect(lines[0].split(";")).toHaveLength(31);
    expect(lines[1].split(";")).toHaveLength(125);
    const r1 = lines[2].split(";");
    expect(r1).toHaveLength(125);
    expect(r1.slice(0, 14)).toEqual(["1427,29", '"S"', "", "", "", "", "10002", "8400", "", "0510", '"RE-2026-0001"', "", "", '"Salon Müller, Köln"']);
    expect(r1[BOOKING_COLUMNS.indexOf("Leistungsdatum")]).toBe("05102026");
    const r2 = lines[3].split(";");
    expect(r2[8]).toBe('"94"');
    expect(r2[10]).toBe('"FBADS101/20264"');
    expect(r2[BOOKING_COLUMNS.indexOf("EU-Land u. USt-IdNr.")]).toBe('"IE9692928F"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
  it("Windows-1252: Umlaute, Euro und Gedankenstrich als ein Byte, Arabisch als ?", () => {
    expect([...toCp1252("äöüß€–")]).toEqual([0xe4, 0xf6, 0xfc, 0xdf, 0x80, 0x96]);
    expect(toCp1252("صالون").toString("latin1")).toBe("?????");
  });
  it("Belegfeld nur mit erlaubten Zeichen", () => {
    expect(cleanRef("R. 2026_001 #A", 36)).toBe("R2026001A");
  });
  it("Datum außerhalb des Monats wird abgelehnt", () => {
    expect(() => bookingCsv(h, [{ amountCents: 100, side: "S", account: 1200, contra: 10001, date: "2026-11-01" }])).toThrow(/Zeitraum/);
    expect(() => bookingCsv(h, [{ amountCents: 0, side: "S", account: 1200, contra: 10001, date: "2026-10-01" }])).toThrow(/Betrag/);
  });
  it("Stammdaten: Debitor mit USt-IdNr.", () => {
    const csv = decode(contactCsv(h, [{ account: 10002, name: "Kapper Utrecht BV", vatId: "NL859048165B01", street: "Oudegracht 1", zip: "3511", city: "Utrecht", country: "NL" }]));
    const lines = csv.split("\r\n");
    expect(lines[0].split(";")).toHaveLength(31);
    expect(lines[0].startsWith('"EXTF";700;16;"Debitoren/Kreditoren";5;')).toBe(true);
    const r = lines[2].split(";");
    expect(r).toHaveLength(CONTACT_COLUMNS.length);
    expect(r[0]).toBe("10002");
    expect(r[CONTACT_COLUMNS.indexOf("EU-Land")]).toBe('"NL"');
    expect(r[CONTACT_COLUMNS.indexOf("EU-USt-IdNr.")]).toBe('"859048165B01"');
    expect(r[CONTACT_COLUMNS.indexOf("Ort")]).toBe('"Utrecht"');
  });
  it("Buchungen gleichen sich aus (Rechnung + Zahlung)", () => {
    const b = balances([
      { amountCents: 11900, side: "S", account: 10001, contra: 8400, date: "2026-10-01" },
      { amountCents: 11900, side: "S", account: 1200, contra: 10001, date: "2026-10-02" },
    ]);
    expect(b.get(10001)).toBe(0);
    expect(b.get(1200)).toBe(11900);
    expect(b.get(8400)).toBe(-11900);
  });
});

describe("Monate", () => {
  it("Monatsgrenzen", () => {
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02").to).toBe("2028-02-29");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});
