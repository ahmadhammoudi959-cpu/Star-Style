"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import { formatCents, parseMoney } from "@/lib/money";
import { addDaysIso, formatDate } from "@/lib/dates";
import { planAfterPayment } from "@/lib/payment-status";
import type { Dict } from "@/i18n/de";

export type PlanRow = { key: string; dueDate: string; amount: string };
export const toPlanRows = (p: { dueDate: string; amountCents: number }[]): PlanRow[] =>
  p.map((r) => ({ key: crypto.randomUUID(), dueDate: r.dueDate, amount: (r.amountCents / 100).toFixed(2).replace(".", ",") }));
export const fromPlanRows = (rows: PlanRow[]) => rows.map((r) => ({ dueDate: r.dueDate, amountCents: parseMoney(r.amount) ?? -1 }));

/**
 * Was schon bezahlt ist (Rechnung) bzw. bei Ausstellung bezahlt wird (Anzahlung im Belegeditor). In Raten geteilt wird nur der Rest.
 * locked = Belegeditor: die Anzahlung steht fest über den Raten (folgt dem Betrag oben) und gehört nicht zu `rows`;
 * sonst wird sie beim Erstellen als normale erste Zeile in den Plan geschrieben.
 */
export type PlanPaid = { cents: number; date: string; label: string; locked?: boolean };

/**
 * Prüft den Plan wie der Server: Beträge > 0, Datum gesetzt, Reihenfolge, Summe = Brutto. Ergebnis = Fehlerschlüssel aus t.pay.
 * paidRow = feste Anzahlung vor den Raten (Belegeditor), zählt mit.
 */
export function planProblem(rows: PlanRow[], grossCents: number, paidRow?: { dueDate: string; amountCents: number } | null): "planInvalid" | "planOrder" | "planSum" | null {
  if (!rows.length) return null;
  const p = [...(paidRow ? [paidRow] : []), ...fromPlanRows(rows)];
  if (p.some((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.dueDate) || r.amountCents <= 0)) return "planInvalid";
  for (let i = 1; i < p.length; i++) if (p[i].dueDate < p[i - 1].dueDate) return "planOrder";
  return p.reduce((s, r) => s + r.amountCents, 0) === grossCents ? null : "planSum";
}

/**
 * Ratenplan: oben „Plan erstellen“ (erste Rate + Anzahl + Abstand, mit Vorschau in Worten), darunter jede Rate änderbar.
 * Ist schon etwas bezahlt bzw. wird bei Ausstellung angezahlt, wird nur der Rest in Raten geteilt (Wunsch Inhaber 12.11.2026).
 * Passt auch in die schmale Seitenleiste der Rechnung (keine Zeile breiter als die Karte).
 */
