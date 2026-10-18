"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { formatCents, parseMoney } from "@/lib/money";
import { addDaysIso } from "@/lib/dates";
import { splitInstallments } from "@/lib/payment-status";
import type { Dict } from "@/i18n/de";

export type PlanRow = { key: string; dueDate: string; amount: string };
export const toPlanRows = (p: { dueDate: string; amountCents: number }[]): PlanRow[] =>
  p.map((r) => ({ key: crypto.randomUUID(), dueDate: r.dueDate, amount: (r.amountCents / 100).toFixed(2).replace(".", ",") }));
export const fromPlanRows = (rows: PlanRow[]) => rows.map((r) => ({ dueDate: r.dueDate, amountCents: parseMoney(r.amount) ?? -1 }));

/** Ratenplan: Generator (Anzahlung + Anzahl + Abstand) und frei bearbeitbare Zeilen. */
export function PlanEditor({ t, grossCents, rows, setRows, today, intl }: {
  t: Dict; grossCents: number; rows: PlanRow[]; setRows: (r: PlanRow[]) => void; today: string; intl: string;
}) {
  const [first, setFirst] = useState("");
  const [count, setCount] = useState("3");
  const [every, setEvery] = useState("30");
  const plan = fromPlanRows(rows);
  const sum = plan.reduce((s, r) => s + Math.max(r.amountCents, 0), 0);
  const diff = grossCents - sum;

  const generate = () => {
    const f = parseMoney(first) ?? 0;
    const gen = splitInstallments(grossCents, Math.min(f, grossCents), Math.max(parseInt(count) || 1, 1), today, Math.max(parseInt(every) || 30, 1), addDaysIso);
    setRows(toPlanRows(gen));
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="block"><span className="label text-xs">{t.pay.firstAmount}</span>
          <input value={first} onChange={(e) => setFirst(e.target.value)} inputMode="decimal" dir="ltr" className="input num" placeholder="0,00" /></label>
        <label className="block"><span className="label text-xs">{t.pay.count}</span>
          <input value={count} onChange={(e) => setCount(e.target.value)} type="number" min={1} max={36} className="input num" /></label>
        <label className="block"><span className="label text-xs">{t.pay.every}</span>
          <input value={every} onChange={(e) => setEvery(e.target.value)} type="number" min={1} className="input num" /></label>
        <div className="flex items-end"><button type="button" onClick={generate} disabled={grossCents <= 0} className="btn-ghost group w-full"><Icon name="clock" className="h-4 w-4" />{t.pay.generate}</button></div>
      </div>
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.key} className="flex animate-rise items-center gap-2">
              <span className="w-8 text-center text-xs font-bold text-ink-soft">{i + 1}</span>
              <input type="date" value={r.dueDate} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, dueDate: e.target.value } : x)))} className="input" aria-label={t.pay.due} />
              <input value={r.amount} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: e.target.value } : x)))} inputMode="decimal" dir="ltr"
                className={`input num w-36 ${parseMoney(r.amount) == null ? "border-red-400" : ""}`} aria-label={t.pay.amount} />
              <button type="button" aria-label={t.common.remove} onClick={() => setRows(rows.filter((x) => x.key !== r.key))} className="btn-danger group h-10 w-10 shrink-0 p-0"><Icon name="trash" className="h-4 w-4" /></button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setRows([...rows, { key: crypto.randomUUID(), dueDate: addDaysIso(rows.at(-1)?.dueDate ?? today, 30), amount: diff > 0 ? (diff / 100).toFixed(2).replace(".", ",") : "" }])}>
              <Icon name="plus" className="h-4 w-4" />{t.pay.rate}
            </button>
            <span className={`text-xs font-semibold ${diff === 0 ? "text-brand-700" : "text-red-600"}`}>
              {diff === 0 ? "✓" : `${t.pay.difference}: ${formatCents(diff, intl)}`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
