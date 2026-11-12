"use client";
import { useEffect, useRef, useState } from "react";
import { cancelShipmentAction, createShipmentAction, editShipmentAction, retryShipmentAction, type ShipState } from "../../ship-actions";
import { Icon } from "@/components/Icon";
import { CARRIERS, carrierLabel, checkNumbers, customUrlOk, type Carrier } from "@/lib/shipping";
import type { Dict } from "@/i18n/de";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? `{${k}}`));

/** Fehler unter dem Knopf, in der Sprache des Nutzers (Erfolg zeigt die Seite nach dem Neuladen oben in der Karte) */
function Msg({ t, state }: { t: Dict; state: ShipState }) {
  const S = t.ship;
  if (!state?.error) return null;
  const m = (S.errors as Record<string, string>)[state.error] ?? S.errors.error;
  return <p role="alert" className="text-xs font-semibold text-red-600">{fill(m, { x: state.detail ?? "" })}</p>;
}

/** Hinweis ?ship=… nach dem Anzeigen aus der Adresse nehmen (sonst stünde er nach jedem Neuladen wieder da) */
export function ClearShipNotice() {
  useEffect(() => {
    const u = new URL(window.location.href);
    if (!u.searchParams.has("ship")) return;
    u.searchParams.delete("ship");
    window.history.replaceState(window.history.state, "", u.pathname + (u.search ? u.search : "") + u.hash);
  }, []);
  return null;
}

/** Hinweis nach dem Speichern (Wert für ?ship=) aus dem Ergebnis der Action */
function noticeOf(r: ShipState, kind: "create" | "edit" | "cancel"): string {
  if (r?.shop === "failed") return "failed";
  if (r?.shop === "pending" || r?.shop === "update" || r?.shop === "cancel") return "pending";
  if (kind === "cancel") return "cancelled";
  if (kind === "edit") return r?.shop === "sent" && r.notify ? "updatedMail" : "updated";
  return r?.shop === "sent" ? (r.notify ? "sent" : "sentQuiet") : "saved";
}

/**
 * Action aufrufen (ohne Übergang/Transition) und danach die Seite neu laden – zuverlässig, siehe ship-actions.ts.
 * Rückgabe nur bei Fehler; bei Erfolg wird navigiert.
 */
async function run(action: (s: ShipState, fd: FormData) => Promise<ShipState>, fd: FormData, invoiceId: string, kind: "create" | "edit" | "cancel"): Promise<ShipState> {
  let r: ShipState;
  try { r = await action(undefined, fd); } catch { return { error: "error" }; }
  if (!r?.ok) return r ?? { error: "error" };
  window.location.assign(`/sales/invoices/${invoiceId}?ship=${noticeOf(r, kind)}#shipping`);
  return undefined;
}

type TrackingState = { carrier: Carrier; carrierName: string; url: string; numbers: string[] };

/**
 * Versanddienst + Nummer je Paket. Handscanner tippen die Nummer und drücken Enter → nächstes Paket statt Absenden.
 * Leere Felder zählen nicht; Fehler werden sofort gezeigt (gleiche Prüfung wie auf dem Server).
 */
