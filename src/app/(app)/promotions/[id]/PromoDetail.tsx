"use client";
/**
 * Seite einer Aktion (Wunsch Inhaber 19.11.2026): links Werbebild + Artikel, rechts Rabatt, Bild im Shop, Ende.
 * Rabatt und Bild unabhängig an/aus mit optionalem Zeitraum („+3 Tage“, „+7 Tage“ = verlängern). Der Stand (Bild wird
 * erstellt, Preise/Bild gehen in die Shops) kommt alle 2,5 s von /api/promotions/[id], solange etwas läuft.
 * Nach Änderungen lädt die Seite neu (Actions ohne revalidatePath, siehe CLAUDE.md).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { ErrorBox } from "@/components/Forms";
import { Thumb } from "@/components/Thumb";
import { formatCents } from "@/lib/money";
import { discounted, extendUntil, percentToBp, PROMO_PLACES, PROMO_SHOPS, type PhaseState } from "@/lib/promo-rules";
import type { PromoItem } from "@/lib/promotions";
import type { SaleOption } from "../../sales/DocEditor";
import type { Dict } from "@/i18n/de";
import { bannerAction, deleteAction, endAction, priceAction, regenerateAction, setProductsAction, textAction, updateBasicsAction, type PromoResult } from "../actions";
import { ItemsPicker, type ChosenItem } from "../ItemsPicker";
import { phaseSentence } from "../labels";

type Copy = Record<string, { headline: string; sub: string; names: string[] }>;
export type Live = {
  job: string; error: string; version: number; files: Record<string, string>; copy: Copy;
  state: { price: PhaseState; banner: PhaseState }; dirty: number; shown: Record<string, "top" | "below" | null>;
  shops: { channel: string; error: string; uploaded: boolean }[];
};
export type PromoView = {
  id: string; number: number; title: string; discountBp: number; places: string[];
  priceOn: boolean; priceFrom: string | null; priceUntil: string | null;
  bannerOn: boolean; bannerFrom: string | null; bannerUntil: string | null; bannerShops: string[]; bannerPlace: "top" | "below";
  ended: string | null; items: PromoItem[]; configuredShops: string[]; live: Live;
};

const LANGS = ["de", "en", "ar", "nl"] as const;
const berlinToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

export function PromoDetail({ t, view, options, intl, uiLang, canCost }: { t: Dict; view: PromoView; options: SaleOption[]; intl: string; uiLang: string; canCost: boolean }) {
  const T = t.promo;
  const [live, setLive] = useState<Live>(view.live);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ended = !!view.ended;

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/api/promotions/${view.id}`, { cache: "no-store" });
      if (r.ok) setLive(await r.json());
    } catch { /* nächster Versuch */ }
  }, [view.id]);
  const bannerActive = live.state.banner === "active";
  const shopsPending = view.bannerShops.some((ch) => view.configuredShops.includes(ch)
    && (bannerActive ? live.shown[ch] !== view.bannerPlace && !live.shops.find((s) => s.channel === ch)?.error : !!live.shown[ch]));
  const busy = live.job === "running" || live.dirty > 0 || shopsPending;
  useEffect(() => {
    if (!busy) return;
    const iv = setInterval(poll, 2500);
    const stop = setTimeout(() => clearInterval(iv), 180_000);
    return () => { clearInterval(iv); clearTimeout(stop); };
  }, [busy, poll]);

  /** Action ausführen; reload = danach neu laden (Stand vom Server), sonst nur den Stand abfragen */
  const run = (fn: () => Promise<PromoResult>, opts: { reload?: boolean; job?: boolean } = { reload: true }) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) { setError(r.error ?? "error"); return; }
      if (opts.job) setLive((l) => ({ ...l, job: "running", error: "" }));
      if (opts.reload) window.location.reload();
      else await poll();
    });
  };
  const errText = error ? (T.errors as Record<string, string>)[error] ?? T.errors.error : undefined;

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
      <div className="min-w-0 space-y-6">
        <BannerCard t={t} live={live} uiLang={uiLang} busy={pending} ended={ended}
          onRegenerate={() => run(() => regenerateAction(view.id), { job: true })}
          onText={(copy) => run(() => textAction(view.id, copy), { job: true })} />
        <ItemsCard t={t} view={view} options={options} intl={intl} canCost={canCost} busy={pending}
          onSave={(ids) => run(() => setProductsAction(view.id, ids))} />
      </div>
      <div className="space-y-6 xl:sticky xl:top-4">
        <ErrorBox message={errText} />
        <PriceCard t={t} view={view} live={live} intl={intl} busy={pending}
          onBasics={(b) => run(() => updateBasicsAction(view.id, b))}
          onWindow={(w) => run(() => priceAction(view.id, w))} />
        <ShopCard t={t} view={view} live={live} intl={intl} busy={pending}
          onWindow={(w) => run(() => bannerAction(view.id, w))} />
        <EndCard t={t} view={view} live={live} intl={intl} busy={pending}
          onEnd={() => run(() => endAction(view.id))}
          onDelete={() => { setError(null); start(async () => { const r = await deleteAction(view.id); if (r.ok) window.location.assign("/promotions"); else setError(r.error ?? "error"); }); }} />
      </div>
    </div>
  );
}

