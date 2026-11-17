/**
 * Lage der großen Fotovorschau neben einem kleinen Artikelfoto (Wunsch Inhaber 17.11.2026: „Maus auf das Foto → groß,
 * damit der Kunde neben mir es sieht“) – rein, getestet in tests/zoom-place.test.ts.
 * Seite mit mehr Platz (rechts oder links vom Bild), senkrecht mittig zum Bild, nie über den Bildschirmrand.
 */
export type Rect = { left: number; top: number; right: number; bottom: number };
export type Size = { width: number; height: number };

export function zoomPlacement(anchor: Rect, view: Size, box: Size, gap = 12, margin = 8): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  const roomEnd = view.width - anchor.right - gap - margin;
  const roomStart = anchor.left - gap - margin;
  let left: number;
  if (roomEnd >= box.width && roomEnd >= roomStart) left = anchor.right + gap;
  else if (roomStart >= box.width) left = anchor.left - gap - box.width;
  else if (roomEnd >= box.width) left = anchor.right + gap;
  // passt auf keiner Seite ganz: zur größeren Seite hin, aber im Bild
  else left = roomEnd >= roomStart ? view.width - margin - box.width : margin;
  left = clamp(left, margin, view.width - margin - box.width);
  const top = clamp((anchor.top + anchor.bottom) / 2 - box.height / 2, margin, view.height - margin - box.height);
  return { left: Math.round(left), top: Math.round(top) };
}

/** Größe der Vorschau: höchstens 26rem, 42 % der Breite und so hoch, dass Foto + Text auf den Bildschirm passen */
export function zoomSize(view: Size, rem: number, captionPx: number): number {
  return Math.round(Math.max(10 * rem, Math.min(26 * rem, view.width * 0.42, view.height - captionPx - 4 * rem)));
}
