import { describe, expect, it } from "vitest";
import {
  dimsInputParts, dimsOf, formatDims, freightReasons, parcelValueLevel, parseDims, productShipping, sortedSides,
} from "../src/lib/shipping-class";

// Versandart Paket (GLS) / Spedition (Möbel) – Grenzen aus dem GLS-Vertrag 19.11.2026 (AGB 4.2)
describe("Versandart aus Gewicht und Paketmaßen", () => {
  it("Seiten der Größe nach: Länge = längste, Höhe = kürzeste", () => {
    expect(sortedSides({ l: 300, w: 1880, h: 870 })).toEqual([1880, 870, 300]);
  });

  it("GLS-Grenzen: 40 kg, Länge 2 m, Breite 80 cm, Höhe 60 cm, Gurtmaß 3 m", () => {
    expect(freightReasons(40_000, { l: 2000, w: 300, h: 200 })).toEqual([]); // genau an der Grenze (Gurtmaß 3 m) geht noch
    expect(freightReasons(null, { l: 2000, w: 800, h: 100 })).toEqual(["girth"]); // 2 m lang und 80 cm breit: Gurtmaß 3,8 m
    expect(freightReasons(40_001, null)).toEqual(["weight"]);
    expect(freightReasons(null, { l: 2060, w: 1060, h: 80 })).toEqual(["length", "width", "girth"]); // Spiegel 206 × 106 cm
    expect(freightReasons(16_400, { l: 510, w: 460, h: 410 })).toEqual([]); // Beistelltisch 51 × 46 × 41
    expect(freightReasons(22_000, { l: 650, w: 600, h: 600 })).toEqual(["girth"]); // Friseurstuhl: 65 + 120 + 120 = 305 cm
    expect(freightReasons(64_000, { l: 840, w: 770, h: 710 })).toEqual(["weight", "height", "girth"]); // Barberstuhl
    expect(freightReasons(null, null)).toEqual([]);
  });

  it("Artikel: Spedition, sobald eine Größe/Farbe nicht als Paket geht; fest eingestellt geht vor", () => {
    const chair = { weightGrams: 64_000, dims: { l: 840, w: 770, h: 710 } };
    const comb = { weightGrams: 40, dims: { l: 220, w: 100, h: 30 } };
    expect(productShipping(null, [comb])).toEqual({ cls: "PARCEL", auto: true, reasons: [], known: true });
    expect(productShipping(null, [comb, chair])).toMatchObject({ cls: "FREIGHT", auto: true, reasons: ["weight", "height", "girth"] });
    expect(productShipping("PARCEL", [chair])).toMatchObject({ cls: "PARCEL", auto: false, reasons: ["weight", "height", "girth"] });
    expect(productShipping("FREIGHT", [comb])).toMatchObject({ cls: "FREIGHT", auto: false, reasons: [] });
    // nichts bekannt → Paket, aber „known: false“ (Formular weist darauf hin)
    expect(productShipping(null, [{ weightGrams: null, dims: null }])).toEqual({ cls: "PARCEL", auto: true, reasons: [], known: false });
    expect(productShipping(null, [])).toEqual({ cls: "PARCEL", auto: true, reasons: [], known: false });
  });

  it("Formular: cm mit Komma oder Punkt → mm; alle leer = keine Maße; halb ausgefüllt oder Unsinn = Fehler", () => {
    expect(parseDims("51", "46", "41")).toEqual({ l: 510, w: 460, h: 410 });
    expect(parseDims("25,5", "8", "0.1")).toEqual({ l: 255, w: 80, h: 1 });
    expect(parseDims(" 188 cm", "87", "9")).toEqual({ l: 1880, w: 870, h: 90 });
    expect(parseDims("", "", "")).toBeNull();
    expect(parseDims("51", "", "41")).toBeUndefined();
    expect(parseDims("51", "x", "41")).toBeUndefined();
    expect(parseDims("0", "46", "41")).toBeUndefined();
    expect(parseDims("1001", "46", "41")).toBeUndefined(); // über 10 m
    expect(dimsInputParts({ l: 255, w: 80, h: 1 })).toEqual({ pkgL: "25,5", pkgW: "8", pkgH: "0,1" });
    expect(dimsInputParts(null)).toEqual({ pkgL: "", pkgW: "", pkgH: "" });
    expect(formatDims({ l: 510, w: 460, h: 410 })).toBe("51 × 46 × 41 cm");
    expect(dimsOf({ pkgLengthMm: 510, pkgWidthMm: 460, pkgHeightMm: 410 })).toEqual({ l: 510, w: 460, h: 410 });
    expect(dimsOf({ pkgLengthMm: 510, pkgWidthMm: null, pkgHeightMm: 410 })).toBeNull();
  });

  it("Warenwert je GLS-Paket: Haftung nur bis 750 €, über 5.000 € ausgeschlossen", () => {
    expect(parcelValueLevel(75_000, 1)).toBe("ok");
    expect(parcelValueLevel(75_001, 1)).toBe("over750");
    expect(parcelValueLevel(150_000, 2)).toBe("ok");
    expect(parcelValueLevel(500_001, 1)).toBe("over5000");
    expect(parcelValueLevel(900_000, 2)).toBe("over750");
    expect(parcelValueLevel(10_000, 0)).toBe("ok");
  });
});
