import { describe, expect, it } from "vitest";
import { applyBp, grossFromNet, netFromGross, parseMoney, parsePercentToBp } from "../src/lib/money";

describe("parseMoney", () => {
  it.each([
    ["12,50", 1250], ["12.50", 1250], ["1.234,56", 123456], ["1,234.56", 123456], ["0", 0], ["7", 700], ["  3,2 € ", 320],
  ])("%s → %i", (i, o) => expect(parseMoney(i)).toBe(o));
  // "1,234" ist mehrdeutig (Tausender oder Dezimal?) → lieber ablehnen als falsch buchen
  it.each(["", "abc", "1,234", "12,345", "1.2.3"])("ungültig: %s", (i) => expect(parseMoney(i)).toBeNull());
});

describe("Prozente", () => {
  it("19 % → 1900 bp", () => expect(parsePercentToBp("19")).toBe(1900));
  it("5,5 % → 550 bp", () => expect(parsePercentToBp("5,5")).toBe(550));
  it("leer → 0", () => expect(parsePercentToBp("")).toBe(0));
  it("Rundung", () => expect(applyBp(999, 1900)).toBe(190));
});

describe("Brutto aus Netto (Shop-Preise)", () => {
  it("nimmt den runden Bruttopreis, wenn zwei denselben Nettopreis ergeben (Fehler 09.11.2026)", () => {
    expect(grossFromNet(41176, 1900)).toBe(49000); // nicht 489,99
    expect(grossFromNet(48739, 1900)).toBe(58000); // nicht 579,99
    expect(grossFromNet(2092, 1900)).toBe(2490); // nicht 24,89
    expect(grossFromNet(1261, 1900)).toBe(1500); // nicht 15,01
    expect(grossFromNet(1000, 1900)).toBe(1190);
    expect(grossFromNet(4202, 1900)).toBe(5000);
  });
  it("jeder Shop-Preis auf 0 oder 5 Cent kommt nach Import (netto) und Abgleich (brutto) genau so zurück", () => {
    for (const vat of [1900, 700]) {
      for (let g = 5; g <= 300000; g += 5) expect(grossFromNet(netFromGross(g, vat), vat)).toBe(g);
    }
  });
});
