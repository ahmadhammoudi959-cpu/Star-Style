"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { shrinkImage } from "@/lib/image-client";
import { GALLERY_MAX } from "@/lib/shopify/gallery-map";
import { adoptShopPhotos, resendShopPhotos, uploadShopPhoto } from "./actions";
import type { Dict } from "@/i18n/de";

export type Channel = "BRAND_SHOP" | "GENERAL_SHOP";
type Where = "both" | "system" | "store";
/**
 * Ein Foto der Shop-Galerie im Formular. fileId null = wird gerade hochgeladen; saved = so schon gespeichert (sonst neu im Formular);
 * inShop = im Shop vorhanden (Medium gemerkt). hidden = „nur aus dem Shop“ genommen (bleibt hier grau), savedHidden = so gespeichert.
 * gone = entfernt, gilt beim Speichern: "both" = auch im Shop löschen, "system" = im Shop lassen (Wunsch Inhaber 04.11.2026).
 */
export type GItem = {
  key: string; fileId: string | null; preview: string; inShop: boolean; error: string; saved: boolean;
  hidden: boolean; savedHidden: boolean; gone?: "both" | "system";
};

export const galleryItem = (g: { fileId: string; mediaId: string; error: string; hidden?: boolean }): GItem => ({
  key: g.fileId, fileId: g.fileId, preview: `/api/files/${g.fileId}`, inShop: Boolean(g.mediaId), error: g.error, saved: true,
  hidden: Boolean(g.hidden), savedHidden: Boolean(g.hidden),
});

const fresh = (key: string, fileId: string | null, preview: string): GItem =>
  ({ key, fileId, preview, inShop: false, error: "", saved: false, hidden: false, savedHidden: false });

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/**
 * Eigene Fotos für einen Shop (Wunsch Inhaber 04.11.2026): bis zu 10, das erste ist das Titelbild, Reihenfolge mit Pfeilen.
 * Fotos werden beim Auswählen verkleinert und sofort gespeichert; das Formular schickt nur die Liste (`gallery_<Kanal>`).
 * Entfernen eines Fotos, das im Shop ist → Rückfrage: aus System und Shop / nur aus dem System / nur aus dem Shop. Ungefragt wird im Shop nie gelöscht.
 */
