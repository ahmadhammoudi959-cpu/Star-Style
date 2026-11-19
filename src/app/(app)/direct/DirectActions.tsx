"use client";
import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { convertDirectAction, rejectDirectAction, reopenDirectAction } from "./actions";

type D = Dict["direct"];
type Opt = { id: string; number: number; name: string; city: string; priceGroup: "WHOLESALE" | "RETAIL" };
const errText = (t: D, code?: string) => (code && code in t.errors ? t.errors[code as keyof D["errors"]] : t.errors.error);

/**
 * Liste → Kunde wählen (oder ganz normal neu anlegen) → Angebot oder Rechnungsentwurf. Das System legt keinen Kunden
 * selbst an (Wunsch Inhaber 19.11.2026: „بيختار هو بقى الزبون شو اسمه … طلع له عرض سعر، طلع له فاتوره“).
 */
export function DirectActions({ t, id, customers, preselect, suggestionId, rights, newCustomerHref, groupNames, priceGroupLabel }: {
  t: D; id: string; customers: Opt[]; preselect: string; suggestionId: string | null; rights: { offer: boolean; invoice: boolean };
  newCustomerHref: string | null; groupNames: Record<"WHOLESALE" | "RETAIL", string>; priceGroupLabel: string;
}) {
  const [cid, setCid] = useState(preselect);
  const [cq, setCq] = useState("");
  const [busy, setBusy] = useState<null | "offer" | "invoice" | "reject">(null);
  const [err, setErr] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const needle = cq.trim().toLowerCase();
  const list = needle ? customers.filter((c) => c.id === cid || `${c.name} ${c.city} ${c.number}`.toLowerCase().includes(needle)) : customers;
  const chosen = customers.find((c) => c.id === cid);

  const make = async (kind: "offer" | "invoice") => {
    if (!cid) { setErr(t.errors.customer); return; }
    setBusy(kind); setErr(null);
    try {
      const r = await convertDirectAction(id, cid, kind);
      if (r.ok && r.id) { window.location.assign(kind === "offer" ? `/sales/offers/${r.id}` : `/sales/invoices/${r.id}`); return; }
      setErr(errText(t, r.error));
    } catch { setErr(t.errors.error); }
    setBusy(null);
  };
  const reject = async () => {
    setBusy("reject"); setErr(null);
    try {
      const r = await rejectDirectAction(id, reason);
      if (r.ok) { window.location.reload(); return; }
      setErr(errText(t, r.error));
    } catch { setErr(t.errors.error); }
    setBusy(null);
  };

  return (
    <section className="card space-y-4 p-4 lg:sticky lg:top-4" data-direct-actions>
      <div>
        <h2 className="text-lg font-bold">{t.pickTitle}</h2>
        <p className="text-sm text-ink-soft">{t.pickHint}</p>
      </div>
      <div className="space-y-2">
        <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder={t.pick} className="input" autoComplete="off" aria-label={t.pick} />
        <select value={cid} onChange={(e) => setCid(e.target.value)} className="input font-semibold" aria-label={t.pickTitle} data-customer-select>
          <option value="">{t.pick}</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.city ? ` · ${c.city}` : ""} · {c.number}{c.id === suggestionId ? ` – ${t.sameEmail}` : ""}</option>
          ))}
        </select>
        {chosen && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            {priceGroupLabel}:
            <span className={`badge ${chosen.priceGroup === "WHOLESALE" ? "bg-violet-50 text-violet-700" : "bg-brand-50 text-brand-700"}`}>{groupNames[chosen.priceGroup]}</span>
            <Link href={`/customers/${chosen.id}`} className="font-semibold text-brand-700 hover:underline">{t.openDoc}</Link>
          </p>
        )}
        {newCustomerHref && (
          <Link href={newCustomerHref} className="btn-ghost group w-full"><Icon name="plus" className="icon-pop h-4 w-4" />{t.newCustomer}</Link>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn-ghost group" disabled={!rights.offer || !!busy} onClick={() => make("offer")} data-make="offer" title={rights.offer ? undefined : t.errors.noRight}>
          <Icon name="file" className="icon-pop h-4 w-4" />{t.makeOffer}
        </button>
        <button type="button" className="btn-primary group" disabled={!rights.invoice || !!busy} onClick={() => make("invoice")} data-make="invoice" title={rights.invoice ? undefined : t.errors.noRight}>
          <Icon name="receipt" className="icon-pop h-4 w-4" />{t.makeInvoice}
        </button>
      </div>
      <p className="text-xs text-ink-soft">{t.makeHint}</p>
      {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 ring-1 ring-red-200" role="alert">{err}</p>}
      <div className="border-t border-black/5 pt-3">
        {asking ? (
          <div className="space-y-2">
            <p className="text-sm font-semibold">{t.rejectConfirm}</p>
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={t.rejectReason} className="input" aria-label={t.rejectReason} />
            <div className="flex gap-2">
              <button type="button" className="btn-ghost flex-1" onClick={() => setAsking(false)} autoFocus>{t.back}</button>
              <button type="button" className="btn-danger flex-1" disabled={!!busy} onClick={reject}>{t.reject}</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAsking(true)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-red-700">
            <Icon name="x" className="h-4 w-4" />{t.reject}
          </button>
        )}
      </div>
    </section>
  );
}

export function ReopenButton({ t, id }: { t: D; id: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button type="button" className="btn-ghost group w-full" disabled={busy} onClick={async () => {
        setBusy(true); setErr(null);
        try { const r = await reopenDirectAction(id); if (r.ok) { window.location.reload(); return; } setErr(errText(t, r.error)); } catch { setErr(t.errors.error); }
        setBusy(false);
      }}><Icon name="undo" className="icon-pop h-4 w-4" />{t.reopen}</button>
      {err && <p className="text-sm font-semibold text-red-700" role="alert">{err}</p>}
    </div>
  );
}
