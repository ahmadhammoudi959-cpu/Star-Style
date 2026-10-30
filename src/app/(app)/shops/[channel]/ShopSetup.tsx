"use client";
import { useActionState, useState, useTransition } from "react";
import { activateAction, importProductsAction, loadProductsAction, pushAllAction, saveShopAction, setLocationAction, syncNowAction, testShopAction, webhooksAction, type ShopResult } from "../actions";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon, type IconName } from "@/components/Icon";
import type { Dict } from "@/i18n/de";

type ShopData = { channel: string; domain: string; clientId: string; hasSecret: boolean; legacy: boolean; stockBuffer: number; importTestOrders: boolean; locationId: string; locationName: string; active: boolean; webhooksAt: string | null };

const errText = (t: Dict, r?: ShopResult) => r?.error ? ((t.shop.errors as Record<string, string>)[r.error] ?? (r.error === "noPublicUrl" ? t.shop.noPublicUrl : t.shop.errors.other)).replace("{d}", r.detail ?? "") : undefined;
const fmt = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

/** Ergebnis des Produkt-Imports: neu | Varianten | vorhanden | zugeordnet | offen | Fotos | fehlgeschlagen */
function importText(t: Dict, ok = "") {
  const [c = "0", v = "0", e = "0", m = "0", o = "0", i = "0", f = "0"] = ok.split("|");
  return [fmt(t.shop.importDone, { c, v, e, m, o }), Number(f) > 0 ? fmt(t.shop.importFailed, { f }) : "", Number(i) > 0 ? fmt(t.shop.importImages, { i }) : ""]
    .filter(Boolean).join(" ");
}

export function ShopForm({ t, s }: { t: Dict; s: ShopData }) {
  const [state, action] = useActionState(saveShopAction, undefined);
  const [legacy, setLegacy] = useState(s.legacy);
  return (
    <form action={action} className="card animate-rise space-y-4 p-5">
      <input type="hidden" name="channel" value={s.channel} />
      <ErrorBox message={errText(t, state)} />
      {state?.ok && <p className="flex items-center gap-2 rounded-xl bg-brand-50 px-4 py-2 text-sm font-semibold text-brand-700"><Icon name="check" className="h-4 w-4" />{t.shop.saved}</p>}
      <Field label={t.shop.domain} hint={t.shop.domainHint}><input name="domain" defaultValue={s.domain} required dir="ltr" className="input" /></Field>
      <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" name="legacy" checked={legacy} onChange={(e) => setLegacy(e.target.checked)} className="h-4 w-4 accent-brand-600" />{t.shop.legacy}</label>
      {legacy
        ? <Field label={t.shop.staticToken} hint={s.legacy ? t.shop.secretKeep : undefined}><input name="staticToken" type="password" autoComplete="off" dir="ltr" className="input" placeholder="shpat_…" /></Field>
        : <Field label={t.shop.clientId}><input name="clientId" defaultValue={s.clientId} dir="ltr" className="input" autoComplete="off" /></Field>}
      <Field label={t.shop.clientSecret} hint={s.hasSecret ? t.shop.secretKeep : undefined}><input name="clientSecret" type="password" autoComplete="off" dir="ltr" className="input" /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t.shop.buffer} hint={t.shop.bufferHint}><input name="stockBuffer" type="number" min={0} defaultValue={s.stockBuffer} className="input num" /></Field>
        <label className="flex cursor-pointer items-center gap-2 self-center text-sm"><input type="checkbox" name="importTestOrders" defaultChecked={s.importTestOrders} className="h-4 w-4 accent-brand-600" />{t.shop.testOrders}</label>
      </div>
      <SubmitButton className="btn-primary w-full">{t.common.save}</SubmitButton>
    </form>
  );
}