export function ShopGallery({ t, channel, items, onChange, linked, productId, stockImageId, other }: {
  t: Dict; channel: Channel; items: GItem[]; onChange: (f: (items: GItem[]) => GItem[]) => void;
  linked: boolean; productId?: string; stockImageId?: string | null;
  other?: { name: string; items: GItem[] };
}) {
  const G = t.product.gallery;
  const shop = t.shop.names[channel];
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<GItem | null>(null);
  const shown = items.filter((i) => !i.gone);
  const has = (id: string) => shown.some((i) => i.fileId === id);
  const free = GALLERY_MAX - shown.length;
  const mainKey = shown.find((i) => !i.hidden)?.key; // Titelbild im Shop = erstes, das dort gezeigt wird
  // fürs Formular: Reihenfolge (auch die grauen), davon nicht im Shop, und was auch im Shop gelöscht werden soll
  const value = JSON.stringify({
    files: shown.filter((i) => i.fileId).map((i) => i.fileId),
    hidden: shown.filter((i) => i.fileId && i.hidden).map((i) => i.fileId),
    drop: items.filter((i) => i.fileId && i.gone === "both").map((i) => i.fileId),
  });

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files].slice(0, Math.max(0, free));
    if (files.length > free) setMsg({ text: fill(G.full, { n: GALLERY_MAX }), bad: true }); else setMsg(null);
    // Platzhalter sofort, dann nacheinander verkleinern und speichern
    const keys = list.map(() => crypto.randomUUID());
    onChange((xs) => [...xs, ...keys.map((key) => fresh(key, null, ""))]);
    for (const [i, f] of list.entries()) {
      const key = keys[i];
      try {
        const small = await shrinkImage(f, 2048);
        const preview = URL.createObjectURL(small);
        onChange((xs) => xs.map((x) => (x.key === key ? { ...x, preview } : x)));
        const fd = new FormData();
        fd.append("file", small);
        const r = await uploadShopPhoto(fd);
        if (!r.id) throw new Error(r.error ?? "imageType");
        onChange((xs) => xs.map((x) => (x.key === key ? { ...x, fileId: r.id! } : x)));
      } catch (e) {
        onChange((xs) => xs.filter((x) => x.key !== key));
        setMsg({ text: e instanceof Error && e.message === "fileTooLarge" ? t.product.fileTooLarge : t.product.imageType, bad: true });
      }
    }
    if (input.current) input.current.value = "";
  }

  /** Pfeile: mit dem nächsten sichtbaren Foto tauschen (entfernte bleiben bis zum Speichern unsichtbar in der Liste) */
  const move = (key: string, d: -1 | 1) => onChange((xs) => {
    const vis = xs.flatMap((x, i) => (x.gone ? [] : [i]));
    const k = vis.findIndex((i) => xs[i].key === key), j = k + d;
    if (k < 0 || j < 0 || j >= vis.length) return xs;
    const out = [...xs];
    [out[vis[k]], out[vis[j]]] = [out[vis[j]], out[vis[k]]];
    return out;
  });
  const patch = (key: string, p: Partial<GItem>) => onChange((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  /** ×: Foto im Shop → erst fragen; sonst gleich weg (neu = ganz weg, gespeichert = beim Speichern) */
  function remove(it: GItem) {
    if (!it.saved) { onChange((xs) => xs.filter((x) => x.key !== it.key)); return; }
    if (it.inShop && !it.hidden) { setAsk(it); return; }
    patch(it.key, { gone: "both" });
  }
  function choose(it: GItem, where: Where) {
    setAsk(null);
    patch(it.key, where === "store" ? { hidden: true } : { gone: where });
  }
  const undo = () => onChange((xs) => xs.map((x) => ({ ...x, gone: undefined, hidden: x.savedHidden })));
  const addIds = (list: string[]) => onChange((xs) => {
    const out = [...xs];
    let room = GALLERY_MAX - out.filter((x) => !x.gone).length;
    for (const id of list) {
      if (room <= 0) break;
      const at = out.findIndex((x) => x.fileId === id);
      if (at >= 0 && !out[at].gone) continue;
      if (at >= 0) out[at] = { ...out[at], gone: undefined, hidden: false }; // vorhin entfernt → wieder da
      else out.push(fresh(crypto.randomUUID(), id, `/api/files/${id}`));
      room--;
    }
    return out;
  });
  const otherIds = (other?.items ?? []).filter((x) => x.fileId && !x.gone && !x.hidden).map((x) => x.fileId!);

  async function adopt() {
    if (!productId) return;
    setBusy(true); setMsg(null);
    const r = await adoptShopPhotos(productId, channel).catch(() => ({ ok: false as const, error: "failed" as const }));
    setBusy(false);
    if (r.ok) { onChange(() => r.items.map(galleryItem)); setMsg({ text: fill(G.adopted, { n: r.items.length }) }); }
    else setMsg({ text: r.error === "none" ? G.adoptNone : r.error === "notEmpty" ? G.adoptNotEmpty : G.adoptFailed, bad: r.error !== "none" });
  }

  async function resend() {
    if (!productId) return;
    setBusy(true); setMsg(null);
    const r = await resendShopPhotos(productId, channel).catch(() => ({ status: "failed" as const }));
    setBusy(false);
    setMsg(r.status === "done" || r.status === "nothing" ? { text: G.resent } : { text: G.resendFailed, bad: true });
  }

  // Stand im Shop (so gespeichert)
  const uploading = items.some((i) => !i.fileId);
  const saved = items.filter((i) => i.fileId && i.saved);
  const live = saved.filter((i) => !i.savedHidden);
  const inShop = live.filter((i) => i.inShop).length;
  const failed = live.filter((i) => !i.inShop && i.error).length;
  const waiting = live.length - inShop - failed;
  const off = saved.filter((i) => i.savedHidden);
  const onlyHere = off.filter((i) => !i.inShop).length;
  const removing = off.filter((i) => i.inShop && !i.error).length;
  const removeFailed = off.filter((i) => i.inShop && i.error).length;
  const unsaved = items.some((i) => i.fileId && !i.saved);
  // noch nicht gespeicherte Entscheidungen beim Entfernen
  const pend = {
    both: items.filter((i) => i.gone === "both" && i.inShop && !i.savedHidden).length,
    system: items.filter((i) => i.gone === "system").length,
    store: items.filter((i) => !i.gone && i.hidden && !i.savedHidden).length,
    back: items.filter((i) => !i.gone && !i.hidden && i.savedHidden).length,
    removed: items.filter((i) => i.gone === "both" && (!i.inShop || i.savedHidden)).length,
  };
  const pending = pend.both + pend.system + pend.store + pend.back + pend.removed > 0;

  return (
    <section className="card animate-rise p-5">
      <div className="mb-3 flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="camera" className="icon-pop h-5 w-5 text-brand-600" />{fill(G.title, { shop })}</h2>
        <p className="max-w-2xl text-sm text-ink-soft">{G.hint}</p>
      </div>

      <ul className="flex flex-wrap gap-3">
        {shown.map((it, k) => {
          // Stand im Shop: grau = „nur aus dem Shop“ (Symbol nur, solange es dort noch gelöscht wird)
          const st = it.hidden
            ? it.error ? { bg: "bg-red-600", icon: "alert" as const, tip: G.removeFailed } : { bg: "bg-amber-500", icon: "clock" as const, tip: G.removing }
            : it.inShop ? { bg: "bg-emerald-600", icon: "check" as const, tip: G.inShop }
              : it.error ? { bg: "bg-red-600", icon: "alert" as const, tip: G.failed } : { bg: "bg-amber-500", icon: "clock" as const, tip: G.waiting };
          return (
          <li key={it.key} className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-xl bg-brand-50 ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-lift">
            {it.preview
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={it.preview} alt="" className={`h-full w-full object-cover ${it.hidden ? "opacity-40 grayscale" : ""}`} />
              : <span className="flex h-full w-full items-center justify-center"><Icon name="camera" className="h-6 w-6 animate-pulse text-brand-400" /></span>}
            {it.key === mainKey && <span className="badge absolute start-1 top-1 bg-brand-600 px-1.5 py-0.5 text-[0.625rem] text-white shadow-card">{G.main}</span>}
            {it.hidden && <span className="badge absolute start-1 top-1 bg-slate-700 px-1.5 py-0.5 text-[0.625rem] text-white shadow-card">{G.offBadge}</span>}
            {it.fileId && linked && it.saved && (!it.hidden || (it.savedHidden && it.inShop)) && (
              <span title={st.tip} className={`absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full text-white shadow-card ${st.bg}`}>
                <Icon name={st.icon} className="h-3 w-3" />
              </span>
            )}
            {it.hidden && (
              <button type="button" onClick={() => patch(it.key, { hidden: false })}
                className="absolute inset-x-1.5 top-1/2 flex -translate-y-1/2 items-center justify-center gap-1 rounded-lg bg-white/95 px-1 py-1 text-center text-[0.6875rem] font-bold leading-tight text-brand-700 shadow-card transition hover:bg-white">
                <Icon name="upload" className="h-3.5 w-3.5 shrink-0" />{G.backToShop}
              </button>
            )}
            {!it.fileId && <span className="absolute inset-x-0 bottom-0 bg-white/85 py-0.5 text-center text-[0.625rem] font-semibold">{G.uploading}</span>}
            {it.fileId && (
              <div className="absolute inset-x-0 bottom-0 flex justify-between bg-gradient-to-t from-black/60 to-transparent p-1">
                <button type="button" onClick={() => move(it.key, -1)} disabled={k === 0} aria-label={G.earlier} title={G.earlier}
                  className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-ink shadow-card disabled:opacity-30"><Icon name="arrowLeft" className="h-3.5 w-3.5 rtl:rotate-180" /></button>
                <button type="button" onClick={() => remove(it)} aria-label={G.remove} title={G.remove}
                  className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-red-600 shadow-card"><Icon name="x" className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => move(it.key, 1)} disabled={k === shown.length - 1} aria-label={G.later} title={G.later}
                  className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-ink shadow-card disabled:opacity-30"><Icon name="arrowRight" className="h-3.5 w-3.5 rtl:rotate-180" /></button>
              </div>
            )}
          </li>
          );
        })}
        {free > 0 && (
          <li>
            <button type="button" onClick={() => input.current?.click()}
              className="group flex h-28 w-28 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-brand-200 bg-white text-brand-700 transition hover:-translate-y-0.5 hover:border-brand-400 hover:shadow-lift">
              <Icon name="plus" className="icon-pop h-6 w-6" />
              <span className="px-2 text-center text-xs font-semibold">{G.add}</span>
            </button>
          </li>
        )}
      </ul>
      <input ref={input} type="file" accept="image/*" multiple className="hidden" onChange={(e) => add(e.target.files)} />
      {/* nur die Liste geht mit dem Formular; fehlt das Feld (Shop nicht angehakt), bleibt die Galerie unverändert */}
      <input type="hidden" name={`gallery_${channel}`} value={value} />

      <div className="mt-3 flex flex-wrap gap-2">
        {stockImageId && !has(stockImageId) && free > 0 && (
          <button type="button" className="btn-ghost group text-sm" onClick={() => addIds([stockImageId])}><Icon name="box" className="h-4 w-4" />{G.fromStock}</button>
        )}
        {other && otherIds.some((id) => !has(id)) && free > 0 && (
          <button type="button" className="btn-ghost group text-sm" onClick={() => addIds(otherIds)}>
            <Icon name="copy" className="h-4 w-4" />{fill(G.fromOther, { shop: other.name })}
          </button>
        )}
        {linked && productId && items.length === 0 && (
          <button type="button" disabled={busy} className="btn-ghost group text-sm" onClick={adopt}><Icon name="download" className="h-4 w-4" />{G.fromShop}</button>
        )}
        {linked && productId && (failed > 0 || removeFailed > 0) && (
          <button type="button" disabled={busy} className="btn-ghost group text-sm" onClick={resend}><Icon name="upload" className="h-4 w-4" />{G.resend}</button>
        )}
      </div>

      {pending && (
        <div className="mt-3 flex animate-rise flex-wrap items-start justify-between gap-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900 ring-1 ring-amber-200">
          <ul className="min-w-0 space-y-0.5">
            <li className="font-bold">{G.pendTitle}</li>
            {pend.both > 0 && <li>• {fill(G.pendBoth, { n: pend.both })}</li>}
            {pend.system > 0 && <li>• {fill(G.pendSystem, { n: pend.system })}</li>}
            {pend.store > 0 && <li>• {fill(G.pendStore, { n: pend.store })}</li>}
            {pend.back > 0 && <li>• {fill(G.pendBack, { n: pend.back })}</li>}
            {pend.removed > 0 && <li>• {fill(G.pendRemoved, { n: pend.removed })}</li>}
          </ul>
          <button type="button" onClick={undo} className="btn-ghost group shrink-0 px-3 py-1.5 text-xs"><Icon name="history" className="h-3.5 w-3.5" />{G.undo}</button>
        </div>
      )}
      {linked && saved.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold">
          {inShop > 0 && <span className="text-emerald-700">{fill(G.statusOk, { n: inShop })}</span>}
          {waiting > 0 && <span className="text-amber-700">{fill(G.statusWaiting, { n: waiting })}</span>}
          {failed > 0 && <span className="text-red-700">{fill(G.statusFailed, { n: failed })}</span>}
          {onlyHere > 0 && <span className="text-slate-600">{fill(G.statusHidden, { n: onlyHere })}</span>}
          {removing > 0 && <span className="text-amber-700">{fill(G.statusRemoving, { n: removing })}</span>}
          {removeFailed > 0 && <span className="text-red-700">{fill(G.statusRemoveFailed, { n: removeFailed })}</span>}
        </p>
      )}
      {linked && unsaved && <p className="mt-2 text-xs font-semibold text-brand-700">{G.newOnSave}</p>}
      {!linked && shown.length > 0 && <p className="mt-3 text-xs text-ink-soft">{G.notLinked}</p>}
      {linked && items.length === 0 && <p className="mt-3 text-xs text-ink-soft">{G.linkedEmpty}</p>}
      {uploading && <p className="mt-2 text-xs font-semibold text-brand-700">{G.uploadingHint}</p>}
      {msg && <p className={`mt-2 animate-rise text-sm font-semibold ${msg.bad ? "text-red-700" : "text-emerald-700"}`}>{msg.text}</p>}
      {ask && <RemoveDialog t={t} shop={shop} item={ask} onPick={(w) => choose(ask, w)} onClose={() => setAsk(null)} />}
    </section>
  );
}

