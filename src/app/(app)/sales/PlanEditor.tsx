"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { formatCents, parseMoney } from "@/lib/money";
import { addDaysIso, formatDate } from "@/lib/dates";
import { splitInstallments } from "@/lib/payment-status";
import type { Dict } from "@/i18n/de";

export type PlanRow = { key: string; dueDate: string; amount: string };
export const toPlanRows = (p: { dueDate: string; amountCents: number }[]): PlanRow[] =>
  p.map((r) => ({ key: crypto.randomUUID(), dueDate: r.dueDate, amount: (r.amountCents / 100).toFixed(2).replace(".", ",") }));
export const fromPlanRows = (rows: PlanRow[]) => rows.map((r) => ({ dueDate: r.dueDate, amountCents: parseMoney(r.amount) ?? -1 }));

/** Prüft den Plan wie der Server: Beträge > 0, Datum gesetzt, Reihenfolge, Summe = Brutto. Ergebnis = Fehlerschlüssel aus t.pay */
export function planProblem(rows: PlanRow[], grossCents: number): "planInvalid" | "planOrder" | "planSum" | null {
  if (!rows.length) return null;
  const p = fromPlanRows(rows);
  if (p.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) || r.amountCents <= 0)) return "planInvalid";
  for (let i = 1; i < p.length; i++) if (p[i].dueDate < p[i - 1].dueDate) return "planOrder";
  return p.reduce((s, r) => s + r.amountCents, 0) === grossCents ? null : "planSum";
}

/**
 * Ratenplan: oben „Plan erstellen“ (erste Rate + Anzahl + Abstand, mit Vorschau in Worten), darunter jede Rate änderbar.
 * Passt auch in die schmale Seitenleiste der Rechnung (keine Zeile breiter als die Karte).
 */
export function PlanEditor({ t, grossCents, rows, setRows, today, intl }: {
  t: Dict; grossCents: number; rows: PlanRow[]; setRows: (r: PlanRow[]) => void; today: string; intl: string;
}) {
  const P = t.pay;
  const [first, setFirst] = useState("");
  const [count, setCount] = useState("3");
  const [every, setEvery] = useState("30");
  const plan = fromPlanRows(rows);
  const sum = plan.reduce((s, r) => s + Math.max(r.amountCents, 0), 0);
  const diff = grossCents - sum;

  const firstCents = first.trim() ? parseMoney(first) : 0;
  const n = parseInt(count, 10), days = parseInt(every, 10);
  const genError = firstCents == null || firstCents < 0 ? P.firstInvalid
    : firstCents > grossCents ? P.firstTooBig
    : !(n >= 1 && n <= 36) ? P.countInvalid
    : !(days >= 1 && days <= 365) ? P.everyInvalid : null;
  const preview = !genError && grossCents > 0 ? splitInstallments(grossCents, firstCents ?? 0, n, today, days, addDaysIso) : [];

  const generate = () => { if (preview.length) setRows(toPlanRows(preview)); };
  const update = (key: string, patch: Partial<PlanRow>) => setRows(rows.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl bg-slate-50 p-3 ring-1 ring-black/[0.04]">
        <div className="grid grid-cols-3 gap-2">
          <label className="flex min-w-0 flex-col justify-end"><span className="label text-xs leading-tight">{P.firstAmount}</span>
            <input value={first} onChange={(e) => setFirst(e.target.value)} inputMode="decimal" dir="ltr" placeholder="0,00"
              className={`input num min-w-0 ${firstCents == null || (firstCents ?? 0) > grossCents ? "border-red-400 ring-1 ring-red-300" : ""}`} /></label>
          <label className="flex min-w-0 flex-col justify-end"><span className="label text-xs leading-tight">{P.count}</span>
            <input value={count} onChange={(e) => setCount(e.target.value)} type="number" min={1} max={36} inputMode="numeric" className="input num min-w-0" /></label>
          <label className="flex min-w-0 flex-col justify-end"><span className="label text-xs leading-tight">{P.every}</span>
            <input value={every} onChange={(e) => setEvery(e.target.value)} type="number" min={1} max={365} inputMode="numeric" className="input num min-w-0" /></label>
        </div>
        {genError
          ? <p className="text-xs font-semibold text-red-600">{genError}</p>
          : preview.length > 0 && <p className="text-xs text-ink-soft">{(preview.length === 1 ? P.previewOne : P.preview)
              .replace("{n}", String(preview.length))
              .replace("{first}", formatCents(preview[0].amountCents, intl))
              .replace("{from}", formatDate(preview[0].dueDate, intl))
              .replace("{to}", formatDate(preview[preview.length - 1].dueDate, intl))}</p>}
        <button type="button" onClick={generate} disabled={!preview.length} className="btn-ghost group w-full"><Icon name="clock" className="icon-pop h-4 w-4" />{P.generate}</button>
      </div>

      {rows.length > 0 && (
        <ol className="space-y-2">
          {rows.map((r, i) => {
            const bad = parseMoney(r.amount) == null || (parseMoney(r.amount) ?? 0) <= 0;
            return (
              <li key={r.key} className="animate-rise rounded-xl bg-white p-2.5 ring-1 ring-black/5">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-ink-soft">{P.rate} {i + 1}</span>
                  <button type="button" aria-label={t.common.remove} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                    className="grid h-7 w-7 place-items-center rounded-lg text-red-600 hover:bg-red-50"><Icon name="trash" className="h-4 w-4" /></button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input type="date" value={r.dueDate} onChange={(e) => update(r.key, { dueDate: e.target.value })} className="input min-w-0 px-2 text-sm" aria-label={P.due} />
                  <input value={r.amount} onChange={(e) => update(r.key, { amount: e.target.value })} inputMode="decimal" dir="ltr" aria-label={P.amount}
                    className={`input num min-w-0 text-sm ${bad ? "border-red-400 ring-1 ring-red-300" : ""}`} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs"
            onClick={() => setRows([...rows, { key: crypto.randomUUID(), dueDate: addDaysIso(rows.at(-1)?.dueDate ?? today, 30), amount: diff > 0 ? (diff / 100).toFixed(2).replace(".", ",") : "" }])}>
            <Icon name="plus" className="h-4 w-4" />{P.rate}
          </button>
          <span className={`text-xs font-semibold ${diff === 0 ? "text-emerald-700" : "text-red-600"}`}>
            {diff === 0 ? `✓ ${P.sumOk.replace("{sum}", formatCents(grossCents, intl))}` : `${P.difference}: ${formatCents(diff, intl)}`}
          </span>
        </div>
      )}
    </div>
  );
}
