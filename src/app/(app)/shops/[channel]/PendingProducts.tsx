"use client";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { storeTypeLabel, type StoreType } from "@/lib/shopify/product-push-map";
import type { BulkState, PendingProduct, PushResult } from "@/lib/shopify/product-push";
import { bulkStatusAction, mapCategoryAction, pushOneAction, refreshCategoriesAction, startBulkPushAction, unlistAction } from "../actions";
import type { Dict } from "@/i18n/de";

type Channel = "BRAND_SHOP" | "GENERAL_SHOP";
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const Spinner = () => <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />;

/** Ergebnis eines Hochladens als Satz (gleiche Texte wie nach dem Speichern im Artikel) */
function resultText(t: Dict, channel: Channel, r: PushResult | null) {
  if (!r) return { ok: true, text: `${t.shop.names[channel]}: ${t.product.inShop}` };
  const ok = r.outcome === "created" || r.outcome === "linked" || r.outcome === "updated";
  return { ok, text: fill(t.product.push[r.outcome], { shop: t.shop.names[channel], n: r.n ?? 0, reason: r.reason ? t.product.pushReasons[r.reason] : "" }) };
}

/**
 * „Noch nicht im Shop“ (Wunsch Inhaber 03.11.2026): angehakte Artikel, die im Shop ganz oder teilweise fehlen.
 * Einzeln hochladen, „Nicht für diesen Shop“, oder alle bereiten auf einmal (läuft im Hintergrund, Fortschritt wird abgefragt).
 */
