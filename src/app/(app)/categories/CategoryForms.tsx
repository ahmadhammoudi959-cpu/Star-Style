"use client";
import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ErrorBox, Field, SubmitButton } from "@/components/Forms";
import { Icon } from "@/components/Icon";
import { ProductPickerBar } from "@/components/ProductPickerBar";
import type { PickerOption } from "@/components/VariantPicker";
import type { StoreResultCode } from "@/lib/shopify/category-map";
import { addToStoreAction, createCategoryAction, deleteCategoryAction, moveProductAction, type MoveState } from "./actions";
import type { Dict } from "@/i18n/de";

type Channel = "BRAND_SHOP" | "GENERAL_SHOP";
export type StoreNavInfo = { channel: Channel; access: boolean | null; groups: { id: string; title: string }[]; adminUrl: string };

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const errText = (t: Dict, code?: string) => code ? ((t.cat.errors as Record<string, string>)[code] ?? t.cat.errors.error) : undefined;

/** Hinweise nach „im Shop anlegen“ (grün = gut, gelb = Hinweis, rot = nicht geklappt) */
export function StoreResultNotes({ t, results, navs }: { t: Dict; results: StoreResultCode[]; navs?: StoreNavInfo[] }) {
  if (!results.length) return null;
  const R = t.cat.result;
  const notes: { text: string; tone: "ok" | "warn" | "bad"; link?: string }[] = [];
  for (const r of results) {
    const shop = t.shop.names[r.channel];
    notes.push({ text: fill(R[r.outcome], { shop }), tone: r.outcome === "failed" ? "bad" : r.outcome === "created" || r.outcome === "exists" ? "ok" : "warn" });
    if (r.menu === "added") notes.push({ text: fill(R.menuAdded, { shop }), tone: "ok" });
    if (r.menu === "exists") notes.push({ text: fill(R.menuExists, { shop }), tone: "ok" });
    if (r.menu === "noAccess") notes.push({ text: fill(R.menuNoAccess, { shop }), tone: "warn", link: navs?.find((n) => n.channel === r.channel)?.adminUrl });
    if (r.menu === "failed") notes.push({ text: fill(R.menuFailed, { shop }), tone: "warn", link: navs?.find((n) => n.channel === r.channel)?.adminUrl });
  }
  const tone = { ok: "bg-emerald-50 text-emerald-800 ring-emerald-100", warn: "bg-amber-50 text-amber-900 ring-amber-200", bad: "bg-red-50 text-red-800 ring-red-200" };
  return (
    <div className="mb-4 space-y-2">
      {notes.map((n, i) => (
        <div key={i} className={`flex animate-rise flex-wrap items-start gap-x-2 gap-y-1 rounded-xl px-4 py-3 text-sm font-semibold ring-1 ${tone[n.tone]}`}>
          <Icon name={n.tone === "ok" ? "check" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 basis-48">{n.text}</span>
          {n.link && <a href={n.link} target="_blank" rel="noopener noreferrer" className="shrink-0 underline">{t.cat.openNav} ↗</a>}
        </div>
      ))}
    </div>
  );
}

/** Auswahl „Im Shop-Menü unter …“ – nur, wenn die Shop-App das Menü lesen darf */
function MenuSelect({ t, nav, name, value, onChange }: { t: Dict; nav: StoreNavInfo; name?: string; value?: string; onChange?: (v: string) => void }) {
  if (!nav.access || !nav.groups.length) return null;
  return (
    <label className="block">
      <span className="label">{t.cat.menuGroup}</span>
      <select name={name} className="input" {...(onChange ? { value, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value) } : { defaultValue: "-" })}>
        <option value="-">{t.cat.menuNone}</option>
        {nav.groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
      </select>
    </label>
  );
}

/** Hinweis, wenn die Shop-App das Menü nicht ändern darf – mit Link zur Navigation im Shopify-Admin */
export function NoMenuAccess({ t, navs }: { t: Dict; navs: StoreNavInfo[] }) {
  const missing = navs.filter((n) => n.access === false);
  if (!missing.length) return null;
  return (
    <div className="space-y-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
      <p className="flex items-start gap-2"><Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0">{t.cat.noMenuAccess}</span></p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 ps-6">
        {missing.map((n) => (
          <a key={n.channel} href={n.adminUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline">{t.cat.openNav} ({t.shop.names[n.channel]}) ↗</a>
        ))}
      </div>
    </div>
  );
}

/** Neue Kategorie: Name, in welchen Shops gleich mit anlegen (Standard: alle eingerichteten), ggf. Menü-Gruppe */
export function NewCategory({ t, navs }: { t: Dict; navs: StoreNavInfo[] }) {
  const [state, action] = useActionState(createCategoryAction, undefined);
  const [inStore, setInStore] = useState<Record<string, boolean>>(() => Object.fromEntries(navs.map((n) => [n.channel, true])));
  return (
    <form action={action} className="card relative z-10 mb-6 space-y-4 p-5 animate-rise">
      <h2 className="flex items-center gap-2 text-lg font-bold"><Icon name="plus" className="icon-pop h-5 w-5 text-brand-600" />{t.cat.new}</h2>
      <ErrorBox message={errText(t, state?.error)} />
      <Field label={t.cat.name} hint={t.cat.nameHint}>
        <input name="name" required maxLength={100} defaultValue={state?.values?.name ?? ""} className="input" dir="auto" lang="de" autoComplete="off" />
      </Field>
      {navs.length > 0 && (
        <div className="space-y-3">
          <span className="label">{t.cat.alsoIn}</span>
          <div className="grid gap-3 md:grid-cols-2">
            {navs.map((n) => (
              <div key={n.channel} className="space-y-3 rounded-xl bg-brand-50/50 p-3 ring-1 ring-black/5">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                  <input type="checkbox" name={`in_${n.channel}`} checked={inStore[n.channel] ?? false}
                    onChange={(e) => setInStore((x) => ({ ...x, [n.channel]: e.target.checked }))} className="h-5 w-5 rounded accent-brand-600" />
                  <Icon name="globe" className="h-4 w-4 text-brand-600" />{t.shop.names[n.channel]}
                </label>
                {inStore[n.channel] && <MenuSelect t={t} nav={n} name={`group_${n.channel}`} />}
              </div>
            ))}
          </div>
          <NoMenuAccess t={t} navs={navs} />
        </div>
      )}
      <div className="flex justify-end">
        <SubmitButton className="btn-primary px-6"><Icon name="check" className="h-4 w-4" />{t.cat.create}</SubmitButton>
      </div>
    </form>
  );
}

/** „Im Shop anlegen“ für eine vorhandene Kategorie (ggf. mit Menü-Gruppe) */
export function AddToStore({ t, categoryId, nav, own }: { t: Dict; categoryId: string; nav: StoreNavInfo; own?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [groupId, setGroupId] = useState("-");
  const [result, setResult] = useState<StoreResultCode | null>(null);
  return (
    <div className="space-y-2">
      <MenuSelect t={t} nav={nav} value={groupId} onChange={setGroupId} />
      <button type="button" disabled={pending} className="btn-primary group w-full text-sm sm:w-auto"
        onClick={() => start(async () => {
          const r = await addToStoreAction(categoryId, nav.channel, groupId === "-" ? null : groupId);
          if (r) setResult(r);
          router.refresh();
        })}>
        {pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <Icon name="upload" className="h-4 w-4" />}
        {own ? t.cat.ownInStore : t.cat.addToStore}
      </button>
      {result && <StoreResultNotes t={t} results={[result]} navs={[nav]} />}
    </div>
  );
}

function moveNotes(t: Dict, s: MoveState): { text: string; tone: "ok" | "warn" | "bad" }[] {
  if (!s.ok) return [{ text: errText(t, s.error)!, tone: "bad" }];
  const r = s.r;
  if (r.before === r.category) return [{ text: fill(t.cat.already, { p: r.name }), tone: "ok" }];
  const out: { text: string; tone: "ok" | "warn" | "bad" }[] = [
    { text: r.category ? fill(t.cat.moved, { p: r.name, c: r.category }) : fill(t.cat.removedFrom, { p: r.name }), tone: "ok" },
  ];
  for (const x of r.shops) {
    const shop = t.shop.names[x.channel];
    if (x.failed) out.push({ text: fill(t.cat.shopFailed, { shop }), tone: "bad" });
    else if (x.missing) out.push({ text: fill(t.cat.shopMissing, { shop }), tone: "warn" });
    else if (x.updated || x.unchanged) out.push({ text: fill(t.cat.shopMoved, { shop }), tone: "ok" });
  }
  return out;
}

function Notes({ notes }: { notes: { text: string; tone: "ok" | "warn" | "bad" }[] }) {
  const tone = { ok: "bg-emerald-50 text-emerald-800 ring-emerald-100", warn: "bg-amber-50 text-amber-900 ring-amber-200", bad: "bg-red-50 text-red-800 ring-red-200" };
  if (!notes.length) return null;
  return (
    <div className="space-y-2">
      {notes.map((n, i) => (
        <div key={i} className={`flex animate-rise items-start gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold ring-1 ${tone[n.tone]}`}>
          <Icon name={n.tone === "ok" ? "check" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />{n.text}
        </div>
      ))}
    </div>
  );
}

/** Artikel suchen/antippen → in diese Kategorie (bleibt offen, mehrere nacheinander) */
export function AddProducts({ t, categoryId, options }: { t: Dict; categoryId: string; options: PickerOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState<{ text: string; tone: "ok" | "warn" | "bad" }[]>([]);
  return (
    <div className="space-y-3">
      <div className={pending ? "pointer-events-none opacity-60" : ""}>
        <ProductPickerBar options={options} placeholder={t.product.searchHint} stockLabel={t.product.stock} labels={t.picker}
          onPick={(o) => o.productId && start(async () => {
            const s = await moveProductAction(o.productId!, categoryId);
            setNotes(moveNotes(t, s));
            router.refresh();
          })} />
      </div>
      <Notes notes={notes} />
    </div>
  );
}

/** Kategorie eines Artikels ändern (aus der Liste heraus) */
export function MoveSelect({ t, productId, current, categories }: { t: Dict; productId: string; current: string; categories: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState<{ text: string; tone: "ok" | "warn" | "bad" }[]>([]);
  return (
    <div className="min-w-0 space-y-2">
      <select aria-label={t.cat.moveTo} disabled={pending} value={current} className="input py-2 text-sm"
        onChange={(e) => {
          const v = e.target.value;
          start(async () => {
            const s = await moveProductAction(productId, v === "" ? null : v);
            setNotes(moveNotes(t, s));
            router.refresh();
          });
        }}>
        <option value="">{t.cat.noCategory}</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <Notes notes={notes} />
    </div>
  );
}

/** Leere Kategorie löschen – mit Rückfrage */
export function DeleteCategory({ t, id, name }: { t: Dict; id: string; name: string }) {
  const [state, action] = useActionState(deleteCategoryAction, undefined);
  const [ask, setAsk] = useState(false);
  return (
    <section className="card mt-6 space-y-3 p-5 animate-rise">
      <h2 className="flex items-center gap-2 font-bold text-red-700"><Icon name="trash" className="icon-pop h-5 w-5" />{t.cat.delete}</h2>
      <p className="text-sm text-ink-soft">{t.cat.deleteHint}</p>
      <ErrorBox message={errText(t, state?.error)} />
      {!ask ? (
        <button type="button" className="btn-danger group" onClick={() => setAsk(true)}><Icon name="trash" className="h-4 w-4" />{t.cat.delete}</button>
      ) : (
        <form action={action} className="flex flex-wrap items-center gap-2 rounded-xl bg-red-50 p-3 ring-1 ring-red-200">
          <input type="hidden" name="id" value={id} />
          <span className="w-full text-sm font-semibold text-red-800">{fill(t.cat.deleteConfirm, { c: name })}</span>
          <SubmitButton className="btn-danger">{t.cat.yes}</SubmitButton>
          <button type="button" className="btn-ghost" onClick={() => setAsk(false)}>{t.cat.cancel}</button>
        </form>
      )}
    </section>
  );
}