// ───────────────────────── Werbebild ─────────────────────────

function BannerCard({ t, live, uiLang, busy, ended, onRegenerate, onText }: {
  t: Dict; live: Live; uiLang: string; busy: boolean; ended: boolean; onRegenerate: () => void; onText: (c: Copy) => void;
}) {
  const T = t.promo;
  const [fmt, setFmt] = useState<"wide" | "tall">("wide");
  const [lang, setLang] = useState<(typeof LANGS)[number]>(uiLang === "ar" || uiLang === "en" ? uiLang : "de");
  const [editing, setEditing] = useState(false);
  const file = live.files[`${fmt}-${lang}`];
  const running = live.job === "running";
  return (
    <section className="card animate-rise overflow-hidden" data-promo-banner>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 px-4 py-3">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="image" className="icon-pop h-5 w-5 text-brand-600" />{T.stepImage}</h2>
        <div className="flex flex-wrap gap-2">
          <Segmented value={fmt} onChange={(v) => setFmt(v as "wide" | "tall")} options={[{ value: "wide", label: T.computer, icon: "grid" }, { value: "tall", label: T.phone, icon: "phone" }]} />
          <Segmented value={lang} onChange={(v) => setLang(v as (typeof LANGS)[number])} options={LANGS.map((l) => ({ value: l, label: l.toUpperCase(), title: T.langs[l] }))} />
        </div>
      </div>
      <div className="relative bg-slate-100 p-3 sm:p-4">
        {file ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${file}-${live.version}`} src={`/api/files/${file}`} alt="" data-promo-preview
            className={`mx-auto block rounded-xl shadow-card ${fmt === "wide" ? "aspect-[3/1] w-full" : "aspect-[4/5] w-full max-w-sm"} bg-white object-contain`} />
        ) : (
          <div className={`mx-auto grid place-items-center rounded-xl bg-white text-sm text-ink-soft ring-1 ring-black/5 ${fmt === "wide" ? "aspect-[3/1] w-full" : "aspect-[4/5] w-full max-w-sm"}`}>{running ? "" : T.noImage}</div>
        )}
        {running && (
          <div className="absolute inset-3 grid place-items-center rounded-xl bg-navy-900/70 p-4 text-center text-white backdrop-blur-sm sm:inset-4" data-promo-making>
            <div className="max-w-sm space-y-3">
              <span className="mx-auto block h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
              <p className="text-sm font-semibold">{T.making}</p>
            </div>
          </div>
        )}
      </div>
      {live.job === "failed" && <div className="px-4 pt-3"><ErrorBox message={fill(T.imageFailed, { e: live.error || "?" })} /></div>}
      <div className="flex flex-wrap items-center gap-2 p-4">
        {!ended && <button type="button" onClick={onRegenerate} disabled={busy || running} className="btn-primary group" data-promo-regenerate title={T.newImageHint}>
          <Icon name="spark" className="icon-pop h-4 w-4" />{file ? T.newImage : T.makeImage}
        </button>}
        {!ended && file && <button type="button" onClick={() => setEditing(true)} disabled={busy || running} className="btn-ghost group" data-promo-edit-text>
          <Icon name="edit" className="icon-pop h-4 w-4" />{T.editText}
        </button>}
        {file && <a href={`/api/files/${file}`} download={`aktion-${fmt}-${lang}.webp`} className="btn-ghost group"><Icon name="download" className="icon-pop h-4 w-4" />{T.download}</a>}
        {file && <span className="text-xs text-ink-soft">{T.newImageHint}</span>}
      </div>
      {editing && <TextDialog t={t} copy={live.copy} onClose={() => setEditing(false)} onSave={(c) => { setEditing(false); onText(c); }} />}
    </section>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; icon?: "grid" | "phone"; title?: string }[] }) {
  return (
    <div className="inline-flex rounded-xl bg-slate-100 p-1 ring-1 ring-black/5" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.title} onClick={() => onChange(o.value)}
          className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-semibold transition ${value === o.value ? "bg-white text-brand-700 shadow-card" : "text-ink-soft hover:text-ink"}`}>
          {o.icon && <Icon name={o.icon} className="h-3.5 w-3.5" />}{o.label}
        </button>
      ))}
    </div>
  );
}