export function PlanEditor({ t, grossCents, rows, setRows, today, intl, paid }: {
  t: Dict; grossCents: number; rows: PlanRow[]; setRows: (r: PlanRow[]) => void; today: string; intl: string; paid?: PlanPaid | null;
}) {
  const P = t.pay;
  const [first, setFirst] = useState("");
  const [count, setCount] = useState("3");
  const [every, setEvery] = useState("30");
  const paidCents = Math.min(Math.max(paid?.cents ?? 0, 0), Math.max(grossCents, 0));
  const locked = Boolean(paid?.locked) && paidCents > 0;
  const restCents = grossCents - paidCents;
  const target = locked ? restCents : grossCents; // darauf müssen die Zeilen hier kommen
  const plan = fromPlanRows(rows);
  const sum = plan.reduce((s, r) => s + Math.max(r.amountCents, 0), 0);
  const diff = target - sum;

  const firstCents = first.trim() ? parseMoney(first) : 0;
  const n = parseInt(count, 10), days = parseInt(every, 10);
  const genError = grossCents > 0 && restCents <= 0 ? P.nothingToSplit
    : firstCents == null || firstCents < 0 ? P.firstInvalid
    : firstCents > restCents ? P.firstTooBig
    : !(n >= 1 && n <= 36) ? P.countInvalid
    : !(days >= 1 && days <= 365) ? P.everyInvalid : null;
  const full = !genError && grossCents > 0 ? planAfterPayment(grossCents, paidCents, paid?.date ?? today, firstCents ?? 0, n, today, days, addDaysIso) : [];
  const rates = paidCents > 0 ? full.slice(1) : full; // nur die neuen Raten (für die Vorschau)

  const generate = () => { if (rates.length) setRows(toPlanRows(locked ? rates : full)); };
  const update = (key: string, patch: Partial<PlanRow>) => setRows(rows.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  // Zahlungen der Reihe nach auf die Raten (wie im Zahlungsstand) → „bezahlt“ an den Zeilen der Rechnung
  let pool = locked ? 0 : paidCents;
  const covered = plan.map((r) => { const c = Math.min(pool, Math.max(r.amountCents, 0)); pool -= c; return c; });

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl bg-slate-50 p-3 ring-1 ring-black/[0.04]">
        <div className="grid grid-cols-3 gap-2">
          <label className="flex min-w-0 flex-col justify-end"><span className="label text-xs leading-tight">{P.firstAmount}</span>
            <input value={first} onChange={(e) => setFirst(e.target.value)} inputMode="decimal" dir="ltr" placeholder="0,00"
              className={`input num min-w-0 ${firstCents == null || (firstCents ?? 0) > Math.max(restCents, 0) ? "border-red-400 ring-1 ring-red-300" : ""}`} /></label>
          <label className="flex min-w-0 flex-col justify-end"><span className="label text-xs leading-tight">{P.count}</span>
            <input value={count} onChange={(e) => setCount(e.target.value)} type="number" min={1} max={36} inputMode="numeric" className="input num min-w-0" /></label>
          <label className="flex min-w-0 flex-col justify-end"><span className="label text-xs leading-tight">{P.every}</span>
            <input value={every} onChange={(e) => setEvery(e.target.value)} type="number" min={1} max={365} inputMode="numeric" className="input num min-w-0" /></label>
        </div>
        {paidCents > 0 && restCents > 0 && (
          <p className="text-xs font-semibold text-sky-900">{P.restInfo
            .replace("{rest}", formatCents(restCents, intl)).replace("{gross}", formatCents(grossCents, intl)).replace("{paid}", formatCents(paidCents, intl))}</p>
        )}
        {genError
          ? <p className="text-xs font-semibold text-red-600">{genError}</p>
          : rates.length > 0 && <p className="text-xs text-ink-soft">{(rates.length === 1 ? P.previewOne : P.preview)
              .replace("{n}", String(rates.length))
              .replace("{first}", formatCents(rates[0].amountCents, intl))
              .replace("{from}", formatDate(rates[0].dueDate, intl))
              .replace("{to}", formatDate(rates[rates.length - 1].dueDate, intl))}</p>}
        <button type="button" onClick={generate} disabled={!rates.length} className="btn-ghost group w-full"><Icon name="clock" className="icon-pop h-4 w-4" />{P.generate}</button>
      </div>

      {rows.length > 0 && (
        <ol className="space-y-2">
          {locked && (
            // Anzahlung bei Ausstellung: fest, folgt dem Betrag oben
            <li className="rounded-xl bg-sky-50 p-2.5 ring-1 ring-sky-200">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 text-xs font-bold text-sky-900">{paid?.label}</span>
                <span className="num shrink-0 text-sm font-bold text-sky-900">{formatCents(paidCents, intl)}</span>
              </div>
              <div className="mt-0.5 text-xs text-sky-800">{formatDate(paid?.date ?? today, intl)}</div>
            </li>
          )}
          {rows.map((r, i) => {
            const bad = parseMoney(r.amount) == null || (parseMoney(r.amount) ?? 0) <= 0;
            const c = covered[i] ?? 0, amt = plan[i]?.amountCents ?? 0;
            return (
              <li key={r.key} className="animate-rise rounded-xl bg-white p-2.5 ring-1 ring-black/5">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-xs font-bold text-ink-soft">{P.rate} {i + 1}
                    {c > 0 && <span className={`badge px-2 py-0.5 text-[0.7rem] ${c >= amt ? "bg-emerald-100 text-emerald-800" : "bg-sky-100 text-sky-800"}`}>{c >= amt ? `✓ ${P.ratePaid}` : P.ratePartly}</span>}
                  </span>
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
            {diff === 0 ? `✓ ${(locked ? P.sumOkRest : P.sumOk).replace("{sum}", formatCents(target, intl))}` : `${locked ? P.differenceRest : P.difference}: ${formatCents(diff, intl)}`}
          </span>
        </div>
      )}
    </div>
  );
}