/**
 * Rückfrage beim Entfernen eines Fotos, das im Shop ist (Wunsch Inhaber 04.11.2026: „ميديش امر تاني يمسحها من المتجر“).
 * Standard-Fokus auf „Abbrechen“ – Enter löscht nichts.
 */
function RemoveDialog({ t, shop, item, onPick, onClose }: { t: Dict; shop: string; item: GItem; onPick: (w: Where) => void; onClose: () => void }) {
  const G = t.product.gallery;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", esc);
    cancelRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);

  const options: { w: Where; icon: "trash" | "box" | "globe"; title: string; hint: string; tone: string }[] = [
    { w: "both", icon: "trash", title: G.delBoth, hint: G.delBothHint, tone: "bg-red-50/70 text-red-800 ring-red-200 hover:bg-red-50" },
    { w: "system", icon: "box", title: G.delSystem, hint: fill(G.delSystemHint, { shop }), tone: "bg-white ring-black/10 hover:bg-brand-50" },
    { w: "store", icon: "globe", title: G.delStore, hint: G.delStoreHint, tone: "bg-white ring-black/10 hover:bg-brand-50" },
  ];

  // Über den ganzen Bildschirm: direkt in <body> (Karten mit Einblend-Animation wären sonst der Bezugsrahmen für „fixed“)
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="del-photo-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-4 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.preview} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover ring-1 ring-black/10" />
          <div className="min-w-0">
            <h2 id="del-photo-title" className="text-lg font-bold leading-snug">{G.askTitle}</h2>
            <p className="mt-0.5 text-sm text-ink-soft">{fill(G.askIntro, { shop })}</p>
          </div>
        </div>
        <div className="space-y-2">
          {options.map((o) => (
            <button key={o.w} type="button" onClick={() => onPick(o.w)} data-where={o.w}
              className={`group flex w-full items-start gap-3 rounded-xl p-3 text-start ring-1 transition hover:-translate-y-0.5 hover:shadow-lift ${o.tone}`}>
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white shadow-card"><Icon name={o.icon} className="icon-pop h-5 w-5" /></span>
              <span className="min-w-0">
                <span className="block font-bold">{o.title}</span>
                <span className="mt-0.5 block text-xs text-ink-soft">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs text-ink-soft"><Icon name="shield" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />{G.askSafe}</p>
        <button ref={cancelRef} type="button" onClick={onClose} className="btn-ghost mt-3 w-full">{t.common.cancel}</button>
      </div>
    </div>,
    document.body,
  );
}
