import { describe, expect, it } from "vitest";
import { barPath, niceScale } from "../src/lib/chart-scale";

describe("Diagramm-Achse", () => {
  it("runde Schritte, 0 immer dabei (auch mit Verlust)", () => {
    // Umsatz 754 €, Verlust -746 € → -1.000 / -500 / 0 / 500 / 1.000
    expect(niceScale(-74_600, 75_400).ticks).toEqual([-100_000, -50_000, 0, 50_000, 100_000]);
    expect(niceScale(0, 1_234_500).ticks).toEqual([0, 500_000, 1_000_000, 1_500_000]);
    expect(niceScale(0, 380_000).ticks).toEqual([0, 100_000, 200_000, 300_000, 400_000]);
    expect(niceScale(0, 99_000).ticks).toEqual([0, 25_000, 50_000, 75_000, 100_000]);
    expect(niceScale(-5_000, 0).ticks).toEqual([-6_000, -4_000, -2_000, 0]);
  });

  it("kleiner Verlust neben großem Umsatz: kaum Platz unter der 0 (keine leere Hälfte)", () => {
    const s = niceScale(-354_000, 23_803_000); // -3.540 € neben 238.030 €
    expect(s.ticks).toEqual([0, 10_000_000, 20_000_000, 30_000_000]);
    expect(s.lo).toBe(-442_500);
    expect(s.lo).toBeLessThan(-354_000); // Verlust-Säule passt hinein
  });

  it("ohne Zahlen: trotzdem eine gültige Achse", () => {
    const s = niceScale(0, 0);
    expect(s.ticks).toEqual([0, 100]);
    expect(s.hi).toBeGreaterThan(s.lo);
  });

  it("Schritte sind ganze Euro", () => {
    for (const max of [3_00, 7_00, 13_00, 999_99, 12_345_67, 98_765_43]) {
      const s = niceScale(0, max);
      expect(s.step % 100).toBe(0);
      expect(s.ticks[0]).toBe(0);
      expect(s.ticks[s.ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(s.ticks.length).toBeLessThanOrEqual(8);
    }
  });

  it("Säule: runde Spitze, gerade an der Nulllinie; nichts bei 0", () => {
    expect(barPath(10, 20, 100, 40)).toBe("M10,100V44Q10,40 14,40H26Q30,40 30,44V100Z");
    expect(barPath(10, 20, 100, 160)).toBe("M10,100V156Q10,160 14,160H26Q30,160 30,156V100Z");
    expect(barPath(10, 20, 100, 100)).toBe("");
  });
});
