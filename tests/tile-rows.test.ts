import { describe, expect, it } from "vitest";
import { TILE_MAX, tileRows, tilesPerRow, tileVars } from "@/lib/tile-rows";

describe("Kacheln auf der Startseite – gleich volle Reihen über die ganze Breite", () => {
  it("11 Kacheln am Laptop = 2 Reihen 6 + 5 (nicht 5 + 5 + 1)", () => {
    expect(tileRows(11, TILE_MAX.xl)).toEqual([6, 5]);
    expect(tileRows(11, TILE_MAX.x2)).toEqual([6, 5]);
  });

  it("weniger Platz → mehr Reihen, trotzdem gleich voll", () => {
    expect(tileRows(11, TILE_MAX.lg)).toEqual([4, 4, 3]);
    expect(tileRows(11, TILE_MAX.sm)).toEqual([3, 3, 3, 2]);
    expect(tileRows(9, TILE_MAX.xl)).toEqual([5, 4]);
    expect(tileRows(10, TILE_MAX.xl)).toEqual([5, 5]);
    expect(tileRows(12, TILE_MAX.xl)).toEqual([6, 6]);
    expect(tileRows(13, TILE_MAX.xl)).toEqual([5, 5, 3]);
    expect(tileRows(13, TILE_MAX.x2)).toEqual([7, 6]);
    expect(tileRows(8, TILE_MAX.md)).toEqual([4, 4]);
    expect(tileRows(7, TILE_MAX.xl)).toEqual([4, 3]);
  });

  it("nie mehr als erlaubt, nie mehr Reihen als nötig, nur die letzte Reihe darf kürzer sein (sie streckt sich)", () => {
    for (let n = 1; n <= 30; n++) for (const max of Object.values(TILE_MAX)) {
      const rows = tileRows(n, max), per = tilesPerRow(n, max);
      expect(rows.reduce((s, r) => s + r, 0)).toBe(n);
      expect(per).toBeLessThanOrEqual(max);
      expect(rows.length).toBe(Math.ceil(n / max));
      expect(rows.slice(0, -1).every((r) => r === per)).toBe(true);
      // keine Reihenzahl-gleiche Aufteilung mit weniger Kacheln je Reihe wäre voller: per − 1 reicht nicht für diese Reihen
      expect((per - 1) * rows.length).toBeLessThan(n);
    }
  });

  it("Unsinn ergibt eine Spalte statt eines Fehlers", () => {
    expect(tilesPerRow(0, 6)).toBe(1);
    expect(tilesPerRow(-3, 6)).toBe(1);
    expect(tilesPerRow(Number.NaN, 6)).toBe(1);
    expect(tilesPerRow(5, 0)).toBe(1);
    expect(tileRows(0, 6)).toEqual([]);
  });

  it("CSS-Variablen je Breite; eine oder zwei Kacheln werden nicht über die Seite gezogen", () => {
    expect(tileVars(11)).toEqual({ "--tg": "1", "--tc-sm": "3", "--tc-md": "4", "--tc-lg": "4", "--tc-xl": "6", "--tc-x2": "6" });
    expect(tileVars(9)).toMatchObject({ "--tg": "1", "--tc-xl": "5", "--tc-lg": "3" });
    expect(tileVars(3)).toMatchObject({ "--tg": "1", "--tc-sm": "3", "--tc-xl": "3" });
    expect(tileVars(2)).toEqual({ "--tg": "0", "--tc-sm": "3", "--tc-md": "4", "--tc-lg": "4", "--tc-xl": "4", "--tc-x2": "4" });
    expect(tileVars(1)).toMatchObject({ "--tg": "0", "--tc-xl": "4" });
  });
});