export function ShopControls({ t, s }: { t: Dict; s: ShopData }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [active, setActive] = useState(s.active);
  const run = (fn: () => Promise<ShopResult>, okText: (r: ShopResult) => string) => start(async () => {
    const r = await fn();
    setMsg(r.error ? { ok: false, text: errText(t, r)! } : { ok: true, text: okText(r) });
    if (r.locations) setLocations(r.locations);
  });
  const Btn = ({ icon, label, onClick, tone = "btn-ghost", disabled }: { icon: IconName; label: string; onClick: () => void; tone?: string; disabled?: boolean }) => (
    <button type="button" disabled={pending || disabled} onClick={onClick} className={`${tone} group w-full justify-start`}><Icon name={icon} className="h-4 w-4" />{label}</button>
  );
  const ready = Boolean(s.domain && s.hasSecret);
  return (
    <div className="card animate-rise space-y-3 p-5">
      <Btn icon="check" label={t.shop.test} disabled={!ready} onClick={() => run(() => testShopAction(s.channel), (r) => t.shop.testOk.replace("{name}", r.ok ?? ""))} />
      {(locations.length > 0 || s.locationId) && (
        <Field label={t.shop.location} hint={t.shop.locationHint}>
          <select className="input" value={s.locationId} onChange={(e) => { const l = locations.find((x) => x.id === e.target.value); if (l) run(() => setLocationAction(s.channel, l.id, l.name), () => t.shop.saved); }}>
            {!s.locationId && <option value="">—</option>}
            {s.locationId && !locations.some((l) => l.id === s.locationId) && <option value={s.locationId}>{s.locationName}</option>}
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </Field>
      )}
      <Btn icon="layers" label={t.shop.loadProducts} disabled={!ready} onClick={() => run(() => loadProductsAction(s.channel), (r) => { const [a, b, c] = (r.ok ?? "").split("|"); return (t.shop.ev.productsLoaded).replace("{t}", a).replace("{m}", b).replace("{o}", c); })} />
      <div>
        <Btn icon="download" label={t.shop.importProducts} disabled={!ready} onClick={() => { if (confirm(active ? t.shop.importConfirmActive : t.shop.importConfirm)) run(() => importProductsAction(s.channel), (r) => importText(t, r.ok)); }} />
        <p className="mt-1 px-1 text-xs leading-relaxed text-ink-soft">{t.shop.importHint}</p>
      </div>
      <div className="rounded-xl bg-brand-50/60 p-3 ring-1 ring-brand-100">
        <label className="flex cursor-pointer items-start gap-2 text-sm font-semibold">
          <input type="checkbox" checked={active} disabled={pending || !ready} onChange={(e) => {
            const on = e.target.checked; setActive(on);
            start(async () => { const r = await activateAction(s.channel, on); if (r.error) { setActive(!on); setMsg({ ok: false, text: errText(t, r)! }); } else setMsg({ ok: true, text: t.shop.saved }); });
          }} className="mt-0.5 h-5 w-5 accent-brand-600" />
          <span>{t.shop.activate}<span className="block text-xs font-normal text-ink-soft">{t.shop.activateHint}</span></span>
        </label>
      </div>
      <Btn icon="clock" label={t.shop.syncNow} disabled={!active} onClick={() => run(() => syncNowAction(s.channel), () => t.shop.saved)} />
      <Btn icon="arrowRight" label={t.shop.pushAll} disabled={!active} onClick={() => run(() => pushAllAction(s.channel), (r) => `${t.shop.pushed}: ${(r.ok ?? "").split("|")[0]}`)} />
      <div>
        <Btn icon="mail" label={t.shop.webhooks} disabled={!ready} onClick={() => run(() => webhooksAction(s.channel), (r) => (t.shop.ev.registered).replace("{p}", r.ok ?? "0"))} />
        <p className="mt-1 px-1 text-xs text-ink-soft">{t.shop.webhooksHint}{s.webhooksAt ? ` ✓` : ""}</p>
      </div>
      {pending && <p className="flex items-center gap-2 text-sm text-ink-soft"><span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />…</p>}
      {msg && <p className={`animate-rise rounded-xl px-3 py-2 text-sm font-semibold ${msg.ok ? "bg-brand-50 text-brand-800" : "bg-red-50 text-red-700"}`}>{msg.text}</p>}
    </div>
  );
}
