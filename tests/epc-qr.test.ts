import { expect, it } from "vitest";
import { epcPayload, modulesPath, qrModules } from "../src/lib/epc-qr";

// EPC-QR („GiroCode“) für „Scannen & bezahlen“ auf der Rechnung
it("EPC-Inhalt: Zeilen, Betrag in Cent genau, IBAN ohne Leerzeichen", () => {
  expect(epcPayload({ name: "Star-Style", iban: "DE89 3704 0044 0532 0130 00", bic: "COBADEFFXXX", amountCents: 176112, text: "RE-2026-0009" }))
    .toBe("BCD\n002\n1\nSCT\nCOBADEFFXXX\nStar-Style\nDE89370400440532013000\nEUR1761.12\n\n\nRE-2026-0009");
  expect(epcPayload({ name: "A", iban: "DE89370400440532013000", amountCents: 5, text: "x" })?.split("\n")[7]).toBe("EUR0.05");
  expect(epcPayload({ name: "A", iban: "DE89370400440532013000", bic: "kaputt", amountCents: 100, text: "x" })?.split("\n")[4]).toBe(""); // BIC ist optional
});
it("EPC: ungültige Daten → kein QR-Code", () => {
  expect(epcPayload({ name: "A", iban: "", amountCents: 100, text: "x" })).toBeNull();
  expect(epcPayload({ name: "A", iban: "DE89370400440532013000", amountCents: 0, text: "x" })).toBeNull();
  expect(epcPayload({ name: " ", iban: "DE89370400440532013000", amountCents: 100, text: "x" })).toBeNull();
  const long = epcPayload({ name: "N".repeat(90), iban: "DE89370400440532013000", amountCents: 100, text: "T".repeat(200) })!.split("\n");
  expect(long[5].length).toBe(70);
  expect(long[10].length).toBe(140);
});
it("QR-Matrix quadratisch, Pfad nicht leer, Umlaute als UTF-8", () => {
  const m = qrModules("BCD\n002\n1\nSCT\n\nMüller & Söhne\nDE89370400440532013000\nEUR1.00\n\n\nÄÖÜ");
  expect(m.length).toBeGreaterThan(20);
  expect(m.every((r) => r.length === m.length)).toBe(true);
  expect(modulesPath(m)).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
});
