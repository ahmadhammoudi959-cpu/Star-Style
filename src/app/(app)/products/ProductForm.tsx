"use client";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { saveProduct } from "./actions";
import { ShopPushDialog, type Channel, type PushTarget } from "./ShopPushDialog";
import { galleryItem, ShopGallery, type GItem } from "./ShopGallery";
import { resolveStoreType, shopPriceCents, storeTypeLabel, type PushBlocker, type StoreType } from "@/lib/shopify/product-push-map";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { formatCents, parseMoney } from "@/lib/money";
import { PhotoPicker } from "@/components/PhotoPicker";
import { WeightInput } from "@/components/WeightInput";
import { parseWeight, type WeightUnit } from "@/lib/weight";
import { parseDims, productShipping, type ShippingClass } from "@/lib/shipping-class";
import type { Dict } from "@/i18n/de";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

type V = {
  key: string; id?: string; size: string; color: string; barcode: string; minStock: number; stockQty?: number; initialQty?: number; initialExpiry?: string;
  imageFileId?: string | null; weight?: string; weightUnit?: WeightUnit;
  /** Paketmaße in cm (Länge, Breite, Höhe) */
  pkgL?: string; pkgW?: string; pkgH?: string;
  /** eigene Preise dieser Größe/Farbe (netto, wie die Felder oben); leer = Preis des Artikels (Wunsch Inhaber 26.11.2026) */
  purchasePrice?: string; wholesalePrice?: string; retailPrice?: string;
};
export type ProductFormData = {
  id?: string; sku: string; nameDe: string; nameNl: string; descriptionDe: string; descriptionNl: string; category: string;
  supplierId: string; vatRateBp: number; purchasePrice: string; wholesalePrice: string; retailPrice: string;
  tracksExpiry: boolean; inBrandShop: boolean; inGeneralShop: boolean; imageFileId?: string | null;
  /** neuer Artikel aus einem Artikel von Hand (Bestell-Link): dessen Foto wird übernommen, wenn kein anderes gewählt wird */
  imageFrom?: string | null;
  /** Versandart: "" = automatisch aus Gewicht/Paketmaßen, PARCEL = immer Paket, FREIGHT = immer Spedition */
  shippingClass?: "" | ShippingClass;
  variants: Omit<V, "key">[];
  /** eigene Fotos je Shop (Galerie) */
  galleries?: Record<Channel, { fileId: string; mediaId: string; error: string; hidden: boolean }[]>;
};

const fmt = (c: number) => (c / 100).toFixed(2).replace(".", ",");
export const centsToInput = fmt;
/** hat diese Größe/Farbe eigene Preise? */
const hasOwnPrice = (v: Pick<V, "purchasePrice" | "wholesalePrice" | "retailPrice">) =>
  Boolean(v.purchasePrice?.trim() || v.wholesalePrice?.trim() || v.retailPrice?.trim());

type ShopFlags = { BRAND_SHOP: boolean; GENERAL_SHOP: boolean };
const CHANNELS: Channel[] = ["BRAND_SHOP", "GENERAL_SHOP"];

/** Rechte der angemeldeten Person (Wunsch Inhaber 12.11.2026) – geprüft wird trotzdem in der Action */
export type ProductRights = { edit: boolean; prices: boolean; cost: boolean; receive: boolean };
const ALL_RIGHTS: ProductRights = { edit: true, prices: true, cost: true, receive: true };

