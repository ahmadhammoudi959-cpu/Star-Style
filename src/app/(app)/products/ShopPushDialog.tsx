"use client";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { storeTypeLabel, type PushBlocker, type StoreType } from "@/lib/shopify/product-push-map";
import type { Dict } from "@/i18n/de";

export type Channel = "BRAND_SHOP" | "GENERAL_SHOP";
/** Was beim Hochladen in einem Shop passieren würde: neues Produkt oder n Größen/Farben für das vorhandene */
export type PushTarget = {
  channel: Channel; kind: "new" | "add"; n: number;
  placedIn: string | null;   // Anzeige-Name der Shop-Kategorie (neues Produkt)
  needType: boolean;         // unsere Kategorie gibt es im Shop nicht → Shop-Kategorie wählen
  types: StoreType[];
};

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/**
 * Rückfrage vor dem Hochladen (Wunsch Inhaber 03.11.2026): „Echter Artikel?“ – ja → speichern und hochladen, nein → nur speichern.
 * Fehlt noch etwas (Barcode, Kategorie, Preis), kann nur gespeichert werden; die Liste sagt, was fehlt.
 */
export function ShopPushDialog({ t, targets, blockers, category, typeChoice, onTypeChoice, onAnswer, onBack }: {
  t: Dict; targets: PushTarget[]; blockers: PushBlocker[]; category: string;
  typeChoice: Record<Channel, string>; onTypeChoice: (c: Channel, type: string) => void;
  onAnswer: (push: boolean) => void; onBack: () => void;
}) {
  const a = t.product.pushAsk;
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const yesRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") backRef.current(); };
    document.addEventListener("keydown", esc);
    yesRef.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);

  const missingType = targets.some((x) => x.needType && !typeChoice[x.channel]);
  const hard = blockers.filter((b) => b !== "unknownCategory");
  const canPush = hard.length === 0 && !missingType;
  const shown: PushBlocker[] = [...hard, ...(missingType ? ["unknownCategory" as const] : [])];

  // Über den ganzen Bildschirm: direkt in <body> (Karten mit Einblend-Animation wären sonst der Bezugsrahmen für „fixed“)
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 p-0 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="push-ask-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) backRef.current(); }}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="globe" className="icon-pop h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 id="push-ask-title" className="text-lg font-bold leading-snug">{a.title}</h2>
            <p className="mt-1 text-sm text-ink-soft">{a.intro}</p>
          </div>
        </div>

        <ul className="space-y-2">
          {targets.map((x) => (
            <li key={x.channel} className="rounded-xl bg-brand-50/60 p-3 text-sm ring-1 ring-brand-100">
              <div className="font-semibold">{fill(x.kind === "new" ? a.newIn : a.addIn, { shop: t.shop.names[x.channel], n: x.n })}</div>
              {x.kind === "new" && x.placedIn && <div className="mt-0.5 text-xs text-ink-soft">{fill(a.placedIn, { c: x.placedIn })}</div>}
              {x.needType && (
                <label className="mt-2 block">
                  <span className="label">{fill(a.chooseType, { shop: t.shop.names[x.channel] })}</span>
                  <select className="input" value={typeChoice[x.channel]} onChange={(e) => onTypeChoice(x.channel, e.target.value)}>
                    <option value="">{a.choose}</option>
                    {x.types.map((ty) => <option key={ty.type} value={ty.type}>{storeTypeLabel(ty)}{ty.collection && ty.collection !== ty.type ? ` (${ty.type})` : ""}</option>)}
                  </select>
                  <span className="mt-1 block text-xs text-ink-soft">{fill(a.chooseTypeHint, { c: category })}</span>
                </label>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-start gap-2 text-xs text-ink-soft"><Icon name="link" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />{a.noDuplicate}</p>

        {shown.length > 0 && (
          <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
            <div className="flex items-center gap-2 font-semibold"><Icon name="alert" className="h-4 w-4" />{a.missingTitle}</div>
            <ul className="mt-1 list-disc space-y-0.5 ps-6">{shown.map((b) => <li key={b}>{a.blockers[b]}</li>)}</ul>
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <button ref={yesRef} type="button" disabled={!canPush} onClick={() => onAnswer(true)} className="btn-primary group w-full py-3 text-base">
            <Icon name="check" className="h-5 w-5" />{a.yes}
          </button>
          <button type="button" onClick={() => onAnswer(false)} className="btn-ghost group w-full">{a.no}</button>
          <button type="button" onClick={onBack} className="text-sm font-semibold text-ink-soft hover:text-brand-700">{a.back}</button>
        </div>
        <p className="mt-3 text-xs text-ink-soft">{a.laterHint}</p>
      </div>
    </div>,
    document.body,
  );
}