function TextDialog({ t, copy, onClose, onSave }: { t: Dict; copy: Copy; onClose: () => void; onSave: (c: Copy) => void }) {
  const T = t.promo;
  const [lang, setLang] = useState<(typeof LANGS)[number]>("de");
  const [c, setC] = useState<Record<string, { headline: string; sub: string; names: string }>>(() => Object.fromEntries(LANGS.map((l) => [l, {
    headline: copy[l]?.headline ?? "", sub: copy[l]?.sub ?? "", names: (copy[l]?.names ?? []).join("\n"),
  }])));
  const set = (k: "headline" | "sub" | "names", v: string) => setC((x) => ({ ...x, [lang]: { ...x[lang], [k]: v } }));
  return (
    <Dialog title={T.textTitle} onClose={onClose} cancel={t.common.cancel}>
      <p className="text-sm text-ink-soft">{T.textHint}</p>
      <Segmented value={lang} onChange={(v) => setLang(v as (typeof LANGS)[number])} options={LANGS.map((l) => ({ value: l, label: T.langs[l] }))} />
      <div className="space-y-3" dir={lang === "ar" ? "rtl" : "ltr"} lang={lang}>
        <label className="block"><span className="label">{T.headline}</span><input value={c[lang].headline} maxLength={60} onChange={(e) => set("headline", e.target.value)} className="input" /></label>
        <label className="block"><span className="label">{T.sub}</span><input value={c[lang].sub} maxLength={70} onChange={(e) => set("sub", e.target.value)} className="input" /></label>
        <label className="block"><span className="label">{T.shortNames}</span><textarea value={c[lang].names} rows={4} onChange={(e) => set("names", e.target.value)} className="input" /></label>
      </div>
      <button type="button" className="btn-primary group w-full py-3" data-promo-save-text
        onClick={() => onSave(Object.fromEntries(LANGS.map((l) => [l, { headline: c[l].headline, sub: c[l].sub, names: c[l].names.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 4) }])))}>
        <Icon name="check" className="h-5 w-5" />{T.saveText}
      </button>
    </Dialog>
  );
}

// ───────────────────────── Rabatt ─────────────────────────

