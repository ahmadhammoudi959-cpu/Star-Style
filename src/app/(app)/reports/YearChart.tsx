"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatCents } from "@/lib/money";
import { barPath, niceScale } from "@/lib/chart-scale";

type M = { month: string; revenueNet: number; grossProfit: number; expenses: number; losses: number; profit: number };
export type YearChartLabels = {
  revenue: string; profit: string; grossProfit: string; expenses: string; losses: string;
  openMonth: string; loss: string; lossNote: string; hint: string; empty: string;
};

// Farbpalette Slot 1 + 2 (geprüft: auch bei Farbsehschwäche gut zu unterscheiden); Text bleibt immer in Textfarbe
const C = { revenue: "#2a78d6", profit: "#eb6834", grid: "#e8eaee", zero: "#9aa1ac", axis: "#6b7280", band: "#eef4fd", hoverBand: "#f5f8fd" };
const PLOT_H = 220, TOP = 10, BOTTOM = 6, R = 8;

/**
 * Jahresübersicht: je Monat Umsatz (netto) und Ergebnis als Säulen auf EINER Achse (0 immer sichtbar, Verlust nach unten).
 * Oben stehen immer die Zahlen des gewählten Monats (Antippen/Zeigen wählt einen Monat) – nichts nur per Hover.
 */
export function YearChart({ data, months, labels, intl, active, today }: {
  data: M[]; months: readonly string[]; active: string; intl: string; today: string; labels: YearChartLabels;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lastWithData = data.reduce((acc, d, i) => (d.revenueNet || d.profit || d.expenses || d.losses ? i : acc), -1);
  const activeIdx = data.findIndex((d) => d.month === active);
  const [focus, setFocus] = useState(activeIdx >= 0 ? activeIdx : Math.max(0, lastWithData));
  const [hover, setHover] = useState<number | null>(null);

  if (lastWithData < 0) return <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-ink-soft">{labels.empty}</p>;

  const cur = data[hover ?? focus];
  const euro = new Intl.NumberFormat(intl, { style: "currency", currency: "EUR", maximumFractionDigits: 0, minimumFractionDigits: 0 });
  const vals = data.flatMap((d) => [d.revenueNet, d.profit]);
  const { lo, hi, ticks } = niceScale(Math.min(...vals), Math.max(...vals));
  const L = Math.ceil(Math.max(...ticks.map((v) => euro.format(v / 100).length)) * 6.4) + 12;
  const plotW = Math.max(0, w - L - R);
  const band = plotW / 12;
  const barW = Math.max(3, Math.min(24, (band * 0.7 - 2) / 2));
  const y = (v: number) => TOP + ((hi - v) / (hi - lo)) * PLOT_H;
  const H = TOP + PLOT_H + BOTTOM;
  const anyLoss = data.some((d) => d.profit < 0);
  const narrow = band < 46;
  const monthName = (i: number) => months[i];
  const shortName = (i: number) => (narrow ? String(i + 1) : /^[A-Za-zÄÖÜäöü]/.test(months[i]) ? months[i].slice(0, 3) : months[i]);
  const future = (m: string) => m > today;

  const bar = (x: number, v: number, color: string) => {
    if (!v) return null;
    const base = y(0);
    let end = y(v);
    if (Math.abs(end - base) < 2) end = base + (v > 0 ? -2 : 2); // kleine Beträge trotzdem sichtbar
    return <path d={barPath(x, barW, base, end)} fill={color} />;
  };

  return (
    <div>
      {/* Zahlen des gewählten Monats – zugleich Legende */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 rounded-xl bg-slate-50 p-3 ring-1 ring-black/[0.04]" aria-live="polite">
        <div className="min-w-0">
          <div className="font-bold">{monthName(Number(cur.month.slice(5)) - 1)} {cur.month.slice(0, 4)}</div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: C.revenue }} />
              <span className="text-sm text-ink-soft">{labels.revenue}</span>
              <b className="num text-base">{formatCents(cur.revenueNet, intl)}</b>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: C.profit }} />
              <span className="text-sm text-ink-soft">{labels.profit}</span>
              <b className={`num text-base ${cur.profit < 0 ? "text-red-600" : ""}`}>{formatCents(cur.profit, intl)}</b>
              {cur.profit < 0 && <span className="badge bg-red-50 text-red-700 ring-1 ring-red-100">{labels.loss}</span>}
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-soft">
            <span>{labels.grossProfit}: <span className="num font-semibold text-ink">{formatCents(cur.grossProfit, intl)}</span></span>
            <span>{labels.expenses}: <span className="num font-semibold text-ink">{formatCents(cur.expenses, intl)}</span></span>
            <span>{labels.losses}: <span className="num font-semibold text-ink">{formatCents(cur.losses, intl)}</span></span>
          </div>
        </div>
        {cur.month !== active && (
          <Link href={`/reports?month=${cur.month}`} className="btn-ghost group shrink-0 px-3 py-1.5 text-xs">
            {labels.openMonth}<span aria-hidden className="rtl:rotate-180">→</span>
          </Link>
        )}
      </div>

      <div ref={box} dir="ltr" className="relative w-full" style={{ height: H }}>
        {w > 0 && (
          <svg width={w} height={H} className="block overflow-visible" role="group" aria-label={`${labels.revenue} / ${labels.profit}`} onMouseLeave={() => setHover(null)}>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={L} x2={w - R} y1={y(v)} y2={y(v)} stroke={v === 0 ? C.zero : C.grid} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={11} fontWeight={v === 0 ? 700 : 400} fill={C.axis} className="tabular-nums">{euro.format(v / 100)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const x0 = L + i * band;
              const cx = x0 + band / 2;
              const isFocus = i === focus, isHover = i === hover && !isFocus;
              return (
                <g key={d.month} role="button" tabIndex={0} className="cursor-pointer outline-none"
                  aria-label={`${monthName(i)}: ${labels.revenue} ${formatCents(d.revenueNet, intl)}, ${labels.profit} ${formatCents(d.profit, intl)}`}
                  aria-pressed={isFocus}
                  onMouseEnter={() => setHover(i)} onFocus={() => setFocus(i)} onClick={() => setFocus(i)}
                  onKeyDown={(e) => { if (e.key === "ArrowRight") setFocus(Math.min(11, focus + 1)); if (e.key === "ArrowLeft") setFocus(Math.max(0, focus - 1)); }}>
                  <rect x={x0 + 1} y={TOP - 6} width={Math.max(0, band - 2)} height={PLOT_H + 12} rx={8}
                    fill={isFocus ? C.band : isHover ? C.hoverBand : "transparent"} />
                  {bar(cx - barW - 1, d.revenueNet, C.revenue)}
                  {bar(cx + 1, d.profit, C.profit)}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {/* Monate als Text darunter (kann umbrechen, z. B. „تشرين التاني“) */}
      <div dir="ltr" className="grid" style={{ marginLeft: L, marginRight: R, gridTemplateColumns: "repeat(12, minmax(0, 1fr))" }}>
        {data.map((d, i) => (
          <button key={d.month} type="button" onClick={() => setFocus(i)}
            className={`px-0.5 pt-1 text-center text-[11px] leading-tight ${i === focus ? "font-bold text-ink" : future(d.month) ? "text-ink-soft/50" : "text-ink-soft"}`}>
            {shortName(i)}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
        <span>{labels.hint}</span>
        {anyLoss && <span>{labels.lossNote}</span>}
      </div>
    </div>
  );
}