function TrackingFields({ t, v, set, names, idp, tried }: { t: Dict; v: TrackingState; set: (v: TrackingState) => void; names: string[]; idp: string; tried: boolean }) {
  const S = t.ship;
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focus, setFocus] = useState<number | null>(null);
  useEffect(() => { if (focus != null) { refs.current[focus]?.focus(); setFocus(null); } }, [focus, v.numbers.length]);
  const check = checkNumbers(v.carrier, v.numbers);
  const shownProblem = check.problem && (tried || check.problem === "format" || check.problem === "duplicate" || check.problem === "tooMany") ? check.problem : null;
  const addRow = (after: number) => {
    const next = [...v.numbers];
    next.splice(after + 1, 0, "");
    set({ ...v, numbers: next });
    setFocus(after + 1);
  };
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1.5 text-xs font-bold text-ink-soft">{S.carrier}</div>
        <div role="radiogroup" aria-label={S.carrier} className="grid grid-cols-3 gap-1.5">
          {CARRIERS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={v.carrier === c} onClick={() => set({ ...v, carrier: c })}
              className={`min-w-0 truncate rounded-xl px-1.5 py-2 text-sm font-bold ring-1 transition ${v.carrier === c ? "bg-brand-600 text-white shadow-card ring-brand-600" : "bg-white text-ink ring-black/10 hover:bg-brand-50"}`}>
              {c === "OTHER" ? S.other : carrierLabel(c)}
            </button>
          ))}
        </div>
      </div>
      {v.carrier === "OTHER" && (
        <div className="space-y-2 rounded-xl bg-slate-50 p-2.5 ring-1 ring-black/5">
          <label className="block text-xs font-bold text-ink-soft" htmlFor={`${idp}-name`}>{S.carrierName}</label>
          <input id={`${idp}-name`} value={v.carrierName} onChange={(e) => set({ ...v, carrierName: e.target.value })} list={`${idp}-names`} maxLength={60}
            placeholder={S.carrierNamePh} className="input" autoComplete="off" />
          <datalist id={`${idp}-names`}>{names.map((n) => <option key={n} value={n} />)}</datalist>
          <label className="block text-xs font-bold text-ink-soft" htmlFor={`${idp}-url`}>{S.url}</label>
          <input id={`${idp}-url`} value={v.url} onChange={(e) => set({ ...v, url: e.target.value })} dir="ltr" inputMode="url" placeholder="https://…" className="input" autoComplete="off" />
          <p className="text-[0.6875rem] text-ink-soft">{S.urlHint}</p>
          {!customUrlOk(v.url) && <p className="text-xs font-semibold text-red-600">{S.errors.url}</p>}
        </div>
      )}
      <div className="space-y-1.5">
        {v.numbers.map((n, i) => (
          <div key={i}>
            <label className="mb-0.5 block text-xs font-bold text-ink-soft" htmlFor={`${idp}-n${i}`}>
              {v.carrier === "OTHER" && i === 0 ? S.numberOther : fill(S.number, { n: i + 1 })}
            </label>
            <div className="flex items-center gap-1.5">
              <input id={`${idp}-n${i}`} ref={(el) => { refs.current[i] = el; }} value={n} dir="ltr" autoComplete="off" spellCheck={false} autoCapitalize="characters" enterKeyHint="next"
                placeholder={i === 0 ? S.numberPh : ""} className="input num min-w-0 flex-1 tracking-wide"
                onChange={(e) => set({ ...v, numbers: v.numbers.map((x, k) => (k === i ? e.target.value : x)) })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (n.trim()) addRow(i); } }} />
              {v.numbers.length > 1 && (
                <button type="button" aria-label={S.removeParcel} title={S.removeParcel} onClick={() => set({ ...v, numbers: v.numbers.filter((_, k) => k !== i) })}
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-ink-soft ring-1 ring-black/5 hover:bg-red-50 hover:text-red-600">
                  <Icon name="x" className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        ))}
        {v.numbers.length < 20 && (
          <button type="button" onClick={() => addRow(v.numbers.length - 1)} className="btn-ghost group w-full justify-center py-1.5 text-sm">
            <Icon name="plus" className="h-4 w-4" />{S.addParcel}
          </button>
        )}
        {shownProblem && <p role="alert" className="text-xs font-semibold text-red-600">{fill((S.errors as Record<string, string>)[shownProblem], { x: check.bad ?? "" })}</p>}
      </div>
    </div>
  );
}

const blank = (): TrackingState => ({ carrier: "DHL", carrierName: "", url: "", numbers: [""] });
const okToSend = (v: TrackingState) => !checkNumbers(v.carrier, v.numbers).problem && customUrlOk(v.url) && (v.carrier !== "OTHER" || v.carrierName.trim().length > 0);

