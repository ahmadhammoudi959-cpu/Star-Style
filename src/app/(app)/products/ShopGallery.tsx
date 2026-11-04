"use client";
import { useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { shrinkImage } from "@/lib/image-client";
import { GALLERY_MAX } from "@/lib/shopify/gallery-map";
import { adoptShopPhotos, resendShopPhotos, uploadShopPhoto } from "./actions";
import type { Dict } from "@/i18n/de";

export type Channel = "BRAND_SHOP" | "GENERAL_SHOP";
/** Ein Foto der Shop-Galerie im Formular. fileId null = wird gerade hochgeladen; saved = so schon gespeichert (sonst neu im Formular). */
export type GItem = { key: string; fileId: string | null; preview: string; inShop: boolean; error: string; saved: boolean };

export const galleryItem = (g: { fileId: string; mediaId: string; error: string }): GItem =>
  ({ key: g.fileId, fileId: g.fileId, preview: `/api/files/${g.fileId}`, inShop: Boolean(g.mediaId), error: g.error, saved: true });

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/**
 * Eigene Fotos für einen Shop (Wunsch Inhaber 04.11.2026): bis zu 10, das erste ist das Titelbild, Reihenfolge mit Pfeilen.
 * Fotos werden beim Auswählen verkleinert und sofort gespeichert; das Formular schickt nur die Liste (`gallery_<Kanal>`).
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
  const ids = items.filter((i) => i.fileId).map((i) => i.fileId!);
  const has = (id: string) => items.some((i) => i.fileId === id);
  const free = GALLERY_MAX - items.length;

  async function add(files: FileList | null) {
    if (!files?.length) return;
    const list = [...files].slice(0, Math.max(0, free));
    if (files.length > free) setMsg({ text: fill(G.full, { n: GALLERY_MAX }), bad: true }); else setMsg(null);
    // Platzhalter sofort, dann nacheinander verkleinern und speichern
    const keys = list.map(() => crypto.randomUUID());
    onChange((xs) => [...xs, ...keys.map((key) => ({ key, fileId: null, preview: "", inShop: false, error: "", saved: false }))]);
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

  const move = (k: number, d: -1 | 1) => onChange((xs) => {
    const j = k + d;
    if (j < 0 || j >= xs.length) return xs;
    const out = [...xs];
    [out[k], out[j]] = [out[j], out[k]];
    return out;
  });
  const remove = (key: string) => onChange((xs) => xs.filter((x) => x.key !== key));
  const addIds = (list: string[]) => onChange((xs) => {
    const room = GALLERY_MAX - xs.length;
    const fresh = list.filter((id) => !xs.some((x) => x.fileId === id)).slice(0, Math.max(0, room));
    return [...xs, ...fresh.map((id) => ({ key: crypto.randomUUID(), fileId: id, preview: `/api/files/${id}`, inShop: false, error: "", saved: false }))];
  });

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

  const uploading = items.some((i) => !i.fileId);
  const saved = items.filter((i) => i.fileId && i.saved);
  const fresh = items.some((i) => i.fileId && !i.saved);
  const inShop = saved.filter((i) => i.inShop).length;
  const failed = saved.filter((i) => !i.inShop && i.error).length;
  const waiting = saved.length - inShop - failed;

  return (
    <section className="card animate-rise p-5">
      <div className="mb-3 flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="camera" className="icon-pop h-5 w-5 text-brand-600" />{fill(G.title, { shop })}</h2>
        <p className="max-w-2xl text-sm text-ink-soft">{G.hint}</p>
      </div>

      <ul className="flex flex-wrap gap-3">
        {items.map((it, k) => (
          <li key={it.key} className="group relative h-28 w-28 shrink-0 overflow-hidden rounded-xl bg-brand-50 ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-lift">
            {it.preview
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={it.preview} alt="" className="h-full w-full object-cover" />
              : <span className="flex h-full w-full items-center justify-center"><Icon name="camera" className="h-6 w-6 animate-pulse text-brand-400" /></span>}
            {k === 0 && <span className="badge absolute start-1 top-1 bg-brand-600 px-1.5 py-0.5 text-[0.625rem] text-white shadow-card">{G.main}</span>}
            {it.fileId && linked && it.saved && (
              <span title={it.inShop ? G.inShop : it.error ? G.failed : G.waiting}
                className={`absolute end-1 top-1 grid h-5 w-5 place-items-center rounded-full text-white shadow-card ${it.inShop ? "bg-emerald-600" : it.error ? "bg-red-600" : "bg-amber-500"}`}>
                <Icon name={it.inShop ? "check" : it.error ? "alert" : "clock"} className="h-3 w-3" />
              </span>
            )}
            {!it.fileId && <span className="absolute inset-x-0 bottom-0 bg-white/85 py-0.5 text-center text-[0.625rem] font-semibold">{G.uploading}</span>}
            {it.fileId && (
              <div className="absolute inset-x-0 bottom-0 flex justify-between bg-gradient-to-t from-black/60 to-transparent p-1">
                <button type="button" onClick={() => move(k, -1)} disabled={k === 0} aria-label={G.earlier} title={G.earlier}
                  className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-ink shadow-card disabled:opacity-30"><Icon name="arrowLeft" className="h-3.5 w-3.5 rtl:rotate-180" /></button>
                <button type="button" onClick={() => remove(it.key)} aria-label={G.remove} title={G.remove}
                  className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-red-600 shadow-card"><Icon name="x" className="h-3.5 w-3.5" /></button>
                <button type="button" onClick={() => move(k, 1)} disabled={k === items.length - 1} aria-label={G.later} title={G.later}
                  className="grid h-7 w-7 place-items-center rounded-lg bg-white/90 text-ink shadow-card disabled:opacity-30"><Icon name="arrowRight" className="h-3.5 w-3.5 rtl:rotate-180" /></button>
              </div>
            )}
          </li>
        ))}
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
      <input type="hidden" name={`gallery_${channel}`} value={JSON.stringify(ids)} />

      <div className="mt-3 flex flex-wrap gap-2">
        {stockImageId && !has(stockImageId) && free > 0 && (
          <button type="button" className="btn-ghost group text-sm" onClick={() => addIds([stockImageId])}><Icon name="box" className="h-4 w-4" />{G.fromStock}</button>
        )}
        {other && other.items.some((x) => x.fileId && !has(x.fileId)) && free > 0 && (
          <button type="button" className="btn-ghost group text-sm" onClick={() => addIds(other.items.filter((x) => x.fileId).map((x) => x.fileId!))}>
            <Icon name="copy" className="h-4 w-4" />{fill(G.fromOther, { shop: other.name })}
          </button>
        )}
        {linked && productId && items.length === 0 && (
          <button type="button" disabled={busy} className="btn-ghost group text-sm" onClick={adopt}><Icon name="download" className="h-4 w-4" />{G.fromShop}</button>
        )}
        {linked && productId && failed > 0 && (
          <button type="button" disabled={busy} className="btn-ghost group text-sm" onClick={resend}><Icon name="upload" className="h-4 w-4" />{G.resend}</button>
        )}
      </div>

      {linked && saved.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs font-semibold">
          {inShop > 0 && <span className="text-emerald-700">{fill(G.statusOk, { n: inShop })}</span>}
          {waiting > 0 && <span className="text-amber-700">{fill(G.statusWaiting, { n: waiting })}</span>}
          {failed > 0 && <span className="text-red-700">{fill(G.statusFailed, { n: failed })}</span>}
        </p>
      )}
      {linked && fresh && <p className="mt-2 text-xs font-semibold text-brand-700">{G.newOnSave}</p>}
      {!linked && items.length > 0 && <p className="mt-3 text-xs text-ink-soft">{G.notLinked}</p>}
      {linked && items.length === 0 && <p className="mt-3 text-xs text-ink-soft">{G.linkedEmpty}</p>}
      {uploading && <p className="mt-2 text-xs font-semibold text-brand-700">{G.uploadingHint}</p>}
      {msg && <p className={`mt-2 animate-rise text-sm font-semibold ${msg.bad ? "text-red-700" : "text-emerald-700"}`}>{msg.text}</p>}
    </section>
  );
}
