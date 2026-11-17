import { describe, expect, it } from "vitest";
import { zoomPlacement, zoomSize } from "../src/lib/zoom-place";

const view = { width: 1600, height: 900 };
const box = { width: 400, height: 480 };

describe("Große Fotovorschau neben dem kleinen Bild", () => {
  it("rechts daneben, wenn dort Platz ist; senkrecht mittig zum Bild", () => {
    expect(zoomPlacement({ left: 100, top: 400, right: 156, bottom: 456 }, view, box)).toEqual({ left: 168, top: 188 });
  });
  it("links daneben, wenn rechts kein Platz ist (z. B. Bild am rechten Rand, RTL)", () => {
    expect(zoomPlacement({ left: 1450, top: 100, right: 1506, bottom: 156 }, view, box)).toEqual({ left: 1038, top: 8 });
  });
  it("nie über den Rand: oben/unten begrenzt", () => {
    expect(zoomPlacement({ left: 100, top: 860, right: 156, bottom: 890 }, view, box).top).toBe(900 - 8 - 480);
    expect(zoomPlacement({ left: 100, top: 0, right: 156, bottom: 20 }, view, box).top).toBe(8);
  });
  it("passt auf keiner Seite: zur größeren Seite, aber im Bild", () => {
    const small = { width: 700, height: 600 };
    const p = zoomPlacement({ left: 300, top: 100, right: 380, bottom: 180 }, small, { width: 400, height: 300 });
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + 400).toBeLessThanOrEqual(700 - 8);
  });
  it("Größe: höchstens 26rem, 42 % der Breite, passt in die Höhe", () => {
    expect(zoomSize({ width: 1920, height: 1080 }, 14.4, 70)).toBe(Math.round(26 * 14.4));
    expect(zoomSize({ width: 800, height: 1080 }, 14.4, 70)).toBe(Math.round(800 * 0.42));
    expect(zoomSize({ width: 1920, height: 500 }, 14.4, 70)).toBe(Math.round(500 - 70 - 4 * 14.4));
    expect(zoomSize({ width: 300, height: 300 }, 16, 70)).toBe(160); // nie kleiner als 10rem
  });
});
