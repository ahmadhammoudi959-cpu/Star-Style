import { describe, expect, it } from "vitest";
import { applyBp, parseMoney, parsePercentToBp } from "../src/lib/money";

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