/** Neue Sendung: Versanddienst, Nummern, Inhalt (alles Offene oder Teil), E-Mail an den Kunden (nur Shop) */
export function NewShipment({ t, invoiceId, shop, open, names }: {
  t: Dict; invoiceId: string; shop: boolean; open: { lineId: string; description: string; qty: number }[]; names: string[];
}) {
  const S = t.ship;
  const [state, setState] = useState<ShipState>(undefined);
  const [pending, setPending] = useState(false);
  const [v, setV] = useState<TrackingState>(blank);
  const [mode, setMode] = useState<"all" | "part">("all");
  const [pick, setPick] = useState<Record<string, number>>(() => Object.fromEntries(open.map((o) => [o.lineId, o.qty])));
  const [notify, setNotify] = useState(true);
  const [tried, setTried] = useState(false);
  const totalOpen = open.reduce((s, o) => s + o.qty, 0);
  const choose = open.length > 1 || (open[0]?.qty ?? 0) > 1;
  const pickedNone = mode === "part" && !open.some((o) => (pick[o.lineId] ?? 0) > 0);
  return (
    <form className="space-y-4" onSubmit={async (e) => {
      e.preventDefault();
      setTried(true);
      if (pending || !okToSend(v) || pickedNone) return;
      setPending(true); setState(undefined);
      const err = await run(createShipmentAction, new FormData(e.currentTarget), invoiceId, "create");
      if (err) { setState(err); setPending(false); }
    }}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="carrier" value={v.carrier} />
      <input type="hidden" name="carrierName" value={v.carrier === "OTHER" ? v.carrierName : ""} />
      <input type="hidden" name="trackingUrl" value={v.carrier === "OTHER" ? v.url : ""} />
      <input type="hidden" name="numbers" value={JSON.stringify(v.numbers.filter((n) => n.trim()))} />
      <input type="hidden" name="notify" value={shop && notify ? "1" : ""} />
      {mode === "part" && <input type="hidden" name="pick" value={JSON.stringify(pick)} />}
      <TrackingFields t={t} v={v} set={setV} names={names} idp="new" tried={tried} />
      {choose && (
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-xs font-bold text-ink-soft">{S.contents}</legend>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="_mode" checked={mode === "all"} onChange={() => setMode("all")} className="h-4 w-4 accent-brand-600" />{fill(S.all, { n: totalOpen })}</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" name="_mode" checked={mode === "part"} onChange={() => setMode("part")} className="h-4 w-4 accent-brand-600" />{S.part}</label>
          {mode === "part" && (
            <ul className="space-y-1.5 rounded-xl bg-slate-50 p-2 ring-1 ring-black/5">
              {open.map((o) => (
                <li key={o.lineId} className="flex items-center gap-2 text-sm">
                  <input type="number" min={0} max={o.qty} step={1} value={pick[o.lineId] ?? 0} aria-label={o.description}
                    onChange={(e) => setPick({ ...pick, [o.lineId]: Math.max(0, Math.min(o.qty, Math.floor(Number(e.target.value) || 0))) })}
                    className="input num w-16 shrink-0 px-2 py-1 text-center" />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o.description}</span>
                  <span className="num shrink-0 text-xs text-ink-soft">{fill(S.open, { n: o.qty })}</span>
                </li>
              ))}
            </ul>
          )}
          {tried && pickedNone && <p className="text-xs font-semibold text-red-600">{S.errors.empty}</p>}
        </fieldset>
      )}
      {shop && (
        <label className="flex items-start gap-2 rounded-xl bg-brand-50/60 p-2.5 text-sm ring-1 ring-brand-100">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600" />
          <span>{S.notify}</span>
        </label>
      )}
      {tried && v.carrier === "OTHER" && !v.carrierName.trim() && <p className="text-xs font-semibold text-red-600">{S.errors.carrierName}</p>}
      <button disabled={pending} className="btn-primary group w-full">
        {pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="truck" className="h-4 w-4" />}
        {pending ? S.saving : shop ? S.saveShop : S.save}
      </button>
      <Msg t={t} state={state} />
    </form>
  );
}