function DateRange({ t, from, until, onFrom, onUntil }: { t: Dict; from: string; until: string; onFrom: (v: string) => void; onUntil: (v: string) => void }) {
  const T = t.promo;
  const today = berlinToday();
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block"><span className="label">{T.from}</span><input type="date" value={from} onChange={(e) => onFrom(e.target.value)} className="input" /></label>
        <label className="block"><span className="label">{T.until}</span><input type="date" value={until} min={from || undefined} onChange={(e) => onUntil(e.target.value)} className="input" /></label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[2, 3, 7, 14].map((n) => (
          <button key={n} type="button" onClick={() => onUntil(extendUntil(until || null, from && from > today ? from : today, n))}
            className="rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-brand-100 hover:bg-brand-100" data-promo-plus={n}>
            {fill(T.plusDays, { n })}
          </button>
        ))}
        {until && <button type="button" onClick={() => onUntil("")} className="rounded-full px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-slate-100"><Icon name="x" className="inline h-3 w-3" /></button>}
      </div>
    </div>
  );
}

function PriceCard({ t, view, live, intl, busy, onBasics, onWindow }: {
  t: Dict; view: PromoView; live: Live; intl: string; busy: boolean;
  onBasics: (b: { title: string; percent: string; places: string[] }) => void;
  onWindow: (w: { on: boolean; from: string; until: string }) => void;
}) {
  const T = t.promo;
  const [from, setFrom] = useState(view.priceFrom ?? "");
  const [until, setUntil] = useState(view.priceUntil ?? "");
  const [percent, setPercent] = useState(String(Math.round(view.discountBp / 100)));
  const [title, setTitle] = useState(view.title);
  const [places, setPlaces] = useState<string[]>(view.places);
  const s = live.state.price;
  const changedDates = from !== (view.priceFrom ?? "") || until !== (view.priceUntil ?? "");
  const changedBasics = percent !== String(Math.round(view.discountBp / 100)) || title !== view.title || places.slice().sort().join() !== view.places.slice().sort().join();
  const shopsIn = view.places.some((p) => (PROMO_SHOPS as readonly string[]).includes(p) && view.configuredShops.includes(p));
  return (
    <section className="card animate-rise space-y-4 p-4" data-promo-price>
      <div className="flex items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${s === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}><Icon name="percent" className="icon-pop h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{T.stepPrice}</h2>
          <p className="text-sm text-ink-soft" data-promo-price-state>{phaseSentence(T.priceState, s, { from: view.priceFrom, until: view.priceUntil }, intl)}</p>
          {shopsIn && s !== "scheduled" && (live.dirty > 0
            ? <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-amber-700"><span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-300 border-t-amber-700" />{T.pricesSync}</p>
            : (s === "active" || view.priceOn) && <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-700"><Icon name="check" className="h-3.5 w-3.5" />{T.pricesDone}</p>)}
        </div>
      </div>
      <div className="grid grid-cols-[7rem_1fr] gap-2">
        <label className="block">
          <span className="label">{T.percentLabel}</span>
          <div className="relative" dir="ltr">
            <input value={percent} onChange={(e) => setPercent(e.target.value.replace(/[^\d]/g, "").slice(0, 2))} inputMode="numeric" dir="ltr" className="input num pr-9 text-right text-lg font-black" data-promo-percent />
            <span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-base font-black text-ink-soft" aria-hidden="true">%</span>
          </div>
        </label>
        <label className="block">
          <span className="label">{T.titleLabel}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder={T.titlePh} className="input" dir="auto" />
        </label>
      </div>
      <fieldset>
        <legend className="label">{T.placesLabel}</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {PROMO_PLACES.map((pl) => (
            <label key={pl} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium ring-1 ring-black/5 hover:bg-brand-50/50">
              <input type="checkbox" checked={places.includes(pl)} onChange={(e) => setPlaces((ps) => (e.target.checked ? [...ps, pl] : ps.filter((x) => x !== pl)))} className="h-4 w-4 accent-brand-600" />
              {T.places[pl]}
            </label>
          ))}
        </div>
      </fieldset>
      {changedBasics && <button type="button" disabled={busy || percentToBp(percent) == null} onClick={() => onBasics({ title, percent, places })} className="btn-primary group w-full" data-promo-save-basics>
        <Icon name="check" className="h-4 w-4" />{t.common.save}
      </button>}
      <DateRange t={t} from={from} until={until} onFrom={setFrom} onUntil={setUntil} />
      <div className="flex flex-wrap gap-2">
        {view.priceOn && !view.ended ? <>
          <button type="button" disabled={busy} onClick={() => onWindow({ on: false, from, until })} className="btn group flex-1 bg-slate-800 text-white hover:bg-slate-900" data-promo-price-off>
            <Icon name="stop" className="h-4 w-4" />{T.stopPrice}
          </button>
          {changedDates && <button type="button" disabled={busy} onClick={() => onWindow({ on: true, from, until })} className="btn-primary group flex-1" data-promo-price-save>
            <Icon name="check" className="h-4 w-4" />{T.saveDates}
          </button>}
        </> : (
          <button type="button" disabled={busy || changedBasics} onClick={() => onWindow({ on: true, from, until })} className="btn group w-full bg-emerald-600 py-3 text-white shadow-card hover:bg-emerald-700" data-promo-price-on>
            <Icon name="bolt" className="h-5 w-5" />{T.startPrice}
          </button>
        )}
      </div>
    </section>
  );
}

// ───────────────────────── Bild im Shop ─────────────────────────

function ShopCard({ t, view, live, intl, busy, onWindow }: {
  t: Dict; view: PromoView; live: Live; intl: string; busy: boolean;
  onWindow: (w: { on: boolean; from: string; until: string; shops: string[]; place: string }) => void;
}) {
  const T = t.promo;
  const [from, setFrom] = useState(view.bannerFrom ?? "");
  const [until, setUntil] = useState(view.bannerUntil ?? "");
  const [shops, setShops] = useState<string[]>(view.bannerShops);
  const [place, setPlace] = useState<"top" | "below">(view.bannerPlace);
  const s = live.state.banner;
  const hasImage = Object.keys(live.files).length > 0;
  const changed = from !== (view.bannerFrom ?? "") || until !== (view.bannerUntil ?? "") || place !== view.bannerPlace || shops.slice().sort().join() !== view.bannerShops.slice().sort().join();
  const shopName = (ch: string) => T.placesShort[ch as keyof typeof T.placesShort] ?? ch;
  const lines = view.bannerShops.filter((ch) => view.configuredShops.includes(ch)).map((ch) => {
    const st = live.shops.find((x) => x.channel === ch), shown = live.shown[ch];
    const v = { shop: shopName(ch), place: shown === "below" ? T.below : T.top, e: st?.error ?? "" };
    if (s === "active") {
      if (shown) return { tone: "ok", text: fill(T.shopLine.shown, v) };
      if (st?.error?.startsWith("needScope")) return { tone: "warn", text: fill(T.shopLine.needScope, v) };
      if (st?.error && st.error !== "network") return { tone: "err", text: fill(T.shopLine.error, v) };
      if (st?.uploaded) return { tone: "wait", text: fill(T.shopLine.waiting, v) };
      return { tone: "wait", text: fill(T.shopLine.uploading, v) };
    }
    if (shown) return { tone: "wait", text: fill(T.shopLine.removing, v) };
    return { tone: "off", text: fill(T.shopLine.off, v) };
  });
  const TONE: Record<string, string> = { ok: "bg-emerald-50 text-emerald-800", warn: "bg-amber-50 text-amber-800", err: "bg-red-50 text-red-700", wait: "bg-brand-50 text-brand-800", off: "bg-slate-50 text-ink-soft" };
  return (
    <section className="card animate-rise space-y-4 p-4" data-promo-shop>
      <div className="flex items-start gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${s === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}><Icon name="globe" className="icon-pop h-5 w-5" /></span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{T.stepShop}</h2>
          <p className="text-sm text-ink-soft" data-promo-banner-state>{phaseSentence(T.bannerState, s, { from: view.bannerFrom, until: view.bannerUntil }, intl)}</p>
        </div>
      </div>
      {s === "active" && live.state.price !== "active" && (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200">{fill(T.warnBannerNoPrice, { p: Math.round(view.discountBp / 100) })}</p>
      )}
      <fieldset>
        <legend className="label">{T.shops}</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {PROMO_SHOPS.map((ch) => (
            <label key={ch} className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium ring-1 ring-black/5 ${view.configuredShops.includes(ch) ? "cursor-pointer hover:bg-brand-50/50" : "opacity-50"}`}>
              <input type="checkbox" disabled={!view.configuredShops.includes(ch)} checked={shops.includes(ch)} onChange={(e) => setShops((x) => (e.target.checked ? [...x, ch] : x.filter((y) => y !== ch)))} className="h-4 w-4 accent-brand-600" />
              {shopName(ch)}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="label">{T.where}</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["top", "below"] as const).map((pl) => (
            <button key={pl} type="button" role="radio" aria-checked={place === pl} onClick={() => setPlace(pl)} data-promo-place={pl}
              className={`rounded-xl p-2 text-start ring-1 transition ${place === pl ? "bg-brand-50 ring-2 ring-brand-500" : "ring-black/10 hover:bg-slate-50"}`}>
              <PlaceSketch where={pl} />
              <span className="mt-1.5 block text-xs font-semibold leading-tight">{pl === "top" ? T.top : T.below}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <DateRange t={t} from={from} until={until} onFrom={setFrom} onUntil={setUntil} />
      {!hasImage && <p className="text-xs font-semibold text-amber-700">{T.errors.noBanner}</p>}
      <div className="flex flex-wrap gap-2">
        {view.bannerOn && !view.ended ? <>
          <button type="button" disabled={busy} onClick={() => onWindow({ on: false, from, until, shops, place })} className="btn group flex-1 bg-slate-800 text-white hover:bg-slate-900" data-promo-banner-off>
            <Icon name="stop" className="h-4 w-4" />{T.stopBanner}
          </button>
          {changed && <button type="button" disabled={busy || !shops.length} onClick={() => onWindow({ on: true, from, until, shops, place })} className="btn-primary group flex-1" data-promo-banner-save>
            <Icon name="check" className="h-4 w-4" />{T.saveDates}
          </button>}
        </> : (
          <button type="button" disabled={busy || !hasImage || !shops.length || live.job === "running"} onClick={() => onWindow({ on: true, from, until, shops, place })}
            className="btn group w-full bg-emerald-600 py-3 text-white shadow-card hover:bg-emerald-700" data-promo-banner-on>
            <Icon name="upload" className="h-5 w-5" />{T.startBanner}
          </button>
        )}
      </div>
      {lines.length > 0 && (
        <ul className="space-y-1.5" data-promo-shop-lines>
          {lines.map((l, i) => <li key={i} className={`rounded-lg px-3 py-2 text-xs font-semibold ${TONE[l.tone]}`}>{l.text}</li>)}
        </ul>
      )}
    </section>
  );
}

/** kleine Skizze der Startseite: Kopf, Bild, großes Startbild – zeigt, wo das Werbebild hinkommt */
function PlaceSketch({ where }: { where: "top" | "below" }) {
  const banner = <span className="block h-2.5 rounded-sm bg-accent-500" />;
  return (
    <span className="block space-y-1 rounded-lg bg-white p-1.5 ring-1 ring-black/5" aria-hidden>
      <span className="block h-1.5 rounded-sm bg-navy-800/70" />
      {where === "top" && banner}
      <span className="block h-6 rounded-sm bg-brand-200" />
      {where === "below" && banner}
      <span className="grid grid-cols-3 gap-1"><span className="h-2 rounded-sm bg-slate-200" /><span className="h-2 rounded-sm bg-slate-200" /><span className="h-2 rounded-sm bg-slate-200" /></span>
    </span>
  );
}

// ───────────────────────── Artikel ─────────────────────────

function ItemsCard({ t, view, options, intl, canCost, busy, onSave }: {
  t: Dict; view: PromoView; options: SaleOption[]; intl: string; canCost: boolean; busy: boolean; onSave: (ids: string[]) => void;
}) {
  const T = t.promo;
  const bp = view.discountBp;
  const [editing, setEditing] = useState(false);
  const initial = useMemo<ChosenItem[]>(() => view.items.map((i) => ({ productId: i.productId, name: i.name, imageId: i.imageId, category: i.category, retail: i.retailCents, wholesale: i.wholesaleCents })), [view.items]);
  const [items, setItems] = useState<ChosenItem[]>(initial);
  const shopsIn = view.places.filter((p) => (PROMO_SHOPS as readonly string[]).includes(p) && view.configuredShops.includes(p));
  const below = (i: PromoItem) => canCost && i.costCents > 0 && (discounted(i.retailCents, bp) < i.costCents || (i.wholesaleCents > 0 && discounted(i.wholesaleCents, bp) < i.costCents));
  const nBelow = view.items.filter(below).length;
  const pp = (c: number) => (
    <span className="num inline-flex flex-wrap items-baseline justify-end gap-x-1.5" dir="ltr">
      <s className="text-xs text-ink-soft">{formatCents(c, intl)}</s><b className="text-accent-700">{formatCents(discounted(c, bp), intl)}</b>
    </span>
  );
  return (
    <section className="card relative z-10 animate-rise overflow-hidden" data-promo-items-card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 px-4 py-3">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="box" className="icon-pop h-5 w-5 text-brand-600" />{T.stepItems} <span className="text-sm font-semibold text-ink-soft">({view.items.length})</span></h2>
        {!editing && !view.ended && <button type="button" onClick={() => setEditing(true)} className="btn-ghost group px-3 py-1.5 text-xs" data-promo-edit-items><Icon name="edit" className="icon-pop h-4 w-4" />{T.editItems}</button>}
      </div>
      {nBelow > 0 && <p className="mx-4 mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">{fill(T.warnBelowCost, { n: nBelow })}</p>}
      {editing ? (
        <div className="space-y-3 p-4">
          <ItemsPicker t={t} options={options} items={items} onChange={setItems} discountBp={bp} intl={intl} />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !items.length} onClick={() => onSave(items.map((i) => i.productId))} className="btn-primary group" data-promo-save-items><Icon name="check" className="h-4 w-4" />{T.saveItems}</button>
            <button type="button" onClick={() => { setItems(initial); setEditing(false); }} className="btn-ghost">{T.cancel}</button>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-black/5">
          {view.items.map((i) => {
            const missing = shopsIn.filter((ch) => !i.inShops.includes(ch));
            return (
              <li key={i.productId} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 px-4 py-3 sm:grid-cols-[3rem_minmax(0,1fr)_auto]">
                <Thumb id={i.imageId} size={48} />
                <div className="min-w-0">
                  <div className="truncate font-semibold" dir="auto">{i.name}</div>
                  <div className="flex flex-wrap gap-1.5 pt-0.5 text-[0.7rem]">
                    {i.category && <span className="text-ink-soft" dir="auto">{i.category}</span>}
                    {below(i) && <span className="badge bg-red-50 text-red-700">{fill(T.belowCost, { c: formatCents(i.costCents, intl) })}</span>}
                    {i.otherBp > bp && <span className="badge bg-amber-50 text-amber-800">{fill(T.otherPromo, { p: Math.round(i.otherBp / 100) })}</span>}
                    {missing.map((ch) => <span key={ch} className="badge bg-slate-100 text-slate-600">{T.notInShop}: {T.placesShort[ch as keyof typeof T.placesShort]}</span>)}
                  </div>
                </div>
                <div className="col-span-2 grid grid-cols-2 gap-x-4 text-xs sm:col-span-1 sm:text-end">
                  <span className="text-ink-soft">{t.customer.RETAIL}<br />{pp(i.retailCents)}</span>
                  <span className="text-ink-soft">{t.customer.WHOLESALE}<br />{i.wholesaleCents > 0 ? pp(i.wholesaleCents) : "—"}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────── Ende ─────────────────────────

function EndCard({ t, view, live, intl, busy, onEnd, onDelete }: { t: Dict; view: PromoView; live: Live; intl: string; busy: boolean; onEnd: () => void; onDelete: () => void }) {
  const T = t.promo;
  const [ask, setAsk] = useState<"end" | "delete" | null>(null);
  const name = view.title || fill(T.name, { n: view.number });
  const off = !view.priceOn && !view.bannerOn;
  const stillShown = Object.values(live.shown).some((x) => x);
  return (
    <section className="card animate-rise space-y-3 p-4" data-promo-end>
      {view.ended && <p className="text-sm font-semibold text-ink-soft">{fill(T.ended, { d: new Intl.DateTimeFormat(intl, { dateStyle: "medium", timeZone: "Europe/Berlin" }).format(new Date(view.ended)) })}</p>}
      {!off && <>
        <p className="text-sm text-ink-soft">{T.endHint}</p>
        <button type="button" disabled={busy} onClick={() => setAsk("end")} className="btn group w-full bg-accent-600 text-white shadow-card hover:bg-accent-700" data-promo-end-open>
          <Icon name="stop" className="h-4 w-4" />{T.endTitle}
        </button>
      </>}
      {off && <>
        <p className="text-sm text-ink-soft">{T.deleteHint}</p>
        <button type="button" disabled={busy || stillShown || live.dirty > 0} onClick={() => setAsk("delete")} className="btn-danger group w-full" data-ai-block data-promo-delete-open>
          <Icon name="trash" className="h-4 w-4" />{T.deleteTitle}
        </button>
      </>}
      {ask && (
        <Dialog title={fill(ask === "end" ? T.endAsk : T.deleteAsk, { name })} onClose={() => setAsk(null)} cancel={t.common.cancel} danger>
          <p className="text-sm text-ink-soft">{ask === "end" ? T.endHint : T.deleteHint}</p>
          <button type="button" data-promo-confirm onClick={() => { const a = ask; setAsk(null); if (a === "end") onEnd(); else onDelete(); }}
            className={`btn group w-full py-3 text-base text-white shadow-card ${ask === "end" ? "bg-accent-600 hover:bg-accent-700" : "bg-red-600 hover:bg-red-700"}`}>
            <Icon name={ask === "end" ? "stop" : "trash"} className="h-5 w-5" />{ask === "end" ? T.endYes : T.deleteYes}
          </button>
        </Dialog>
      )}
    </section>
  );
}

/** Fenster über der Seite (Portal, Fokus auf „Abbrechen“, Esc/Hintergrund schließt) */
function Dialog({ title, onClose, cancel, danger = false, children }: { title: string; onClose: () => void; cancel: string; danger?: boolean; children: React.ReactNode }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cancelBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", esc);
    cancelBtn.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }} data-promo-dialog>
      <div className="max-h-[92vh] w-full max-w-lg space-y-4 overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <h2 className={`text-lg font-bold leading-snug [overflow-wrap:anywhere] ${danger ? "text-ink" : ""}`}>{title}</h2>
        {children}
        <button ref={cancelBtn} type="button" onClick={onClose} className="btn-ghost w-full">{cancel}</button>
      </div>
    </div>,
    document.body,
  );
}