export function ProductForm({ t, initial, suppliers, categories, shopStatus, rights = ALL_RIGHTS }: {
  t: Dict; initial: ProductFormData; suppliers: { id: string; name: string }[]; categories: string[]; rights?: ProductRights;
  shopStatus?: {
    connected: ShopFlags; linked: ShopFlags; linkedVariantIds?: Record<Channel, string[]>;
    storeTypes?: Record<Channel, StoreType[]>; categoryMap?: Record<Channel, Record<string, string>>;
    pricesNet?: boolean;
  };
}) {
  const [state, action] = useActionState(saveProduct, undefined);
  // Rückfrage vor dem Hochladen in die Shops (Wunsch Inhaber): Antwort als kontrolliertes Hidden-Feld (siehe CLAUDE.md)
  const formRef = useRef<HTMLFormElement>(null);
  const intentRef = useRef<"" | "1" | "0">("");
  const [intent, setIntent] = useState<"" | "1" | "0">("");
  const [ask, setAsk] = useState<{ targets: PushTarget[]; blockers: PushBlocker[]; category: string } | null>(null);
  const [typeChoice, setTypeChoice] = useState<Record<Channel, string>>({ BRAND_SHOP: "", GENERAL_SHOP: "" });
  // nach einer Fehlermeldung beim nächsten Speichern wieder fragen
  useEffect(() => { intentRef.current = ""; setIntent(""); }, [state]);
  // eigene Fotos je Shop (Galerie) – bleiben auch nach einer Fehlermeldung stehen (Zustand, nicht Formularfeld)
  const [galleries, setGalleries] = useState<Record<Channel, GItem[]>>(() => ({
    BRAND_SHOP: (initial.galleries?.BRAND_SHOP ?? []).map(galleryItem), GENERAL_SHOP: (initial.galleries?.GENERAL_SHOP ?? []).map(galleryItem),
  }));
  const [waitUpload, setWaitUpload] = useState(false);
  const [variants, setVariants] = useState<V[]>(
    (initial.variants.length ? initial.variants : [{ size: "", color: "", barcode: "", minStock: 0 }]).map((v, i) => ({ ...v, key: String(i) })),
  );
  // Art.-Nr. = Barcode (Wunsch Inhaber): folgt dem ersten Barcode, solange man sie nicht selbst anders schreibt
  const firstBarcode = variants.find((v) => v.barcode)?.barcode ?? "";
  const [sku, setSku] = useState(initial.sku);
  const [skuFollows, setSkuFollows] = useState(() => !initial.sku || initial.sku === (initial.variants.find((v) => v.barcode)?.barcode ?? ""));
  useEffect(() => { if (skuFollows && firstBarcode) setSku(firstBarcode); }, [skuFollows, firstBarcode]);
  const [tracksExpiry, setTracksExpiry] = useState(initial.tracksExpiry);
  const [inShop, setInShop] = useState<ShopFlags>({ BRAND_SHOP: initial.inBrandShop, GENERAL_SHOP: initial.inGeneralShop });
  // im Shop schon verbunden → „im Shop ✓“; angehakt, Shop eingerichtet, noch nicht verbunden → wird beim Speichern angelegt
  const shopNote = (c: keyof ShopFlags) =>
    shopStatus?.linked[c] ? { text: t.product.inShop, tone: "ok" as const }
      : shopStatus?.connected[c] && inShop[c] ? { text: t.product.willCreate, tone: "info" as const } : undefined;
  const [prices, setPrices] = useState({ p: initial.purchasePrice, w: initial.wholesalePrice, r: initial.retailPrice });
  // Preis im Shop mit MwSt. unter Großhandels- und Einzelhandelspreis (Wunsch Inhaber 21.11.2026: damit niemand den
  // Bruttopreis ins Nettofeld schreibt und klar ist, dass auch Wiederverkäufer mit MwSt. sehen) – gleiche Rechnung wie
  // beim Senden an den Shop bzw. die Preisliste der Wiederverkäufer (runder Bruttopreis, `shopPriceCents`)
  const [vatBp, setVatBp] = useState(Number(initial.vatRateBp) || 1900);
  // Shops zeigen Nettopreise (Wunsch Inhaber 26.11.2026): dann steht unter dem Preis, dass die MwSt. erst an der Kasse dazukommt,
  // und der Betrag mit MwSt. als „an der Kasse“ (src/lib/shopify/tax-mode.ts)
  const net = Boolean(shopStatus?.pricesNet);
  const grossTpl = net ? t.product.shopGrossNet : t.product.shopGross;
  const gross = useMemo(() => {
    const of = (s: string) => { const net = parseMoney(s); return net != null && net > 0 ? shopPriceCents(net, vatBp, true) : null; };
    return { w: of(prices.w), r: of(prices.r) };
  }, [prices.w, prices.r, vatBp]);
  // Versandart (Wunsch Inhaber 19.11.2026): automatisch aus Gewicht und Paketmaßen – oder fest eingestellt
  const [shipMode, setShipMode] = useState<"" | ShippingClass>(initial.shippingClass ?? "");
  const shipping = useMemo(() => productShipping(shipMode || null, variants.map((x) => ({
    weightGrams: parseWeight(x.weight ?? "", x.weightUnit ?? "g") ?? null,
    dims: parseDims(x.pkgL ?? "", x.pkgW ?? "", x.pkgH ?? "") ?? null,
  }))), [shipMode, variants]);
  const margin = useMemo(() => {
    const p = parseMoney(prices.p) ?? 0;
    const calc = (s: string) => { const v = parseMoney(s) ?? 0; return v > 0 && p > 0 ? Math.round(((v - p) / v) * 100) : null; };
    return { w: calc(prices.w), r: calc(prices.r) };
  }, [prices]);
  // eigene Preise je Größe/Farbe (Wunsch Inhaber 26.11.2026: „ما عندنا خانات نحط فيها الاسعار للقياس الثاني“) – sichtbar, sobald es
  // mehrere Größen/Farben gibt oder eine schon eigene Preise hat (z. B. aus dem Shop-Import; vorher waren die unsichtbar)
  const showVariantPrices = variants.length > 1 || variants.some(hasOwnPrice);

  // nach einer Fehlermeldung: zuletzt eingegebene Texte statt der Ausgangswerte (React setzt das Formular zurück)
  const v = { ...initial, ...(state?.values ?? {}) } as ProductFormData & Record<string, unknown>;
  const known = state?.error ? (t.product as unknown as Record<string, unknown>)[state.error] : undefined;
  const errorText = state?.error
    ? typeof known === "string" ? known : state.error === "required" ? `${t.common.required}: ${state.field ?? ""}` : t.common.error
    : undefined;

  /** Beim Absenden: fehlt der Artikel (oder eine Größe/Farbe) in einem angehakten Shop? Dann erst fragen. */
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    // Fotos für den Shop werden noch hochgeladen → erst warten, sonst fehlen sie
    if (CHANNELS.some((c) => inShop[c] && galleries[c].some((g) => !g.fileId && !g.gone))) { e.preventDefault(); setWaitUpload(true); return; }
    setWaitUpload(false);
    if (intentRef.current) return; // Antwort aus der Rückfrage → normal speichern
    const category = String(new FormData(e.currentTarget).get("category") ?? "").trim();
    const blockers = new Set<PushBlocker>();
    const targets: PushTarget[] = [];
    for (const c of CHANNELS) {
      if (!inShop[c] || !shopStatus?.connected[c]) continue;
      const linkedIds = new Set(shopStatus.linkedVariantIds?.[c] ?? []);
      const missing = variants.filter((x) => !(x.id && linkedIds.has(x.id)));
      if (!missing.length) continue;
      const kind = missing.length === variants.length ? "new" : "add";
      const types = shopStatus.storeTypes?.[c] ?? [];
      const type = kind === "new" && category ? resolveStoreType(category, types, shopStatus.categoryMap?.[c] ?? {}) : null;
      const hit = type ? types.find((x) => x.type === type) : undefined;
      if (missing.some((x) => !x.barcode.trim())) blockers.add("noBarcode");
      if (kind === "new" && !category) blockers.add("noCategory");
      if ((parseMoney(prices.r) ?? 0) <= 0) blockers.add("noPrice");
      targets.push({ channel: c, kind, n: missing.length, placedIn: hit ? storeTypeLabel(hit) : type, needType: kind === "new" && Boolean(category) && !type && types.length > 0, types });
    }
    if (!targets.length) return;
    e.preventDefault();
    setAsk({ targets, blockers: [...blockers], category });
  }
  function answer(push: boolean) {
    intentRef.current = push ? "1" : "0";
    flushSync(() => { setIntent(intentRef.current); setAsk(null); });
    formRef.current?.requestSubmit();
  }

  const photoLabels = { add: t.product.addPhoto, change: t.product.changePhoto, remove: t.product.removePhoto, processing: t.product.photoProcessing, error: t.product.imageType };
  const upd = (key: string, patch: Partial<V>) => setVariants((vs) => vs.map((v) => (v.key === key ? { ...v, ...patch } : v)));

  return (
    <form ref={formRef} action={action} onSubmit={onSubmit} className="space-y-6">
      {!rights.edit && (
        <p className="flex items-center gap-2 rounded-xl bg-slate-100 px-4 py-3 text-sm font-semibold text-ink-soft ring-1 ring-black/5">
          <Icon name="lock" className="h-4 w-4 shrink-0" />{t.users.readOnly}
        </p>
      )}
      {/* ohne Recht „Artikel ändern“: alles nur ansehen (fieldset disabled sperrt alle Felder und Knöpfe darin) */}
      <fieldset disabled={!rights.edit} className="m-0 min-w-0 space-y-6 border-0 p-0">
      {initial.id && <input type="hidden" name="id" value={initial.id} />}
      <input type="hidden" name="shopPush" value={intent} />
      {CHANNELS.map((c) => <input key={c} type="hidden" name={`storeType_${c}`} value={intent === "1" ? typeChoice[c] : ""} />)}
      {ask && (
        <ShopPushDialog t={t} targets={ask.targets} blockers={ask.blockers} category={ask.category}
          typeChoice={typeChoice} onTypeChoice={(c, v) => setTypeChoice((x) => ({ ...x, [c]: v }))}
          onAnswer={answer} onBack={() => setAsk(null)} />
      )}
      <input type="hidden" name="variants" value={JSON.stringify(variants.map(({ key, stockQty: _s, imageFileId: _i, ...v }) => ({ ...v, ref: key })))} />
      <ErrorBox message={errorText ?? (waitUpload ? t.product.gallery.waitUpload : undefined)} />

      <section className="card flex flex-col gap-3 p-4 animate-rise sm:flex-row sm:items-center sm:gap-4 sm:p-5">
        <PhotoPicker name="image" initialId={initial.imageFileId} labels={photoLabels} size={132} />
        {initial.imageFrom && <input type="hidden" name="imageFrom" value={initial.imageFrom} />}
        <div>
          <h2 className="text-lg font-bold">{t.product.photo}</h2>
          <p className="max-w-md text-sm text-ink-soft">{t.product.photoHint}</p>
        </div>
      </section>

      {/* Handy: kurze Felder paarweise nebeneinander (Wunsch Inhaber 04.11.2026), lange über die ganze Breite */}
      <section className="card grid grid-cols-2 gap-3 p-4 animate-rise sm:p-5 md:gap-4">
        <Field label={t.product.sku} hint={t.product.skuHint}>
          <input name="sku" value={sku} required={!firstBarcode} className="input num" dir="ltr"
            onChange={(e) => { const v = e.target.value; setSku(v); setSkuFollows(!v.trim() || v.trim() === firstBarcode); }} />
        </Field>
        <Field label={t.product.category}>
          <input name="category" defaultValue={v.category} list="cats" className="input" />
          <datalist id="cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <Field label={t.product.nameDe} className="col-span-2 md:col-span-1"><input name="nameDe" defaultValue={v.nameDe} required className="input" dir="ltr" lang="de" /></Field>
        <Field label={t.product.nameNl} className="col-span-2 md:col-span-1"><input name="nameNl" defaultValue={v.nameNl} className="input" dir="ltr" lang="nl" /></Field>
        <Field label={t.product.descDe} className="col-span-2 md:col-span-1"><textarea name="descriptionDe" defaultValue={v.descriptionDe} rows={3} className="input" dir="ltr" lang="de" /></Field>
        <Field label={t.product.descNl} className="col-span-2 md:col-span-1"><textarea name="descriptionNl" defaultValue={v.descriptionNl} rows={3} className="input" dir="ltr" lang="nl" /></Field>
        <Field label={t.product.supplier}>
          <select name="supplierId" defaultValue={v.supplierId} className="input">
            <option value="">{t.common.none}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label={t.product.vat}>
          <select name="vatRateBp" defaultValue={String(v.vatRateBp)} onChange={(e) => setVatBp(Number(e.target.value))} disabled={!rights.prices} className="input disabled:opacity-60">
            <option value="1900">19 %</option>
            <option value="700">7 %</option>
          </select>
        </Field>
      </section>

      <section className="card grid grid-cols-2 gap-3 p-4 animate-rise sm:p-5 md:grid-cols-3 md:gap-4">
        {/* Einkaufspreis + Spanne nur mit Recht „Einkaufspreis sehen“; Verkaufspreise ändern nur mit Recht „Preise“.
            Gesperrte Felder werden nicht mitgeschickt → Platzhalter, der Server behält ohne Recht ohnehin den alten Wert */}
        {!rights.cost && <input type="hidden" name="purchasePrice" value="" />}
        {!rights.prices && (
          <>
            <input type="hidden" name="vatRateBp" value={String(v.vatRateBp)} />
            <input type="hidden" name="wholesalePrice" value={prices.w} />
            <input type="hidden" name="retailPrice" value={prices.r} />
          </>
        )}
        {rights.cost && (
          <Field label={t.product.purchase} hint={<SeenBy note={t.product.purchaseNote} />}>
            <MoneyInput name="purchasePrice" value={prices.p} onChange={(p) => setPrices((x) => ({ ...x, p }))} />
          </Field>
        )}
        <fieldset disabled={!rights.prices} className="contents">
          <Field label={t.product.wholesale} hint={
            <SeenBy note={net ? t.product.wholesaleNoteNet : t.product.wholesaleNote}>
              {gross.w != null && <ShopGross tpl={grossTpl} cents={gross.w} />}
              {rights.cost && margin.w != null && <span className="block">{`${t.product.margin}: ${margin.w} %`}</span>}
            </SeenBy>}>
            <MoneyInput name="wholesalePrice" value={prices.w} onChange={(w) => setPrices((x) => ({ ...x, w }))} />
          </Field>
          <Field label={t.product.retail} hint={
            <SeenBy note={net ? t.product.retailNoteNet : t.product.retailNote}>
              {gross.r != null && <ShopGross tpl={grossTpl} cents={gross.r} />}
              {rights.cost && margin.r != null && <span className="block">{`${t.product.margin}: ${margin.r} %`}</span>}
            </SeenBy>}>
            <MoneyInput name="retailPrice" value={prices.r} onChange={(r) => setPrices((x) => ({ ...x, r }))} />
          </Field>
        </fieldset>
        {showVariantPrices && (
          <p className="col-span-2 flex items-start gap-2 rounded-xl bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800 ring-1 ring-brand-100 md:col-span-3" data-base-prices-hint>
            <Icon name="tag" className="mt-px h-4 w-4 shrink-0 text-brand-600" />{t.product.basePricesHint}
          </p>
        )}
        <div className="col-span-2 flex flex-wrap items-center gap-x-6 gap-y-3 md:col-span-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <input type="checkbox" name="tracksExpiry" checked={tracksExpiry} onChange={(e) => setTracksExpiry(e.target.checked)} className="h-5 w-5 rounded accent-brand-600" />
            {t.product.tracksExpiry}
          </label>
          <span className="text-sm font-semibold text-ink-soft">{t.product.shops}:</span>
          <Check name="inBrandShop" label={t.product.brandShop} checked={inShop.BRAND_SHOP} onChange={(c) => setInShop((x) => ({ ...x, BRAND_SHOP: c }))} note={shopNote("BRAND_SHOP")} />
          <Check name="inGeneralShop" label={t.product.generalShop} checked={inShop.GENERAL_SHOP} onChange={(c) => setInShop((x) => ({ ...x, GENERAL_SHOP: c }))} note={shopNote("GENERAL_SHOP")} />
          {(shopStatus?.connected.BRAND_SHOP || shopStatus?.connected.GENERAL_SHOP) && (
            <p className="w-full text-xs text-ink-soft">{t.product.shopsHint}</p>
          )}
        </div>
      </section>

      {/* eigene Fotos je angehaktem Shop (Wunsch Inhaber: im Lager ein Foto, im Shop mehrere) */}
      {CHANNELS.filter((c) => inShop[c]).map((c) => {
        const o: Channel = c === "BRAND_SHOP" ? "GENERAL_SHOP" : "BRAND_SHOP";
        return (
          <ShopGallery key={c} t={t} channel={c} items={galleries[c]} linked={Boolean(shopStatus?.linked[c])} productId={initial.id}
            stockImageId={initial.imageFileId} other={inShop[o] ? { name: t.shop.names[o], items: galleries[o] } : undefined}
            onChange={(f) => setGalleries((g) => ({ ...g, [c]: f(g[c]) }))} />
        );
      })}

      <section className="card p-5 animate-rise">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">{t.product.variants}</h2>
            <p className="text-xs text-ink-soft">{t.product.noVariantsHint}</p>
            {rights.receive && variants.some((v) => !v.id) && <p className="mt-1 text-xs font-semibold text-brand-700">{t.product.initialHint}</p>}
          </div>
          <button type="button" className="btn-ghost group"
            onClick={() => setVariants((vs) => [...vs, { key: crypto.randomUUID(), size: "", color: "", barcode: "", minStock: 0, weight: "", weightUnit: vs[vs.length - 1]?.weightUnit ?? "g" }])}>
            <Icon name="plus" className="h-4 w-4" />{t.product.addVariant}
          </button>
        </div>
        <div className="space-y-3">
          {variants.map((v) => (
            <div key={v.key} className="grid animate-rise grid-cols-2 gap-3 rounded-xl bg-brand-50/50 p-3 ring-1 ring-black/5 lg:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,0.7fr)_auto]">
              <div className="col-span-2 flex items-end lg:col-span-1" title={t.product.variantPhoto}>
                <PhotoPicker name={`vimg_${v.key}`} initialId={v.imageFileId} labels={photoLabels} size={44} compact />
              </div>
              <Field label={t.product.size}><input className="input" value={v.size} onChange={(e) => upd(v.key, { size: e.target.value })} /></Field>
              <Field label={t.product.color}><input className="input" value={v.color} onChange={(e) => upd(v.key, { color: e.target.value })} /></Field>
              <Field label={t.product.barcode}><input className="input num" dir="ltr" inputMode="numeric" value={v.barcode} onChange={(e) => upd(v.key, { barcode: e.target.value.trim() })} /></Field>
              <Field label={t.product.weight}>
                <WeightInput value={v.weight ?? ""} unit={v.weightUnit ?? "g"} unitLabel={t.product.weightUnit} onChange={(w) => upd(v.key, w)} />
              </Field>
              <Field label={t.product.minStock}><input className="input num" type="number" min={0} value={v.minStock} onChange={(e) => upd(v.key, { minStock: Math.max(0, Number(e.target.value) || 0) })} /></Field>
              <div className="flex items-end justify-end gap-2">
                {v.stockQty != null && <span className="badge mb-3 bg-white text-ink-soft ring-1 ring-black/5">{t.product.stock}: {v.stockQty}</span>}
                <button type="button" aria-label={t.common.remove} disabled={variants.length === 1 || (v.stockQty ?? 0) > 0}
                  title={(v.stockQty ?? 0) > 0 ? t.product.stock + " > 0" : undefined}
                  className="btn-danger group h-11 w-11 p-0" onClick={() => setVariants((vs) => vs.filter((x) => x.key !== v.key))}>
                  <Icon name="trash" className="h-4 w-4" />
                </button>
              </div>
              {showVariantPrices && (
                <div className="col-span-2 lg:col-span-7">
                  <VariantPrices t={t} v={v} base={prices} vatBp={vatBp} rights={rights} grossTpl={grossTpl} onChange={(patch) => upd(v.key, patch)} />
                </div>
              )}
              <div className="col-span-2 lg:col-span-7">
                <PackageInput t={t} v={v} onChange={(patch) => upd(v.key, patch)} />
              </div>
              {!v.id && rights.receive && (
                <div className="col-span-2 grid grid-cols-2 gap-3 md:grid-cols-4 lg:col-span-7">
                  <Field label={t.product.initialQty}>
                    <input className="input num border-brand-300 bg-white" type="number" min={0} inputMode="numeric" placeholder="0"
                      value={v.initialQty || ""} onChange={(e) => upd(v.key, { initialQty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                  </Field>
                  {tracksExpiry && (v.initialQty ?? 0) > 0 && (
                    <Field label={t.product.initialExpiry}>
                      <input className="input" type="date" value={v.initialExpiry ?? ""} onChange={(e) => upd(v.key, { initialExpiry: e.target.value })} />
                    </Field>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Versandart: Paket mit GLS oder Spedition (Möbel) – das System setzt dafür im Shop das Merkmal „spedition“ */}
      <section className="card space-y-3 p-4 animate-rise sm:p-5">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="truck" className="h-5 w-5 text-brand-600" />{t.product.shipTitle}</h2>
        <div className="grid gap-3 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:items-end">
          <Field label={t.product.shipMode}>
            <select name="shippingClass" value={shipMode} onChange={(e) => setShipMode(e.target.value as "" | ShippingClass)} className="input">
              <option value="">{t.product.shipAuto}</option>
              <option value="PARCEL">{t.product.shipParcel}</option>
              <option value="FREIGHT">{t.product.shipFreight}</option>
            </select>
          </Field>
          <p className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 ${shipping.cls === "FREIGHT" ? "bg-amber-50 text-amber-900 ring-amber-200" : "bg-emerald-50 text-emerald-800 ring-emerald-100"}`}>
            <Icon name={shipping.cls === "FREIGHT" ? "truck" : "box"} className="mt-px h-4 w-4 shrink-0" />
            <span>
              {shipping.cls === "FREIGHT" ? t.product.shipIsFreight : t.product.shipIsParcel}
              {!shipping.auto && <span className="font-normal"> ({t.product.shipFixed})</span>}
              {shipping.auto && shipping.reasons.length > 0 && <span className="font-normal"> – {fill(t.product.shipBecause, { r: shipping.reasons.map((r) => t.product.shipReasons[r]).join(t.product.shipSep) })}</span>}
            </span>
          </p>
        </div>
        {shipping.auto && !shipping.known && <p className="text-xs font-semibold text-amber-800">{t.product.shipUnknown}</p>}
        {!shipping.auto && shipping.cls === "PARCEL" && shipping.reasons.length > 0 && (
          <p className="text-xs font-semibold text-red-600">{fill(t.product.shipWarn, { r: shipping.reasons.map((r) => t.product.shipReasons[r]).join(t.product.shipSep) })}</p>
        )}
        <p className="text-xs text-ink-soft">{t.product.shipHint}</p>
      </section>

      </fieldset>
      {rights.edit && (
        <div className="sticky bottom-20 z-10 flex justify-end lg:bottom-4">
          <SubmitButton className="btn-primary px-8 py-3 text-base shadow-lift">{t.common.save}</SubmitButton>
        </div>
      )}
    </form>
  );
}

function MoneyInput({ name, value, onChange, placeholder = "0,00", label }: {
  name?: string; value: string; onChange: (v: string) => void; placeholder?: string; label?: string;
}) {
  const bad = value.trim() !== "" && parseMoney(value) == null;
  return (
    <div className="relative" dir="ltr">
      <input name={name} value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" dir="ltr" aria-label={label}
        className={`input num pe-9 placeholder:text-ink-soft/60 disabled:bg-slate-50 disabled:opacity-70 ${bad ? "border-red-400 ring-4 ring-red-100" : ""}`} placeholder={placeholder} />
      <span className="pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-ink-soft">€</span>
    </div>
  );
}

/**
 * Eigene Preise einer Größe/Farbe (Wunsch Inhaber 26.11.2026). Leer = Preis von oben (grau als Platzhalter). Darunter steht,
 * was im Shop wirklich gilt (mit MwSt., gleiche Rechnung wie beim Senden) – so sieht man je Größe den Preis im Shop.
 * Einkaufspreis nur mit Recht „Einkaufspreis“, Verkaufspreise ändern nur mit Recht „Preise“ (der Server prüft es noch einmal).
 */
function VariantPrices({ t, v, base, vatBp, rights, grossTpl, onChange }: {
  t: Dict; v: V; base: { p: string; w: string; r: string }; vatBp: number; rights: ProductRights; grossTpl: string; onChange: (patch: Partial<V>) => void;
}) {
  const own = hasOwnPrice(v);
  const eff = (mine: string | undefined, fallback: string) => { const s = mine?.trim() ? mine : fallback; const c = parseMoney(s); return c != null && c > 0 ? c : null; };
  const p = eff(v.purchasePrice, base.p), w = eff(v.wholesalePrice, base.w), r = eff(v.retailPrice, base.r);
  const margin = (sale: number | null) => (sale && p ? Math.round(((sale - p) / sale) * 100) : null);
  const note = (sale: number | null) => (
    <>
      {sale != null && <ShopGross tpl={grossTpl} cents={shopPriceCents(sale, vatBp, true)} />}
      {rights.cost && margin(sale) != null && <span className="block">{`${t.product.margin}: ${margin(sale)} %`}</span>}
    </>
  );
  const name = [v.size, v.color].filter(Boolean).join(" · ");
  return (
    <div className={`rounded-xl p-3 ring-1 ${own ? "bg-amber-50/70 ring-amber-200" : "bg-white/70 ring-black/5"}`} data-variant-prices={own ? "own" : "base"}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-bold">
        <Icon name="tag" className="h-4 w-4 text-brand-600" />
        <span>{t.product.vPrices}{name && <span className="font-semibold text-ink-soft"> (<bdi dir="auto">{name}</bdi>)</span>}</span>
        {own
          ? <span className="badge bg-amber-100 text-amber-900 ring-1 ring-amber-200">{t.product.vOwn}</span>
          : <span className="font-normal text-ink-soft">{t.product.vSame}</span>}
        {own && (rights.prices || rights.cost) && (
          <button type="button" title={t.product.vResetHint} className="ms-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 font-semibold text-brand-700 hover:bg-white"
            onClick={() => onChange({ ...(rights.cost ? { purchasePrice: "" } : {}), ...(rights.prices ? { wholesalePrice: "", retailPrice: "" } : {}) })} data-variant-prices-reset>
            <Icon name="undo" className="h-3.5 w-3.5" />{t.product.vReset}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {rights.cost && (
          <Field label={t.product.purchase}>
            <MoneyInput value={v.purchasePrice ?? ""} placeholder={base.p.trim() || "0,00"} label={`${t.product.purchase} ${name}`} onChange={(x) => onChange({ purchasePrice: x })} />
          </Field>
        )}
        <fieldset disabled={!rights.prices} className="contents">
          <Field label={t.product.wholesale} hint={note(w)}>
            <MoneyInput value={v.wholesalePrice ?? ""} placeholder={base.w.trim() || "0,00"} label={`${t.product.wholesale} ${name}`} onChange={(x) => onChange({ wholesalePrice: x })} />
          </Field>
          <Field label={t.product.retail} hint={note(r)}>
            <MoneyInput value={v.retailPrice ?? ""} placeholder={base.r.trim() || "0,00"} label={`${t.product.retail} ${name}`} onChange={(x) => onChange({ retailPrice: x })} />
          </Field>
        </fieldset>
      </div>
    </div>
  );
}

/** Hinweis unter einem Preisfeld: wer diesen Preis sieht (Wunsch Inhaber 21.11.2026 – die Mitarbeiter verwechselten
 *  Großhandels- und Shop-Preis), darunter z. B. Shop-Preis mit MwSt. und Marge */
function SeenBy({ note, children }: { note: string; children?: React.ReactNode }) {
  return (
    <>
      <span className="flex items-start gap-1"><Icon name="eye" className="mt-px h-3.5 w-3.5 shrink-0 text-brand-600" />{note}</span>
      {children}
    </>
  );
}

/** „Im Shop mit MwSt.: 23,80 €“ – der Betrag als `.num` (in RTL von links nach rechts) */
function ShopGross({ tpl, cents }: { tpl: string; cents: number }) {
  const [before, after = ""] = tpl.split("{price}");
  return <span className="block">{before}<span className="num font-semibold text-ink">{formatCents(cents)}</span>{after}</span>;
}

function Check({ name, label, defaultChecked, checked, onChange, note }: {
  name: string; label: string; defaultChecked?: boolean; checked?: boolean; onChange?: (checked: boolean) => void;
  note?: { text: string; tone: "ok" | "info" };
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
      <input type="checkbox" name={name} {...(checked !== undefined ? { checked, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange?.(e.target.checked) } : { defaultChecked })}
        className="h-5 w-5 rounded accent-brand-600" />
      {label}
      {note && <span className={`badge ring-1 ${note.tone === "ok" ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : "bg-brand-50 text-brand-700 ring-brand-100"}`}>{note.text}</span>}
    </label>
  );
}

/** Paketmaße (Karton) in cm: Länge × Breite × Höhe – Komma oder Punkt; alle leer = unbekannt */
function PackageInput({ t, v, onChange }: { t: Dict; v: V; onChange: (patch: Partial<V>) => void }) {
  const l = v.pkgL ?? "", w = v.pkgW ?? "", h = v.pkgH ?? "";
  const bad = parseDims(l, w, h) === undefined;
  const cls = `input num min-w-0 flex-1 px-2 text-center ${bad ? "border-red-400 ring-4 ring-red-100" : ""}`;
  return (
    <div>
      <div className="mb-1 text-xs font-bold text-ink-soft">{t.product.pkg}</div>
      <div className="flex max-w-md items-center gap-1.5" dir="ltr">
        <input aria-label={t.product.pkgL} placeholder={t.product.pkgL} inputMode="decimal" value={l} onChange={(e) => onChange({ pkgL: e.target.value })} className={cls} />
        <span className="text-ink-soft">×</span>
        <input aria-label={t.product.pkgW} placeholder={t.product.pkgW} inputMode="decimal" value={w} onChange={(e) => onChange({ pkgW: e.target.value })} className={cls} />
        <span className="text-ink-soft">×</span>
        <input aria-label={t.product.pkgH} placeholder={t.product.pkgH} inputMode="decimal" value={h} onChange={(e) => onChange({ pkgH: e.target.value })} className={cls} />
        <span className="text-xs text-ink-soft">cm</span>
      </div>
      {bad && <p className="mt-1 text-xs font-semibold text-red-600">{t.product.pkgInvalid}</p>}
    </div>
  );
}
