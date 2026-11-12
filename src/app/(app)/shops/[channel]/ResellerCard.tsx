"use client";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { pushResellerPricesAction } from "../actions";

export type ResellerInfo =
  | { ok: true; market: string; catalog: string; taxesIncluded: boolean; allLocations: boolean }
  | { ok: false; problem: string; detail?: string };

/** Shop-Seite: B2B-Markt mit Preisliste für die Großhandelspreise (جملة الجملة) – Stand, Kunden, „Preise senden“ */
export function ResellerCard({ t, channel, info, counts }: { t: Dict; channel: string; info: ResellerInfo | null; counts: { linked: number; pending: number; failed: number } }) {
  const R = t.shop.reseller;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const problemText = (p: string) => (R as Record<string, unknown>)[p] as string | undefined ?? R.error;
  const send = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await pushResellerPricesAction(channel);
      if (r.error) setMsg({ ok: false, text: problemText(r.error) + (r.detail ? ` (${r.detail})` : "") });
      else {
        const [u, d, s, f] = (r.ok ?? "0|0|0|0").split("|");
        setMsg({ ok: f === "0", text: R.sent.replace("{u}", u).replace("{d}", d).replace("{s}", s) + (f !== "0" ? ` · ${R.sentFailed.replace("{f}", f)}` : "") });
      }
    } catch { setMsg({ ok: false, text: R.error }); }
    finally { setBusy(false); }
  };
  return (
    <section className="card animate-rise p-5">
      <h2 className="mb-3 flex items-center gap-2 font-bold"><Icon name="users" className="icon-pop h-5 w-5 text-brand-600" />{R.title}</h2>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-2 text-sm">
          {info == null ? null : info.ok ? (
            <p className="flex items-start gap-2 rounded-xl bg-emerald-50 p-3 font-semibold text-emerald-900 ring-1 ring-emerald-200">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{R.ok.replace("{market}", info.market || "B2B").replace("{catalog}", info.catalog).replace("{tax}", info.taxesIncluded ? R.taxIn : R.taxOut)}</span>
            </p>
          ) : (
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-200">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{problemText(info.problem)}{info.detail && <span className="mt-1 block text-xs opacity-80" dir="ltr">{info.detail}</span>}</span>
            </p>
          )}
          {info?.ok && !info.allLocations && <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">{R.notAll}</p>}
          <p className="flex flex-wrap gap-2">
            <span className="badge bg-brand-50 text-brand-800">{R.customers.replace("{n}", String(counts.linked))}</span>
            {counts.pending > 0 && <span className="badge bg-amber-100 text-amber-900">{R.waiting.replace("{n}", String(counts.pending))}</span>}
            {counts.failed > 0 && <span className="badge bg-red-100 text-red-800">{R.problems.replace("{n}", String(counts.failed))}</span>}
          </p>
          <div>
            <button type="button" disabled={busy || !info?.ok} onClick={send} className="btn-ghost group w-full justify-start">
              {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" /> : <Icon name="upload" className="icon-pop h-4 w-4" />}{R.send}
            </button>
            <p className="mt-1 px-1 text-xs leading-relaxed text-ink-soft">{R.sendHint}</p>
          </div>
          {msg && <p className={`animate-rise rounded-xl px-3 py-2 text-sm font-semibold ${msg.ok ? "bg-brand-50 text-brand-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}
        </div>
        <div>
          <h3 className="mb-2 text-sm font-bold text-ink-soft">{R.howTitle}</h3>
          <ol className="space-y-2 text-sm">
            {R.how.map((g, i) => (
              <li key={i} className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-100 text-xs font-bold text-brand-800">{i + 1}</span><span className="leading-relaxed">{g}</span></li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