/** Ändern / Zurücknehmen / Erneut senden an einer gespeicherten Sendung */
export function ShipmentActions({ t, invoiceId, shop, failed, names, s }: {
  t: Dict; invoiceId: string; shop: boolean; failed: boolean; names: string[];
  s: { id: string; carrier: string; carrierName: string; trackingNumbers: string[]; trackingUrl: string };
}) {
  const S = t.ship;
  const [mode, setMode] = useState<"" | "edit" | "cancel">("");
  const [state, setState] = useState<ShipState>(undefined);
  const [busy, setBusy] = useState<"" | "edit" | "cancel" | "retry">("");
  const go = (kind: "create" | "edit" | "cancel", action: (s: ShipState, fd: FormData) => Promise<ShipState>, check?: () => boolean) =>
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (busy || (check && !check())) return;
      setBusy(kind === "create" ? "retry" : kind); setState(undefined);
      const err = await run(action, new FormData(e.currentTarget), invoiceId, kind);
      if (err) { setState(err); setBusy(""); }
    };
  const start = (): TrackingState => ({ carrier: (CARRIERS as readonly string[]).includes(s.carrier) ? (s.carrier as Carrier) : "OTHER", carrierName: s.carrierName, url: s.trackingUrl, numbers: s.trackingNumbers.length ? [...s.trackingNumbers] : [""] });
  const [v, setV] = useState<TrackingState>(start);
  const [notify, setNotify] = useState(true);
  const [tried, setTried] = useState(false);
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {failed && (
          <form onSubmit={go("create", retryShipmentAction)}>
            <input type="hidden" name="id" value={s.id} /><input type="hidden" name="invoiceId" value={invoiceId} />
            <button disabled={Boolean(busy)} className="btn-primary px-3 py-1.5 text-xs">{busy === "retry" ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="history" className="h-3.5 w-3.5" />}{S.retry}</button>
          </form>
        )}
        <button type="button" disabled={Boolean(busy)} onClick={() => { setV(start()); setTried(false); setState(undefined); setMode(mode === "edit" ? "" : "edit"); }} aria-expanded={mode === "edit"} className="btn-ghost px-3 py-1.5 text-xs"><Icon name="edit" className="h-3.5 w-3.5" />{S.edit}</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => { setState(undefined); setMode(mode === "cancel" ? "" : "cancel"); }} aria-expanded={mode === "cancel"} className="btn-danger px-3 py-1.5 text-xs"><Icon name="x" className="h-3.5 w-3.5" />{S.cancel}</button>
      </div>
      {mode === "" && <Msg t={t} state={state} />}
      {mode === "cancel" && (
        <form onSubmit={go("cancel", cancelShipmentAction)} className="animate-rise space-y-2 rounded-xl bg-red-50/70 p-3 ring-1 ring-red-100">
          <input type="hidden" name="id" value={s.id} /><input type="hidden" name="invoiceId" value={invoiceId} />
          <p className="text-sm text-red-900">{shop ? S.cancelConfirm : `${S.cancel}?`}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" autoFocus onClick={() => setMode("")} className="btn-ghost px-3 py-1.5 text-xs">{S.keep}</button>
            <button disabled={Boolean(busy)} className="btn-danger px-3 py-1.5 text-xs">{busy === "cancel" ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-200 border-t-red-600" /> : <Icon name="x" className="h-3.5 w-3.5" />}{S.cancelYes}</button>
          </div>
          <Msg t={t} state={state} />
        </form>
      )}
      {mode === "edit" && (
        <form onSubmit={go("edit", editShipmentAction, () => { setTried(true); return okToSend(v); })} className="animate-rise space-y-3 rounded-xl bg-white p-3 ring-1 ring-black/10">
          <input type="hidden" name="id" value={s.id} /><input type="hidden" name="invoiceId" value={invoiceId} />
          <input type="hidden" name="carrier" value={v.carrier} />
          <input type="hidden" name="carrierName" value={v.carrier === "OTHER" ? v.carrierName : ""} />
          <input type="hidden" name="trackingUrl" value={v.carrier === "OTHER" ? v.url : ""} />
          <input type="hidden" name="numbers" value={JSON.stringify(v.numbers.filter((n) => n.trim()))} />
          <input type="hidden" name="notify" value={shop && notify ? "1" : ""} />
          <TrackingFields t={t} v={v} set={setV} names={names} idp={`e-${s.id}`} tried={tried} />
          {shop && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-brand-600" />
              <span>{S.notifyEdit}</span>
            </label>
          )}
          {tried && v.carrier === "OTHER" && !v.carrierName.trim() && <p className="text-xs font-semibold text-red-600">{S.errors.carrierName}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setMode("")} className="btn-ghost px-3 py-1.5 text-xs">{S.keep}</button>
            <button disabled={Boolean(busy)} className="btn-primary px-3 py-1.5 text-xs">{busy === "edit" ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="check" className="h-3.5 w-3.5" />}{S.saveEdit}</button>
          </div>
          <Msg t={t} state={state} />
        </form>
      )}
    </div>
  );
}