export function PendingProducts({ t, channel, items, types, initialBulk }: {
  t: Dict; channel: Channel; items: PendingProduct[]; types: StoreType[]; initialBulk: BulkState | null;
}) {
  const P = t.shop.pending;
  const router = useRouter();
  const [bulk, setBulk] = useState<BulkState | null>(initialBulk);
  const [confirming, setConfirming] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const ready = items.filter((x) => !x.blockers.length);
  const running = Boolean(bulk?.running);
  // bereite zuerst; lange Listen erst gekürzt
  const [showAll, setShowAll] = useState(false);
  const sorted = [...ready, ...items.filter((x) => x.blockers.length)];
  const shown = showAll ? sorted : sorted.slice(0, 25);
  const label = (type: string) => { const hit = types.find((x) => x.type === type); return hit ? storeTypeLabel(hit) : type; };

  // Fortschritt abfragen, solange „Alle hochladen“ läuft
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      const st = await bulkStatusAction(channel);
      setBulk(st);
      if (!st?.running) { window.clearInterval(id); router.refresh(); }
    }, 1500);
    return () => window.clearInterval(id);
  }, [running, channel, router]);

  const pushOne = (x: PendingProduct) => start(async () => {
    setBusyId(x.id); setMsg(null);
    const { result } = await pushOneAction(channel, x.id);
    setBusyId(null);
    const r = resultText(t, channel, result);
    setMsg({ ok: r.ok, text: `${x.nameDe} – ${r.text}` });
    router.refresh();
  });
  const unlist = (x: PendingProduct) => start(async () => { setMsg(null); await unlistAction(channel, x.id); router.refresh(); });
  const startBulk = () => start(async () => {
    setConfirming(false); setMsg(null);
    const r = await startBulkPushAction(channel);
    if (r.error) setMsg({ ok: false, text: ((t.shop.errors as Record<string, string>)[r.error] ?? t.shop.errors.other).replace("{d}", r.detail ?? "") });
    else setBulk(r.bulk ?? null);
  });

  return (
    <section id="pending" className="card animate-rise overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-black/5 bg-gradient-to-l from-brand-50 to-white p-5 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Icon name="upload" className="icon-pop h-5 w-5 text-brand-600" />{P.title}
            {items.length > 0 && <span className="badge bg-accent-500 text-white">{items.length}</span>}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">{P.hint}</p>
        </div>
        {ready.length > 0 && !running && (confirming ? (
          <div className="animate-rise rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200 md:max-w-sm">
            <p className="font-semibold text-amber-900">{fill(P.confirmAll, { n: ready.length })}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={pending} onClick={startBulk} className="btn-primary group"><Icon name="upload" className="h-4 w-4" />{P.yes}</button>
              <button type="button" onClick={() => setConfirming(false)} className="btn-ghost">{P.cancel}</button>
            </div>
          </div>
        ) : (
          <button type="button" disabled={pending} onClick={() => setConfirming(true)} className="btn-primary group shrink-0">
            <Icon name="upload" className="h-4 w-4" />{fill(P.pushAll, { n: ready.length })}
          </button>
        ))}
      </div>

      {bulk && (bulk.running || bulk.finishedAt) && (
        <div className="border-b border-black/5 p-4">
          {bulk.running ? (
            <>
              <div className="mb-1 flex items-center justify-between gap-3 text-sm font-semibold">
                <span>{fill(P.running, { d: bulk.done, t: bulk.total })}</span>
                <span className="truncate text-xs font-normal text-ink-soft" dir="auto">{bulk.current}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-brand-100">
                <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500 transition-all" style={{ width: `${bulk.total ? (bulk.done / bulk.total) * 100 : 100}%` }} />
              </div>
            </>
          ) : (
            <p className={`flex items-start gap-2 text-sm font-semibold ${bulk.failed ? "text-amber-800" : "text-emerald-700"}`}>
              <Icon name={bulk.failed ? "alert" : "check"} className="mt-0.5 h-4 w-4 shrink-0" />
              {fill(P.done, { c: bulk.created, l: bulk.linked, u: bulk.updated, f: bulk.failed, s: bulk.skipped })}
            </p>
          )}
        </div>
      )}
      {msg && <p className={`m-4 animate-rise rounded-xl px-4 py-3 text-sm font-semibold ring-1 ${msg.ok ? "bg-emerald-50 text-emerald-800 ring-emerald-100" : "bg-amber-50 text-amber-900 ring-amber-200"}`}>{msg.text}</p>}

      {items.length === 0 ? (
        <p className="flex items-center gap-2 p-5 text-sm font-semibold text-emerald-700"><Icon name="check" className="h-4 w-4" />{P.none}</p>
      ) : (
        <ul className="divide-y divide-black/5">
          {shown.map((x) => (
            <li key={x.id} className="flex flex-col gap-3 p-4 md:flex-row md:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Thumb id={x.imageId} size={44} />
                <div className="min-w-0 space-y-1">
                  <Link href={`/products/${x.id}`} className="block font-semibold leading-snug [overflow-wrap:anywhere] hover:text-brand-700">{x.nameDe}</Link>
                  <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
                    <bdi dir="ltr" className="tabular-nums">{x.barcodes[0] ?? x.sku}</bdi>
                    <span className={`badge ${x.kind === "new" ? "bg-brand-50 text-brand-700" : "bg-sky-50 text-sky-800"}`}>{x.kind === "new" ? P.kindNew : fill(P.kindAdd, { n: x.missing })}</span>
                    {x.kind === "new" && x.storeType && <span className="badge bg-black/5 text-ink-soft">{fill(P.placed, { c: label(x.storeType) })}</span>}
                    {x.blockers.length === 0
                      ? <span className="badge bg-emerald-50 text-emerald-700">{P.ready}</span>
                      : x.blockers.map((b) => <span key={b} className="badge bg-amber-100 text-amber-900">{fill(P.blockers[b], { c: x.category })}</span>)}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button type="button" disabled={pending || running || x.blockers.length > 0} onClick={() => pushOne(x)} className="btn-primary group px-3 py-1.5 text-sm">
                  {busyId === x.id ? <Spinner /> : <Icon name="upload" className="h-4 w-4" />}{P.push}
                </button>
                <Link href={`/products/${x.id}`} className="btn-ghost group px-3 py-1.5 text-sm"><Icon name="edit" className="h-4 w-4" />{P.edit}</Link>
                <button type="button" title={P.unlistHint} disabled={pending || running} onClick={() => unlist(x)} className="btn-ghost px-3 py-1.5 text-sm text-ink-soft">{P.unlist}</button>
              </div>
            </li>
          ))}
          {shown.length < sorted.length && (
            <li className="p-3 text-center">
              <button type="button" onClick={() => setShowAll(true)} className="btn-ghost group"><Icon name="grid" className="h-4 w-4" />{fill(P.showAll, { n: sorted.length })}</button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Unsere Kategorien → Kategorien des Shops (Produkttyp → automatische Kollektion). Gleiche Namen passen von selbst. */
export function CategoryMap({ t, channel, rows, types }: {
  t: Dict; channel: Channel; types: StoreType[];
  rows: { category: string; n: number; auto: string | null; mapped: string | null }[];
}) {
  const C = t.shop.categories;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState("");
  const set = (category: string, type: string) => start(async () => {
    const r = await mapCategoryAction(channel, category, type);
    setMsg(r.ok ? t.shop.saved : t.shop.errors.other.replace("{d}", r.detail ?? ""));
    router.refresh();
  });
  const refresh = () => start(async () => {
    const r = await refreshCategoriesAction(channel);
    setMsg(r.ok ? t.shop.saved : ((t.shop.errors as Record<string, string>)[r.error ?? "other"] ?? t.shop.errors.other).replace("{d}", r.detail ?? ""));
    router.refresh();
  });
  // nicht passende zuerst
  const sorted = [...rows].sort((a, b) => Number(Boolean(a.auto || a.mapped)) - Number(Boolean(b.auto || b.mapped)) || a.category.localeCompare(b.category, "de"));

  return (
    <section className="card animate-rise p-5">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-bold"><Icon name="tag" className="icon-pop h-5 w-5 text-brand-600" />{C.title}</h2>
          <p className="max-w-2xl text-sm text-ink-soft">{C.hint}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link href="/categories" className="btn-ghost group text-sm"><Icon name="tag" className="h-4 w-4" />{t.nav.categories}</Link>
          <button type="button" disabled={pending} onClick={refresh} className="btn-ghost group text-sm"><Icon name="history" className="h-4 w-4" />{C.refresh}</button>
        </div>
      </div>
      {msg && <p className="mb-3 animate-rise rounded-xl bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-800">{msg}</p>}
      {types.length === 0 ? <p className="text-sm text-ink-soft">{C.none}</p> : rows.length === 0 ? null : (
        <ul className="divide-y divide-black/5">
          {sorted.map((r) => (
            <li key={r.category} className="grid gap-2 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-center">
              <div className="min-w-0">
                <span className="text-xs text-ink-soft">{C.ours}</span>
                <div className="font-semibold [overflow-wrap:anywhere]">{r.category} <span className="text-xs font-normal text-ink-soft">· {fill(C.count, { n: r.n })}</span></div>
              </div>
              {r.auto ? (
                <div className="text-sm"><span className="text-xs text-ink-soft">{C.store}</span>
                  <div className="font-semibold text-emerald-700">{storeTypeLabel(types.find((x) => x.type === r.auto) ?? { type: r.auto, collection: null })} <span className="text-xs font-normal">· {C.same}</span></div>
                </div>
              ) : (
                <label className="block">
                  <span className="text-xs text-ink-soft">{C.store}</span>
                  <select disabled={pending} value={r.mapped ?? ""} onChange={(e) => set(r.category, e.target.value)}
                    className={`input ${r.mapped ? "" : "border-amber-300 bg-amber-50"}`}>
                    <option value="">{C.choose}</option>
                    {types.map((ty) => <option key={ty.type} value={ty.type}>{storeTypeLabel(ty)}{ty.collection && ty.collection !== ty.type ? ` (${ty.type})` : ""}</option>)}
                  </select>
                </label>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
