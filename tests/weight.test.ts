import { describe, expect, it } from "vitest";
import { formatWeight, parseWeight, shipmentWeight, shopWeightToGrams, weightInputParts } from "../src/lib/weight";

describe("Gewicht je Größe/Farbe", () => {
  it("Eingabe → Gramm: Einheit im Text gilt vor der gewählten, Komma oder Punkt, leer/0 = kein Gewicht", () => {
    expect(parseWeight("150")).toBe(150);
    expect(parseWeight("150", "kg")).toBe(150_000);
    expect(parseWeight("1,5", "kg")).toBe(1500);
    expect(parseWeight("1.25 kg")).toBe(1250);
    expect(parseWeight(" 250 g ", "kg")).toBe(250);
    expect(parseWeight("0,3333", "kg")).toBe(333);
    expect(parseWeight("")).toBeNull();
    expect(parseWeight("0")).toBeNull();
    expect(parseWeight("abc")).toBeUndefined();
    expect(parseWeight("-5")).toBeUndefined();
    expect(parseWeight("1001", "kg")).toBeUndefined(); // über 1 t
  });

  it("Anzeige deutsch: g bis 999, darüber kg mit höchstens zwei Nachkommastellen", () => {
    expect(formatWeight(150)).toBe("150 g");
    expect(formatWeight(1000)).toBe("1 kg");
    expect(formatWeight(1500)).toBe("1,5 kg");
    expect(formatWeight(12_345)).toBe("12,35 kg");
    expect(formatWeight(35_000)).toBe("35 kg");
  });

  it("Formularfeld aus Gramm; Gesamtgewicht einer Sendung mit fehlenden Positionen", () => {
    expect(weightInputParts(null)).toEqual({ weight: "", weightUnit: "g" });
    expect(weightInputParts(150)).toEqual({ weight: "150", weightUnit: "g" });
    expect(weightInputParts(35_500)).toEqual({ weight: "35,5", weightUnit: "kg" });
    expect(shipmentWeight([{ qty: 10, weightGrams: 150 }, { qty: -2, weightGrams: 35_000 }, { qty: 3, weightGrams: null }, { qty: 0, weightGrams: null }]))
      .toEqual({ grams: 71_500, missing: 1 });
  });

  it("Gewicht aus Shopify in Gramm (0 = keins)", () => {
    expect(shopWeightToGrams({ unit: "KILOGRAMS", value: 1.2 })).toBe(1200);
    expect(shopWeightToGrams({ unit: "GRAMS", value: 150 })).toBe(150);
    expect(shopWeightToGrams({ unit: "POUNDS", value: 1 })).toBe(454);
    expect(shopWeightToGrams({ unit: "KILOGRAMS", value: 0 })).toBeNull();
    expect(shopWeightToGrams(null)).toBeNull();
  });
});
