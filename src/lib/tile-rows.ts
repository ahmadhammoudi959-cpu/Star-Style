/**
 * Schnellzugriffe (Kacheln) auf der Startseite – Wunsch Inhaber 20.11.2026: „كله يكون فليكسبل … ياخد الشاشه … يبقوا صفين“.
 *
 * Ab Tablet stehen die Kacheln in Reihen über die ganze Breite: so wenige Reihen wie möglich, alle gleich voll
 * (11 Kacheln = 6 + 5 statt 5 + 5 + 1, 9 = 5 + 4, 8 = 4 + 4); die Kacheln wachsen, also füllt auch die letzte Reihe
 * die Breite (globals.css `.tile-rows`). TILE_MAX = höchstens so viele nebeneinander, wie bei dieser Bildschirmbreite
 * hineinpassen, ohne dass eine Beschriftung (längste: de/ku) über den Rand läuft – Kachel ≥ ~150 px.
 * Breiten (CSS-px, ab lg mit Seitenleiste): sm 640, md 768, lg 1024, xl 1280, x2 1600. Handy: Wischleiste wie bisher.
 */
export const TILE_MAX = { sm: 3, md: 4, lg: 4, xl: 6, x2: 7 } as const;
export type TileBreakpoint = keyof typeof TILE_MAX;

/** Kacheln je Reihe: erst die kleinste Zahl Reihen, dann gleichmäßig verteilt (vordere Reihen höchstens eine mehr) */
export function tilesPerRow(n: number, max: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  const m = Math.max(1, Math.floor(max));
  return Math.ceil(n / Math.ceil(n / m));
}

/** Aufteilung auf Reihen (nur für Tests und zum Nachlesen): z. B. 11 bei höchstens 6 → [6, 5] */
export function tileRows(n: number, max: number): number[] {
  const per = tilesPerRow(n, max), rows: number[] = [];
  for (let left = Math.max(0, Math.floor(n)); left > 0; left -= per) rows.push(Math.min(per, left));
  return rows;
}

/**
 * CSS-Variablen für den Container (`style`): `--tc-<Breite>` = Kacheln je Reihe, `--tg` = wachsen (1) oder nicht (0).
 * Eine oder zwei Kacheln (z. B. Steuerbüro nur „Berichte“) werden nicht über die halbe/ganze Seite gezogen,
 * sondern bleiben so breit wie bei vier je Reihe.
 */
export function tileVars(n: number): Record<`--${string}`, string> {
  const few = n <= 2;
  const v: Record<`--${string}`, string> = { "--tg": few ? "0" : "1" };
  for (const bp of Object.keys(TILE_MAX) as TileBreakpoint[]) {
    const max = TILE_MAX[bp];
    v[`--tc-${bp}`] = String(few ? Math.min(max, 4) : tilesPerRow(n, max));
  }
  return v;
}
