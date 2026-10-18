"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatCents } from "@/lib/money";

type M = { month: string; revenueNet: number; grossProfit: number; expenses: number; losses: number; profit: number };

const C = { revenue: "#2a78d6", profit: "#eb6834" }; // geprüft: Farbsehschwäche-sicher (ΔE ≥ 24)

/** Jahresübersicht: Umsatz und Ergebnis je Monat, eine Achse, Hover-Tooltip, Klick öffnet den Monat. */
export function YearChart({ data, months, labels, intl, active }: {
  data: M[]; months: readonly string[]; active: string; intl: string;
  labels: { revenue: string; profit: string; grossProfit: string; expenses: string; losses: string };
}) {
  const router = useRouter();
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 240, P = { l: 56, r: 8, t: 12, b: 28 };
  const vals = data.flatMap((d) => [d.revenueNet, d.profit]);
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const y = (v: number) => P.t + ((max - v) / (max - min)) * (H - P.t - P.b);
  const bw = (W - P.l - P.r) / 12;
  const barW = Math.min(16, bw / 3);
  const ticks = [0, 0.5, 1].map((f) => min + (max - min) * f);
  const short = (c: number) => (Math.abs(c) >= 100000 ? `${Math.round(c / 10000) / 10}k` : `${Math.round(c / 100)}`).replace(".", ",");
  const h = hover != null ? data[hover] : null;

  return (
    <div className="relative">
      <div className="mb-2 flex gap-4 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: C.revenue }} />{labels.revenue}</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: C.profit }} />{labels.profit}</span>
      </div>
      <div dir="ltr"><svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)} role="img" aria-label={`${labels.revenue} / ${labels.profit}`}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#e5e7eb" strokeWidth={1} />
            <text x={P.l - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill="#6b7280">{short(v)}</text>
          </g>
        ))}
        <line x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} stroke="#9ca3af" strokeWidth={1} />
        {data.map((d, i) => {
          const x = P.l + i * bw + bw / 2;
          const bar = (v: number, dx: number, color: string) => {
            const top = Math.min(y(v), y(0)), hgt = Math.max(Math.abs(y(v) - y(0)), v ? 1.5 : 0);
            return <rect x={x + dx} y={top} width={barW} height={hgt} rx={3} fill={color} opacity={hover == null || hover === i ? 1 : 0.35} />;
          };
          return (
            <g key={d.month} className="cursor-pointer" onMouseEnter={() => setHover(i)} onClick={() => router.push(`/reports?month=${d.month}`)}>
              <rect x={P.l + i * bw} y={P.t} width={bw} height={H - P.t - P.b} fill={d.month === active ? "#eef7f4" : "transparent"} />
              {bar(d.revenueNet, -barW - 1, C.revenue)}
              {bar(d.profit, 1, C.profit)}
              <text x={x} y={H - 10} textAnchor="middle" fontSize={10} fontWeight={d.month === active ? 700 : 400} fill="#374151">{String(i + 1).padStart(2, "0")}</text>
            </g>
          );
        })}
      </svg></div>
      {h && (
        <div className="pointer-events-none absolute top-6 z-10 min-w-48 rounded-xl bg-white p-3 text-xs shadow-lift ring-1 ring-black/10"
          style={{ left: `${Math.min(70, Math.max(0, ((hover! + 0.5) / 12) * 100 - 10))}%` }}>
          <div className="mb-1 font-bold">{months[Number(h.month.slice(5)) - 1]} {h.month.slice(0, 4)}</div>
          {([[labels.revenue, h.revenueNet], [labels.grossProfit, h.grossProfit], [labels.expenses, -h.expenses], [labels.losses, -h.losses], [labels.profit, h.profit]] as const).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4"><span className="text-ink-soft">{k}</span><span className="num font-semibold">{formatCents(v, intl)}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}
