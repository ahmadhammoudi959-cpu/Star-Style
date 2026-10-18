import { describe, expect, it } from "vitest";
import { computeTotals, determineTaxMode, effectiveRateBp, legalNotes, skontoAmount } from "../src/lib/tax";

describe("Steuerbehandlung", () => {
  it("Deutschland → Inland", () => expect(determineTaxMode({ type: "COMPANY", country: "DE", vatIdStatus: "VALID" })).toBe("DOMESTIC"));
  it("NL-Firma mit gültiger USt-IdNr. → steuerfrei", () => expect(determineTaxMode({ type: "COMPANY", country: "nl", vatIdStatus: "VALID" })).toBe("EU_REVERSE_CHARGE"));
  it("NL-Firma, Nummer ausstehend → deutsche USt mit Vermerk", () => expect(determineTaxMode({ type: "COMPANY", country: "NL", vatIdStatus: "PENDING" })).toBe("EU_PENDING_VATID"));
  it("NL-Firma, Nummer ungültig → wie Privat", () => expect(determineTaxMode({ type: "COMPANY", country: "NL", vatIdStatus: "INVALID" })).toBe("EU_B2C"));
  it("NL-Privatkunde → EU-Privat", () => expect(determineTaxMode({ type: "PERSON", country: "NL", vatIdStatus: "NONE" })).toBe("EU_B2C"));
  it("Schweiz → Ausfuhr", () => expect(determineTaxMode({ type: "COMPANY", country: "CH", vatIdStatus: "NONE" })).toBe("EXPORT"));
  it("Syrien → Ausfuhr", () => expect(determineTaxMode({ type: "PERSON", country: "SY", vatIdStatus: "NONE" })).toBe("EXPORT"));
});

describe("Steuersatz", () => {
  it("steuerfrei = 0", () => expect(effectiveRateBp("EU_REVERSE_CHARGE", 1900, { country: "NL", ossExceeded: false })).toBe(0));
  it("EU-Privat unter Schwelle = deutscher Satz", () => expect(effectiveRateBp("EU_B2C", 1900, { country: "NL", ossExceeded: false })).toBe(1900));
  it("EU-Privat über Schwelle = Satz des Ziellands", () => expect(effectiveRateBp("EU_B2C", 1900, { country: "NL", ossExceeded: true })).toBe(2100));
  it("ausstehende USt-IdNr. = deutscher Satz", () => expect(effectiveRateBp("EU_PENDING_VATID", 700, { country: "BE", ossExceeded: true })).toBe(700));
});

describe("Summen", () => {
  it("einfache Rechnung 19 %", () => {
    const t = computeTotals([{ qty: 3, unitPriceCents: 1490, discountBp: 0, vatRateBp: 1900 }]);
    expect(t.netCents).toBe(4470);
    expect(t.vatCents).toBe(849);
    expect(t.grossCents).toBe(5319);
  });
  it("Positionsrabatt + Gesamtrabatt, zwei Steuersätze", () => {
    const t = computeTotals([
      { qty: 10, unitPriceCents: 1000, discountBp: 1000, vatRateBp: 1900 }, // 100 − 10 % = 90,00
      { qty: 4, unitPriceCents: 250, discountBp: 0, vatRateBp: 700 },       // 10,00
    ], 500);                                                                  // −5 %
    expect(t.subtotalCents).toBe(10000);
    expect(t.lines.map((l) => l.netCents)).toEqual([8550, 950]);
    expect(t.discountCents).toBe(500);
    expect(t.vatByRate).toEqual([{ rateBp: 1900, netCents: 8550, vatCents: 1625 }, { rateBp: 700, netCents: 950, vatCents: 67 }]);
    expect(t.grossCents).toBe(9500 + 1625 + 67);
  });
  it("Positions-USt summiert sich exakt zur USt je Satz", () => {
    const t = computeTotals(Array.from({ length: 7 }, () => ({ qty: 1, unitPriceCents: 333, discountBp: 0, vatRateBp: 1900 })));
    expect(t.lines.reduce((s, l) => s + l.vatCents, 0)).toBe(t.vatCents);
  });
  it("Skonto 2 %", () => expect(skontoAmount(10000, 200)).toBe(9800));
});

describe("Pflichthinweise", () => {
  it("innergemeinschaftliche Lieferung", () => expect(legalNotes("EU_REVERSE_CHARGE", {})[0]).toContain("§ 4 Nr. 1b"));
  it("Eigentumsvorbehalt", () => expect(legalNotes("DOMESTIC", { retentionOfTitle: true })).toHaveLength(1));
});
