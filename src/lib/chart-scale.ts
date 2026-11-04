/**
 * Achse für Diagramme: runde Werte, die 0 immer enthalten (0 / 250 / 500 … €) – rein und getestet.
 * Werte in Cent, Schritte in ganzen Euro (1, 2, 5, 10, 20, 25, 50 …).
 */
export function niceScale(min: number, max: number, target = 4): { lo: number; hi: number; step: number; ticks: number[] } {
  const lo0 = Math.min(0, min), hi0 = Math.max(0, max);
  const raw = Math.max((hi0 - lo0) / 100, 1) / target; // Euro je Schritt, ungefähr
  const mag = 10 ** Math.floor(Math.log10(raw));
  const stepEuro = Math.max(1, [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw - 1e-9 && (Number.isInteger(s) || s < 1)) ?? 10 * mag);
  const step = Math.round(stepEuro * 100);
  // kleiner Verlust (weniger als ein halber Schritt): nur so viel Platz unter der 0, wie die Säule braucht – sonst runder Schritt
  const lo = lo0 < 0 && -lo0 < step / 2 ? Math.round(lo0 * 1.25) : Math.floor(lo0 / step) * step;
  const hi = Math.max(Math.ceil(hi0 / step) * step, lo0 < 0 ? 0 : step);
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v === 0 ? 0 : v);
  return { lo, hi, step, ticks };
}

/** Säule mit runder Spitze (4 px) und gerader Kante an der Nulllinie; nach unten bei negativen Werten */
export function barPath(x: number, w: number, base: number, end: number, r = 4): string {
  const h = Math.abs(end - base);
  if (h <= 0 || w <= 0) return "";
  const k = Math.min(r, w / 2, h);
  const s = end < base ? 1 : -1; // nach oben: Rundung unter der Spitze
  return `M${x},${base}V${end + s * k}Q${x},${end} ${x + k},${end}H${x + w - k}Q${x + w},${end} ${x + w},${end + s * k}V${base}Z`;
}
