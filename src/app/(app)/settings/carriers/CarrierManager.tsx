"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { carrierAction, type CarrierResult } from "./actions";
import {
  CARRIER_NAME_MAX, MAX_CUSTOM_CARRIERS, carrierChoices, checkCustomCarrier, cleanCarrierName, cleanCarrierUrl, withNumberPlaceholder,
  type CarrierChoice, type CarrierOp, type CarrierSettings,
} from "@/lib/carriers";
import { carrierUrlTemplate, customUrlOk, trackingUrl } from "@/lib/shipping";
import type { Dict } from "@/i18n/de";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? `{${k}}`));
const SAMPLE = "ABC123456";
const host = (u: string | null) => { try { return u ? new URL(u.split("{n}").join("1")).host : ""; } catch { return ""; } };
const Spinner = ({ light }: { light?: boolean }) => (
  <span className={`h-3.5 w-3.5 animate-spin rounded-full border-2 ${light ? "border-white/40 border-t-white" : "border-brand-200 border-t-brand-600"}`} />
);

/** Name + Link eines eigenen Versanddienstes; die Nummer in einem kopierten Link wird zu {n} */
function CarrierForm({ t, s, exceptId, initial, used, busy, error, submitLabel, idp, onSubmit, onCancel }: {
  t: Dict; s: CarrierSettings; exceptId?: string; initial?: { name: string; url: string }; used: string[]; busy: boolean; error?: string;
  submitLabel: string; idp: string; onSubmit: (name: string, url: string) => void; onCancel: () => void;
}) {
  const C = t.carriers;
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [sample, setSample] = useState("");
  const [tried, setTried] = useState(false);
  const finalUrl = withNumberPlaceholder(url, sample);
  const problem = checkCustomCarrier(s, name, finalUrl, exceptId);
  const shownProblem = problem && (tried || problem === "nameTaken" || (problem === "url" && cleanCarrierUrl(url).length > 8)) ? problem : null;
  const hasN = finalUrl.includes("{n}");
  const num = sample.replace(/\s+/g, "") && hasN && !url.includes("{n}") ? sample.replace(/\s+/g, "") : SAMPLE;
  const link = finalUrl && customUrlOk(finalUrl) ? trackingUrl("OTHER", num, finalUrl) : null;
  const suggestions = used.filter((n) => n.toLowerCase() !== name.trim().toLowerCase()).slice(0, 8);
  return (
    <form className="animate-rise space-y-3" onSubmit={(e) => {
      e.preventDefault();
      setTried(true);
      if (!busy && !problem) onSubmit(cleanCarrierName(name), finalUrl);
    }}>
      <div>
        <label htmlFor={`${idp}-name`} className="mb-1 block text-xs font-bold text-ink-soft">{C.name}</label>
        <input id={`${idp}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={CARRIER_NAME_MAX} placeholder={C.namePh}
          className="input" autoComplete="off" autoFocus />
        {!initial && suggestions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-ink-soft">{C.used}</span>
            {suggestions.map((n) => (
              <button key={n} type="button" onClick={() => setName(n)} className="rounded-full bg-white px-2.5 py-1 font-semibold ring-1 ring-black/10 transition hover:bg-brand-50 hover:ring-brand-200">{n}</button>
            ))}
          </div>
        )}
      </div>
      <div>
        <label htmlFor={`${idp}-url`} className="mb-1 block text-xs font-bold text-ink-soft">{C.url}</label>
        <input id={`${idp}-url`} value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" inputMode="url" placeholder="https://…"
          className="input" autoComplete="off" spellCheck={false} />
        <p className="mt-1 text-[0.6875rem] text-ink-soft">{C.urlHint}</p>
      </div>
      {cleanCarrierUrl(url) && !url.includes("{n}") && (
        <div>
          <label htmlFor={`${idp}-sample`} className="mb-1 block text-xs font-bold text-ink-soft">{C.sample}</label>
          <input id={`${idp}-sample`} value={sample} onChange={(e) => setSample(e.target.value)} dir="ltr" placeholder={SAMPLE}
            className="input num" autoComplete="off" spellCheck={false} autoCapitalize="characters" />
          <p className={`mt-1 text-[0.6875rem] ${hasN ? "font-semibold text-emerald-700" : "text-amber-800"}`}>
            {hasN ? C.sampleHint : sample.trim() ? C.sampleMissing : C.noNumber}
          </p>
        </div>
      )}
      {link && (
        <div className="rounded-xl bg-white p-2.5 text-xs ring-1 ring-black/5">
          {hasN && <div className="mb-0.5 text-ink-soft">{fill(C.example, { x: num })}</div>}
          <bdi dir="ltr" className="block font-semibold [overflow-wrap:anywhere]">{link}</bdi>
          <a href={link} target="_blank" rel="noopener noreferrer" className="group mt-1.5 inline-flex items-center gap-1 font-bold text-brand-700 hover:underline">
            <Icon name="link" className="h-3.5 w-3.5" />{C.test}
          </a>
        </div>
      )}
      <p className="text-[0.6875rem] text-ink-soft">{C.shopTip}</p>
      {shownProblem && <p role="alert" className="text-xs font-semibold text-red-600">{C.errors[shownProblem]}</p>}
      {error && <p role="alert" className="text-xs font-semibold text-red-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onCancel} className="btn-ghost px-3 py-1.5 text-sm">{C.keep}</button>
        <button disabled={busy} className="btn-primary group px-3 py-1.5 text-sm">{busy ? <Spinner light /> : <Icon name="check" className="h-4 w-4" />}{submitLabel}</button>
      </div>
    </form>
  );
}

/**
 * Seite „Versanddienste“ (Wunsch Inhaber 13.11.2026): Reihenfolge, anzeigen/ausblenden, vorwählen, eigene hinzufügen/ändern/entfernen.
 * Jede Änderung wird sofort gespeichert; rechts die Knöpfe so, wie sie beim Versand aussehen.
 */
export function CarrierManager({ t, initial, used }: { t: Dict; initial: CarrierSettings; used: string[] }) {
  const C = t.carriers;
  const [s, setS] = useState(initial);
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string; where: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState("");
  const [removing, setRemoving] = useState("");
  const choices = useMemo(() => carrierChoices(s), [s]);
  const visible = choices.filter((c) => !c.hidden);
  const label = (c: CarrierChoice) => (c.kind === "free" ? t.ship.other : c.name);

  useEffect(() => {
    if (!status?.ok) return;
    const id = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(id);
  }, [status]);

  async function run(op: CarrierOp, where: string): Promise<boolean> {
    if (busy) return false;
    setBusy(where);
    setStatus(null);
    let r: CarrierResult;
    try { r = await carrierAction(op); } catch { r = { ok: false, error: "error" }; }
    setBusy("");
    if (r.ok) { setS(r.settings); setStatus({ ok: true, text: C.saved, where }); return true; }
    setStatus({ ok: false, text: C.errors[r.error] ?? C.errors.error, where });
    return false;
  }
  const formError = (where: string) => (status && !status.ok && status.where === where ? status.text : undefined);
  const close = () => { setAdding(false); setEditing(""); setRemoving(""); };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="card animate-rise overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/5 p-5">
          <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="truck" className="h-5 w-5 text-brand-600" />{C.listTitle}</h2>
          <div className="flex flex-wrap items-center gap-3">
            <span aria-live="polite" className="text-sm font-semibold">
              {busy ? <span className="inline-flex items-center gap-1.5 text-ink-soft"><Spinner />{C.saving}</span>
                : status && (status.ok || !status.where.startsWith("form")) ? <span className={status.ok ? "text-emerald-700" : "text-red-600"}>{status.text}</span> : null}
            </span>
            {!adding && s.custom.length < MAX_CUSTOM_CARRIERS && (
              <button type="button" onClick={() => { close(); setAdding(true); setStatus(null); }} className="btn-primary group px-3 py-2 text-sm">
                <Icon name="plus" className="h-4 w-4" />{C.add}
              </button>
            )}
          </div>
        </div>
        {adding && (
          <div className="border-b border-black/5 bg-brand-50/40 p-5">
            <h3 className="mb-3 flex items-center gap-2 font-bold"><Icon name="plus" className="h-4 w-4 text-brand-600" />{C.add}</h3>
            <CarrierForm t={t} s={s} used={used} busy={busy === "form-add"} error={formError("form-add")} submitLabel={C.create} idp="add"
              onCancel={() => { setAdding(false); setStatus(null); }}
              onSubmit={async (name, url) => { if (await run({ op: "add", name, url }, "form-add")) setAdding(false); }} />
          </div>
        )}
        <ul className="divide-y divide-black/5">
          {choices.map((c, i) => {
            const tpl = c.kind === "builtin" ? host(carrierUrlTemplate(c.key)) : c.url;
            const isDefault = s.default === c.key;
            return (
              <li key={c.key} className={`p-4 transition-colors sm:px-5 ${c.hidden ? "bg-slate-50/80" : ""}`}>
                <div className="flex items-start gap-3">
                  <div className="flex shrink-0 flex-col gap-1">
                    <button type="button" aria-label={`${C.up}: ${label(c)}`} title={C.up} disabled={Boolean(busy) || i === 0} onClick={() => run({ op: "up", key: c.key }, c.key)}
                      className="group grid h-8 w-8 place-items-center rounded-lg bg-white ring-1 ring-black/10 transition hover:bg-brand-50 disabled:opacity-30">
                      <Icon name="chevronDown" className="h-4 w-4 rotate-180" />
                    </button>
                    <button type="button" aria-label={`${C.down}: ${label(c)}`} title={C.down} disabled={Boolean(busy) || i === choices.length - 1} onClick={() => run({ op: "down", key: c.key }, c.key)}
                      className="group grid h-8 w-8 place-items-center rounded-lg bg-white ring-1 ring-black/10 transition hover:bg-brand-50 disabled:opacity-30">
                      <Icon name="chevronDown" className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`font-bold [overflow-wrap:anywhere] ${c.hidden ? "text-ink-soft" : ""}`}>{label(c)}</span>
                      {isDefault && <span className="badge gap-1 bg-brand-100 text-brand-800"><Icon name="star" className="h-3 w-3" />{C.isDefault}</span>}
                      {c.hidden && <span className="badge bg-slate-200 text-slate-700">{C.hiddenBadge}</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-ink-soft">{C.kind[c.kind]}</p>
                    {c.kind !== "free" && (
                      <p className="mt-0.5 text-xs text-ink-soft">{tpl ? <bdi dir="ltr" className="[overflow-wrap:anywhere]">{tpl}</bdi> : C.noLink}</p>
                    )}
                    {editing !== c.key && removing !== c.key && (!isDefault || c.kind === "custom") && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {!isDefault && (
                          <button type="button" disabled={Boolean(busy)} onClick={() => run({ op: "default", key: c.key }, c.key)} className="btn-ghost group px-2.5 py-1 text-xs">
                            <Icon name="star" className="h-3.5 w-3.5" />{C.makeDefault}
                          </button>
                        )}
                        {c.kind === "custom" && (
                          <>
                            <button type="button" disabled={Boolean(busy)} onClick={() => { close(); setEditing(c.key); setStatus(null); }} className="btn-ghost group px-2.5 py-1 text-xs">
                              <Icon name="edit" className="h-3.5 w-3.5" />{C.edit}
                            </button>
                            <button type="button" disabled={Boolean(busy)} onClick={() => { close(); setRemoving(c.key); setStatus(null); }} className="btn-danger group px-2.5 py-1 text-xs">
                              <Icon name="trash" className="h-3.5 w-3.5" />{C.remove}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {editing === c.key && (
                      <div className="mt-3 rounded-xl bg-brand-50/40 p-3 ring-1 ring-brand-100">
                        <CarrierForm t={t} s={s} exceptId={c.key} initial={{ name: c.name, url: c.url }} used={used} busy={busy === `form-${c.key}`}
                          error={formError(`form-${c.key}`)} submitLabel={C.saveEdit} idp={`e-${c.key}`} onCancel={() => { setEditing(""); setStatus(null); }}
                          onSubmit={async (name, url) => { if (await run({ op: "edit", key: c.key, name, url }, `form-${c.key}`)) setEditing(""); }} />
                      </div>
                    )}
                    {removing === c.key && (
                      <div className="mt-3 animate-rise space-y-2 rounded-xl bg-red-50/70 p-3 ring-1 ring-red-100">
                        <p className="text-sm text-red-900">{fill(C.removeConfirm, { name: c.name })}</p>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" autoFocus onClick={() => setRemoving("")} className="btn-ghost px-3 py-1.5 text-xs">{C.keep}</button>
                          <button type="button" disabled={Boolean(busy)} onClick={async () => { if (await run({ op: "remove", key: c.key }, c.key)) setRemoving(""); }} className="btn-danger group px-3 py-1.5 text-xs">
                            {busy === c.key ? <Spinner /> : <Icon name="trash" className="h-3.5 w-3.5" />}{C.removeYes}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button type="button" role="switch" aria-checked={!c.hidden} aria-label={`${C.showLabel}: ${label(c)}`} title={C.showLabel} disabled={Boolean(busy)}
                    onClick={() => run({ op: c.hidden ? "show" : "hide", key: c.key }, c.key)} className="group flex shrink-0 items-center gap-2 rounded-lg p-1 text-xs text-ink-soft disabled:opacity-60">
                    <span className="hidden sm:inline">{C.showLabel}</span>
                    <span className={`relative h-6 w-11 rounded-full transition-colors ${c.hidden ? "bg-slate-300" : "bg-brand-600"}`}>
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${c.hidden ? "start-0.5" : "start-[1.375rem]"}`} />
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      {/* Vorschau: die Knöpfe so, wie sie in der Karte „Versand“ stehen (die Spalte selbst ist sticky) */}
      <aside className="card animate-rise p-5 xl:sticky xl:top-6">
        <h2 className="mb-3 flex items-center gap-2 font-bold"><Icon name="eye" className="h-5 w-5 text-brand-600" />{C.preview}</h2>
        <div className="mb-1.5 text-xs font-bold text-ink-soft">{t.ship.carrier}</div>
        <div className="grid grid-cols-3 gap-1.5" aria-hidden>
          {visible.map((c) => (
            <span key={c.key} title={label(c)} className={`min-w-0 truncate rounded-xl px-1.5 py-2 text-center text-sm font-bold ring-1 transition ${s.default === c.key ? "bg-brand-600 text-white shadow-card ring-brand-600" : "bg-white text-ink ring-black/10"}`}>
              {label(c)}
            </span>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-soft">{C.previewHint}</p>
      </aside>
    </div>
  );
}
