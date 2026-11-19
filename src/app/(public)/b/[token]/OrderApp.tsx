"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { formatCents } from "@/lib/money";
import type { Dict } from "@/i18n/de";
import type { RegionOption } from "@/lib/regions";
import {
  DIRECT_MAX_QTY, applyProblems, cartTotals, catalogCategories, mergeCart, priceRange, productInStock, searchCatalog, variantLabel,
  type CartLine, type CatalogProduct, type CatalogVariant, type DirectGroup,
} from "@/lib/direct-rules";

type L = Dict["directPub"];
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const eur = (c: number) => formatCents(c, "de-DE");
const PAGE = 48;
const storeKey = (g: DirectGroup) => `ss-direct-list-${g}`;
// Fotos je Artikel nur einmal je Seitenaufruf holen
const photoCache = new Map<string, string[]>();

type Form = { name: string; email: string; company: string; phone: string; street: string; zip: string; city: string; country: string; vatId: string; note: string; website: string };
const EMPTY: Form = { name: "", email: "", company: "", phone: "", street: "", zip: "", city: "", country: "DE", vatId: "", note: "", website: "" };
type FieldErr = Partial<Record<"name" | "email" | "phone" | "vatId", string>>;

/**
 * Bestell-Link (Direktverkauf, Wunsch Inhaber 19.11.2026): Katalog wie eine Galerie – auf dem Tablet im Büro oder auf dem
 * Handy des Händlers. Artikel ansehen (alle Fotos, Beschreibung, Größen/Farben, Preis), in die Liste legen, Name + E-Mail
 * eintragen, senden. Kein Bezahlen, kein Shop. Bestandszahlen kommen nie in den Browser – nur „verfügbar/nicht verfügbar“;
 * reicht der Bestand beim Senden nicht, passt der Server die Liste an (409 mit der verfügbaren Menge).
 */
export function OrderApp({ token, group, catalog, t, locale, countries, company, links, language }: {
  token: string; group: DirectGroup; catalog: CatalogProduct[]; t: L; locale: string; countries: RegionOption[];
  company: { name: string; address: string; email: string }; links: { imprint: string; privacy: string }; language: ReactNode;
}) {
  const t0 = useRef(0);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sheet, setSheet] = useState<null | "list" | "form" | "done">(null);
  const [adjusted, setAdjusted] = useState<string[]>([]);
  const [f, setF] = useState<Form>(EMPTY);
  const [errs, setErrs] = useState<FieldErr>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ number: number; name: string; email: string } | null>(null);

  const byVariant = useMemo(() => {
    const m = new Map<string, { p: CatalogProduct; v: CatalogVariant }>();
    for (const p of catalog) for (const v of p.variants) m.set(v.id, { p, v });
    return m;
  }, [catalog]);

  // Liste dieses Geräts (nur Artikel + Mengen, keine persönlichen Angaben) – erst nach dem Laden lesen (sonst React #418)
  useEffect(() => {
    t0.current = performance.now();
    try {
      const raw = localStorage.getItem(storeKey(group));
      const a: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(a)) {
        const ok = a.filter((x): x is CartLine => !!x && typeof x.variantId === "string" && Number.isInteger(x.qty) && !!byVariant.get(x.variantId)?.v.inStock);
        setCart(mergeCart(ok));
      }
    } catch { /* kein Speicher (privates Fenster) – egal */ }
    setLoaded(true);
  }, [group, byVariant]);
  useEffect(() => {
    if (!loaded) return;
    try { if (cart.length) localStorage.setItem(storeKey(group), JSON.stringify(cart)); else localStorage.removeItem(storeKey(group)); } catch { /* egal */ }
  }, [cart, loaded, group]);

  const setQty = useCallback((variantId: string, qty: number) => {
    const n = Math.max(0, Math.min(DIRECT_MAX_QTY, Math.floor(qty) || 0));
    setCart((c) => {
      if (n <= 0) return c.filter((l) => l.variantId !== variantId);
      const i = c.findIndex((l) => l.variantId === variantId);
      if (i < 0) return [...c, { variantId, qty: n }];
      const copy = [...c];
      copy[i] = { variantId, qty: n };
      return copy;
    });
    setAdjusted((a) => a.filter((x) => x !== variantId));
  }, []);
  const qtyOf = useCallback((id: string) => cart.find((l) => l.variantId === id)?.qty ?? 0, [cart]);

  const cats = useMemo(() => catalogCategories(catalog), [catalog]);
  const found = useMemo(() => {
    const r = searchCatalog(catalog, q, cat);
    return [...r.filter(productInStock), ...r.filter((p) => !productInStock(p))]; // Verfügbares zuerst
  }, [catalog, q, cat]);
  useEffect(() => setLimit(PAGE), [q, cat]);

  const lines = cart.flatMap((l) => { const x = byVariant.get(l.variantId); return x ? [{ ...l, ...x }] : []; });
  const totals = cartTotals(lines.map((l) => ({ qty: l.qty, priceCents: l.v.priceCents, vatRateBp: l.v.vatRateBp })));
  const open = openId ? catalog.find((p) => p.id === openId) ?? null : null;

  // Seite darunter nicht mitscrollen; Esc schließt das oberste Fenster
  useEffect(() => {
    const on = !!open || !!sheet;
    document.documentElement.style.overflow = on ? "hidden" : "";
    return () => { document.documentElement.style.overflow = ""; };
  }, [open, sheet]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openId) setOpenId(null);
      else if (sheet === "form") setSheet("list");
      else if (sheet) setSheet(null);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [openId, sheet]);

  const img = (id: string) => `/api/b/${encodeURIComponent(token)}/f/${encodeURIComponent(id)}`;

  const validate = (): FieldErr => {
    const e: FieldErr = {};
    if (f.name.trim().length < 2) e.name = t.errors.name;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) e.email = t.errors.email;
    if (f.phone && !/^[0-9+()\-/ .]*$/.test(f.phone)) e.phone = t.errors.phone;
    const vat = f.vatId.toUpperCase().replace(/[\s.\-/]/g, "");
    if (vat && !/^[A-Z0-9]{4,20}$/.test(vat)) e.vatId = t.errors.vatId;
    return e;
  };

  const send = async () => {
    setMsg(null);
    const e = validate();
    setErrs(e);
    const first = (["name", "email", "phone", "vatId"] as const).find((k) => e[k]);
    if (first) { document.getElementById(`d-${first}`)?.focus(); return; }
    if (!cart.length) { setMsg(t.errors.lines); return; }
    setSending(true);
    try {
      const res = await fetch(`/api/b/${encodeURIComponent(token)}/order`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ ...f, elapsedMs: Math.round(performance.now() - t0.current), lang: locale, lines: cart }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; number?: number; error?: string; field?: string; problems?: { variantId: string; available: number }[] };
      if (res.ok && j.ok && j.number) {
        setDone({ number: j.number, name: f.name.trim(), email: f.email.trim() });
        setCart([]);
        setF(EMPTY); // Tablet im Büro: der nächste Kunde sieht nichts vom vorigen
        setSheet("done");
        return;
      }
      if (res.status === 409 && Array.isArray(j.problems)) {
        setCart((c) => applyProblems(c, j.problems!));
        setAdjusted(j.problems.map((p) => p.variantId));
        setMsg(t.errors.unavailable);
        setSheet("list");
        return;
      }
      if (j.error === "field" && j.field) {
        const k = j.field as keyof FieldErr;
        if (k === "name" || k === "email" || k === "phone" || k === "vatId") { setErrs({ [k]: t.errors[k] }); document.getElementById(`d-${k}`)?.focus(); }
        else setMsg(j.field === "lines" ? t.errors.lines : t.errors.form);
        return;
      }
      setMsg(j.error === "rate" ? t.errors.rate : j.error === "closed" ? t.errors.closed : j.error === "bot" ? t.errors.bot : t.errors.form);
    } catch { setMsg(t.errors.network); }
    finally { setSending(false); }
  };

  const shown = found.slice(0, limit);
  const barOn = lines.length > 0 && !open && !sheet;

  return (
    <div className={`min-h-screen ${barOn ? "pb-28" : ""}`}>
      <header className="sticky top-0 z-30 bg-navy-900 text-white shadow-lift">
        <div className="mx-auto flex max-w-[96rem] items-center gap-3 px-4 py-2.5 sm:px-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-light.png" alt="Star Style" className="h-9 w-auto sm:h-11" />
          <div className="ms-auto flex items-center gap-2">
            <div className="rounded-xl bg-white px-2 py-1.5 text-ink">{language}</div>
            <button type="button" onClick={() => setSheet("list")} className="group relative inline-flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-sm font-semibold ring-1 ring-white/15 transition hover:bg-white/20" data-list-button>
              <Icon name="list" className="icon-pop h-5 w-5" />
              <span className="hidden sm:inline">{t.list}</span>
              {lines.length > 0 && <span className="num min-w-[1.375rem] rounded-full bg-accent-500 px-1.5 text-center text-xs font-bold leading-[1.375rem]">{lines.length}</span>}
            </button>
          </div>
        </div>
        <div className="flex h-1" aria-hidden><span className="flex-[3] bg-brand-600" /><span className="flex-1 bg-accent-500" /></div>
      </header>

      <main className="mx-auto max-w-[96rem] space-y-5 px-4 pt-6 sm:px-6">
        <section className="flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-3xl space-y-2">
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t.title}</h1>
            <p className="text-ink-soft">{t.intro}</p>
          </div>
          <span className="badge bg-brand-50 px-3 py-1 text-sm text-brand-700 ring-1 ring-brand-200">{t.forWhom[group]} · {t.net}</span>
        </section>

        <section className="space-y-3">
          <label className="relative block">
            <span className="sr-only">{t.search}</span>
            <Icon name="search" className="pointer-events-none absolute start-3 top-1/2 h-5 w-5 -translate-y-1/2 text-ink-soft" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.search} className="input ps-10" autoComplete="off" enterKeyHint="search" />
          </label>
          {cats.length > 1 && (
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label={t.all}>
              {[{ name: "", n: catalog.length }, ...cats].map((c) => {
                const on = cat === c.name;
                return (
                  <button key={c.name || "all"} type="button" onClick={() => setCat(c.name)} aria-pressed={on}
                    className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold ring-1 transition ${on ? "bg-navy-900 text-white ring-navy-900" : "bg-white text-ink ring-black/10 hover:bg-brand-50"}`}>
                    <span dir="auto">{c.name || t.all}</span> <span className={`num text-xs ${on ? "text-white/70" : "text-ink-soft"}`}>{c.n}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {shown.length === 0 ? (
          <p className="card p-6 text-center font-semibold text-ink-soft">{t.none}</p>
        ) : (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" data-catalog>
            {shown.map((p) => {
              const r = priceRange(p);
              const avail = productInStock(p);
              const inList = p.variants.reduce((s, v) => s + qtyOf(v.id), 0);
              const photo = p.imageId ?? p.variants.find((v) => v.imageId)?.imageId ?? null;
              const pct = Math.max(0, ...p.variants.map((v) => v.promoPct ?? 0)); // Aktion
              const wasMin = Math.min(...p.variants.map((v) => v.wasCents ?? v.priceCents));
              return (
                <button key={p.id} type="button" onClick={() => setOpenId(p.id)} data-product={p.id}
                  className={`group card card-hover flex flex-col overflow-hidden text-start ${avail ? "" : "opacity-75"}`}>
                  <span className="relative block aspect-square bg-white">
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img(photo)} alt="" loading="lazy" decoding="async" className={`h-full w-full object-contain p-3 transition duration-300 group-hover:scale-[1.03] ${avail ? "" : "grayscale"}`} />
                    ) : (
                      <span className="grid h-full place-items-center"><Icon name="box" className="h-12 w-12 text-brand-200" /></span>
                    )}
                    {pct > 0 && <span className="num absolute start-2 top-2 rounded-full bg-accent-600 px-2 py-0.5 text-xs font-black text-white shadow-card" dir="ltr" data-promo-corner>-{pct}%</span>}
                    {inList > 0 && (
                      <span className="absolute end-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white shadow-card">
                        <Icon name="check" className="h-3.5 w-3.5" /><span className="num">{inList}</span>
                      </span>
                    )}
                  </span>
                  <span className="flex flex-1 flex-col gap-1 border-t border-black/5 p-3">
                    {p.category && <span className="truncate text-[0.6875rem] font-semibold text-brand-700" dir="auto">{p.category}</span>}
                    <span className="line-clamp-2 text-sm font-semibold leading-snug [overflow-wrap:anywhere]" dir="auto">{p.name}</span>
                    <span className="mt-auto flex flex-wrap items-baseline gap-x-1.5 pt-1">
                      {pct > 0 && <s className="num text-xs text-ink-soft" dir="ltr">{eur(wasMin)}</s>}
                      <span className={`num font-bold ${pct > 0 ? "text-accent-700" : "text-ink"}`}>{r.min !== r.max ? fill(t.priceFrom, { p: eur(r.min) }) : eur(r.min)}</span>
                      <span className="text-xs text-ink-soft">{t.net}</span>
                    </span>
                    <span className="flex items-center gap-1.5 text-xs text-ink-soft">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${avail ? "bg-emerald-500" : "bg-red-500"}`} />
                      <span className="truncate">{avail ? t.inStock : t.outOfStock}{p.variants.length > 1 ? ` · ${fill(t.options, { n: p.variants.length })}` : ""}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </section>
        )}
        {found.length > shown.length && (
          <div className="flex justify-center">
            <button type="button" onClick={() => setLimit((n) => n + PAGE)} className="btn-ghost group"><Icon name="chevronDown" className="icon-pop h-4 w-4" />{t.showMore}</button>
          </div>
        )}
      </main>

      <footer className="mt-10 border-t border-black/5 bg-white">
        <div className="mx-auto flex max-w-[96rem] flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-ink-soft sm:px-6">
          <div className="space-y-0.5">
            <div className="font-semibold text-ink">{company.name}</div>
            {company.address && <div>{company.address}</div>}
            {company.email && <a href={`mailto:${company.email}`} className="hover:text-brand-700">{company.email}</a>}
          </div>
          <nav className="flex flex-wrap gap-4">
            <a href={links.imprint} target="_blank" rel="noopener noreferrer" className="font-semibold hover:text-brand-700">{t.imprint}</a>
            <a href={links.privacy} target="_blank" rel="noopener noreferrer" className="font-semibold hover:text-brand-700">{t.privacyLink}</a>
          </nav>
        </div>
      </footer>

      {barOn && (
        <div className="fixed inset-x-0 bottom-0 z-30 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
          <button type="button" onClick={() => setSheet("list")} data-list-bar
            className="group mx-auto flex w-full max-w-xl animate-rise items-center gap-3 rounded-2xl bg-navy-900 px-4 py-3 text-white shadow-lift ring-1 ring-white/10 transition hover:bg-navy-800">
            <span className="num grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-500 font-bold">{lines.length}</span>
            <span className="min-w-0 flex-1 text-start">
              <span className="block font-bold">{t.list}</span>
              <span className="block truncate text-sm text-white/75"><span className="num">{eur(totals.netCents)}</span> {t.net}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 font-semibold">{t.next}<Icon name="chevronRight" className="icon-pop h-5 w-5 rtl:rotate-180" /></span>
          </button>
        </div>
      )}

      {open && (
        <ProductSheet p={open} t={t} token={token} img={img} qtyOf={qtyOf} setQty={setQty} onClose={() => setOpenId(null)}
          listCount={lines.length} onList={() => { setOpenId(null); setSheet("list"); }} />
      )}

      {sheet && createPortal(
        <div className="fixed inset-0 z-50 flex justify-end bg-navy-900/60 backdrop-blur-[2px]" onClick={() => sheet !== "done" && setSheet(null)}>
          <aside role="dialog" aria-modal="true" aria-label={t.list} onClick={(e) => e.stopPropagation()} data-sheet={sheet}
            className="flex h-full w-full max-w-lg animate-rise flex-col bg-white shadow-lift">
            <div className="flex items-center gap-3 border-b border-black/5 px-4 py-3">
              {sheet === "form" && (
                <button type="button" onClick={() => setSheet("list")} aria-label={t.back} className="grid h-10 w-10 place-items-center rounded-xl ring-1 ring-black/10 hover:bg-brand-50">
                  <Icon name="chevronLeft" className="h-5 w-5 rtl:rotate-180" />
                </button>
              )}
              <h2 className="min-w-0 flex-1 truncate text-lg font-bold">{sheet === "form" ? t.you : sheet === "done" ? t.list : t.list}</h2>
              <button type="button" onClick={() => { setSheet(null); if (sheet === "done") setDone(null); }} aria-label={t.close} autoFocus
                className="grid h-10 w-10 place-items-center rounded-xl ring-1 ring-black/10 hover:bg-brand-50"><Icon name="x" className="h-5 w-5" /></button>
            </div>

            {sheet === "list" && (
              <ListStep t={t} lines={lines} totals={totals} img={img} setQty={setQty} adjusted={adjusted} msg={msg}
                onMore={() => setSheet(null)} onNext={() => { setMsg(null); setSheet("form"); }} onClear={() => { setCart([]); setMsg(null); }} />
            )}
            {sheet === "form" && (
              <FormStep t={t} f={f} setF={setF} errs={errs} msg={msg} sending={sending} countries={countries} company={company} links={links}
                totalNet={totals.netCents} count={lines.length} onBack={() => setSheet("list")} onSend={send} />
            )}
            {sheet === "done" && done && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center" data-done>
                <span className="grid h-20 w-20 place-items-center rounded-full bg-emerald-50 text-emerald-600 ring-8 ring-emerald-50/60"><Icon name="check" className="h-10 w-10" /></span>
                <h3 className="text-2xl font-bold" dir="auto">{fill(t.doneTitle, { name: done.name })}</h3>
                <p className="max-w-sm text-ink-soft">{fill(t.doneText, { n: done.number, email: done.email })}</p>
                <button type="button" className="btn-primary group" onClick={() => { setDone(null); setSheet(null); t0.current = performance.now(); window.scrollTo({ top: 0 }); }}>
                  <Icon name="plus" className="icon-pop h-4 w-4" />{t.doneAgain}
                </button>
              </div>
            )}
          </aside>
        </div>,
        document.body,
      )}
    </div>
  );
}

function Stepper({ n, onChange, t }: { n: number; onChange: (n: number) => void; t: L }) {
  const [text, setText] = useState(String(n));
  useEffect(() => setText(String(n)), [n]);
  if (!n) {
    return (
      <button type="button" onClick={() => onChange(1)} className="btn-primary group shrink-0 px-3 py-2">
        <Icon name="plus" className="icon-pop h-4 w-4" />{t.add}
      </button>
    );
  }
  return (
    <div className="flex shrink-0 items-center rounded-xl bg-white ring-1 ring-black/10">
      <button type="button" aria-label={t.minus} onClick={() => onChange(n - 1)} className="grid h-10 w-10 place-items-center rounded-s-xl transition hover:bg-brand-50">
        <Icon name={n === 1 ? "trash" : "minus"} className="h-4 w-4" />
      </button>
      <input value={text} inputMode="numeric" aria-label={t.qty} onChange={(e) => setText(e.target.value.replace(/\D/g, "").slice(0, 3))}
        onBlur={() => { const v = parseInt(text, 10); if (Number.isFinite(v)) onChange(v); else setText(String(n)); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        className="num h-10 w-12 bg-transparent text-center font-bold outline-none" />
      <button type="button" aria-label={t.plus} onClick={() => onChange(n + 1)} className="grid h-10 w-10 place-items-center rounded-e-xl transition hover:bg-brand-50">
        <Icon name="plus" className="h-4 w-4" />
      </button>
    </div>
  );
}

function ProductSheet({ p, t, token, img, qtyOf, setQty, onClose, onList, listCount }: {
  p: CatalogProduct; t: L; token: string; img: (id: string) => string; qtyOf: (id: string) => number; setQty: (id: string, n: number) => void;
  onClose: () => void; onList: () => void; listCount: number;
}) {
  const known = useMemo(() => [...new Set([p.imageId, ...p.variants.map((v) => v.imageId)].filter((x): x is string => !!x))], [p]);
  const [photos, setPhotos] = useState<string[]>(() => photoCache.get(p.id) ?? known);
  const [i, setI] = useState(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const rtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";

  useEffect(() => {
    closeRef.current?.focus();
    setI(0);
    const cached = photoCache.get(p.id);
    setPhotos(cached?.length ? cached : known);
    if (cached) return;
    let alive = true;
    fetch(`/api/b/${encodeURIComponent(token)}/photos/${encodeURIComponent(p.id)}`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ids?: unknown } | null) => {
        const ids = Array.isArray(j?.ids) ? j.ids.filter((x): x is string => typeof x === "string") : [];
        photoCache.set(p.id, ids.length ? ids : known);
        if (alive && ids.length) setPhotos(ids);
      })
      .catch(() => { /* bleibt bei den bekannten Fotos */ });
    return () => { alive = false; };
  }, [p, token, known]);

  const go = (d: number) => setI((x) => (photos.length ? (x + d + photos.length) % photos.length : 0));
  const act = Math.min(i, Math.max(0, photos.length - 1));
  const showVariantPhoto = (id: string | null) => { const k = id ? photos.indexOf(id) : -1; if (k >= 0) setI(k); };
  const single = p.variants.length === 1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/70 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={p.name} onClick={(e) => e.stopPropagation()} data-product-sheet
        className="relative flex max-h-[94dvh] w-full max-w-5xl animate-rise flex-col overflow-hidden rounded-t-3xl bg-white shadow-lift sm:max-h-[90vh] sm:rounded-3xl">
        <button ref={closeRef} type="button" onClick={onClose} aria-label={t.close}
          className="absolute end-3 top-3 z-10 grid h-11 w-11 place-items-center rounded-full bg-white/90 shadow-card ring-1 ring-black/10 transition hover:bg-brand-50">
          <Icon name="x" className="h-5 w-5" />
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="space-y-3 bg-slate-50 p-4 md:p-6">
              <div className="relative aspect-square overflow-hidden rounded-2xl bg-white ring-1 ring-black/5"
                onTouchStart={(e) => { const x = e.touches[0]; touch.current = { x: x.clientX, y: x.clientY }; }}
                onTouchEnd={(e) => {
                  const s = touch.current; touch.current = null;
                  if (!s) return;
                  const x = e.changedTouches[0]; const dx = x.clientX - s.x, dy = x.clientY - s.y;
                  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? (rtl ? -1 : 1) : (rtl ? 1 : -1));
                }}>
                {photos[act] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={photos[act]} src={img(photos[act])} alt={p.name} className="h-full w-full object-contain p-4 motion-safe:animate-zoom" />
                ) : (
                  <span className="grid h-full place-items-center"><Icon name="box" className="h-20 w-20 text-brand-200" /></span>
                )}
                {photos.length > 1 && (
                  <>
                    <button type="button" onClick={() => go(-1)} aria-label={t.prevPhoto}
                      className="absolute start-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-navy-900/70 text-white shadow-lift transition hover:bg-brand-600">
                      <Icon name="chevronLeft" className="h-6 w-6 rtl:rotate-180" />
                    </button>
                    <button type="button" onClick={() => go(1)} aria-label={t.nextPhoto}
                      className="absolute end-2 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-navy-900/70 text-white shadow-lift transition hover:bg-brand-600">
                      <Icon name="chevronRight" className="h-6 w-6 rtl:rotate-180" />
                    </button>
                    <span className="num absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-navy-900/70 px-3 py-1 text-xs font-semibold text-white">
                      {fill(t.photoN, { n: act + 1, m: photos.length })}
                    </span>
                  </>
                )}
              </div>
              {photos.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {photos.map((ph, k) => (
                    <button key={ph} type="button" onClick={() => setI(k)} aria-label={fill(t.photoN, { n: k + 1, m: photos.length })}
                      className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-white p-1 ring-2 transition ${k === act ? "ring-brand-500" : "opacity-60 ring-transparent hover:opacity-100"}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={img(ph)} alt="" loading="lazy" className="h-full w-full object-contain" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-4 p-5 md:p-6">
              <div className="space-y-1 pe-12">
                {p.category && <div className="text-sm font-semibold text-brand-700" dir="auto">{p.category}</div>}
                <h2 className="text-2xl font-bold leading-tight [overflow-wrap:anywhere]" dir="auto">{p.name}</h2>
                <div className="text-xs text-ink-soft">{t.sku} <bdi dir="ltr" className="num">{p.sku}</bdi></div>
              </div>
              {p.description && <p className="whitespace-pre-line text-sm leading-relaxed text-ink [overflow-wrap:anywhere]" dir="auto">{p.description}</p>}
              <div className="space-y-2">
                {p.variants.map((v) => {
                  const n = qtyOf(v.id);
                  const label = variantLabel(v);
                  return (
                    <div key={v.id} onMouseEnter={() => showVariantPhoto(v.imageId)} data-variant={v.id}
                      className={`flex flex-wrap items-center gap-3 rounded-2xl p-3 ring-1 transition ${n ? "bg-emerald-50/70 ring-emerald-200" : "bg-slate-50 ring-black/5"}`}>
                      <div className="min-w-0 flex-1">
                        {(label || !single) && <div className="font-semibold [overflow-wrap:anywhere]" dir="auto">{label || p.name}</div>}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-soft">
                          <span className="inline-flex items-center gap-1"><span className={`h-2 w-2 rounded-full ${v.inStock ? "bg-emerald-500" : "bg-red-500"}`} />{v.inStock ? t.inStock : t.outOfStock}</span>
                          {v.barcode && <span>{t.ean} <bdi dir="ltr" className="num">{v.barcode}</bdi></span>}
                        </div>
                      </div>
                      <div className="text-end">
                        {v.promoPct ? (
                          <div className="flex flex-wrap items-baseline justify-end gap-x-1.5" dir="ltr" data-promo-price>
                            <span className="num rounded-full bg-accent-600 px-1.5 text-[0.6875rem] font-black text-white">-{v.promoPct}%</span>
                            <s className="num text-xs text-ink-soft">{eur(v.wasCents ?? v.priceCents)}</s>
                          </div>
                        ) : null}
                        <div><span className={`num text-lg font-bold ${v.promoPct ? "text-accent-700" : "text-ink"}`}>{eur(v.priceCents)}</span> <span className="text-xs font-semibold text-ink-soft">{t.net}</span></div>
                        <div className="num text-xs text-ink-soft">{fill(t.gross, { p: eur(v.grossCents) })}</div>
                      </div>
                      {v.inStock && <Stepper n={n} onChange={(x) => setQty(v.id, x)} t={t} />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-black/5 bg-white px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
          <button type="button" onClick={onClose} className="btn-ghost">{t.keepLooking}</button>
          <button type="button" onClick={onList} className="btn-primary group" disabled={!listCount}>
            <Icon name="list" className="icon-pop h-4 w-4" />{t.list}{listCount > 0 && <span className="num rounded-full bg-white/20 px-1.5 text-xs">{listCount}</span>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type Line = CartLine & { p: CatalogProduct; v: CatalogVariant };

function ListStep({ t, lines, totals, img, setQty, adjusted, msg, onMore, onNext, onClear }: {
  t: L; lines: Line[]; totals: ReturnType<typeof cartTotals>; img: (id: string) => string; setQty: (id: string, n: number) => void;
  adjusted: string[]; msg: string | null; onMore: () => void; onNext: () => void; onClear: () => void;
}) {
  const [ask, setAsk] = useState(false);
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {msg && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200" role="alert">{msg}</p>}
        {lines.length === 0 ? (
          <p className="py-10 text-center text-ink-soft">{t.listEmpty}</p>
        ) : lines.map((l) => {
          const photo = l.v.imageId ?? l.p.imageId;
          const label = variantLabel(l.v);
          return (
            <div key={l.variantId} className="flex gap-3 rounded-2xl bg-slate-50 p-2.5 ring-1 ring-black/5" data-line={l.variantId}>
              <span className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-white ring-1 ring-black/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {photo ? <img src={img(photo)} alt="" loading="lazy" className="h-full w-full object-contain p-1" /> : <span className="grid h-full place-items-center"><Icon name="box" className="h-7 w-7 text-brand-200" /></span>}
              </span>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]" dir="auto">{l.p.name}</div>
                {label && <div className="text-xs text-ink-soft" dir="auto">{label}</div>}
                {adjusted.includes(l.variantId) && <div className="text-xs font-semibold text-amber-700">{t.maxed}</div>}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Stepper n={l.qty} onChange={(x) => setQty(l.variantId, x)} t={t} />
                  <div className="text-end text-sm">
                    <div className="num font-bold">{eur(l.qty * l.v.priceCents)}</div>
                    <div className="num text-xs text-ink-soft">{l.v.promoPct ? <span className="me-1 rounded-full bg-accent-600 px-1.5 text-[0.625rem] font-black text-white" dir="ltr">-{l.v.promoPct}%</span> : null}{l.qty} × {eur(l.v.priceCents)}</div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {lines.length > 0 && (
          <div className="space-y-1.5 rounded-2xl bg-white p-4 text-sm ring-1 ring-black/10">
            <div className="flex justify-between gap-3"><span>{t.netTotal}</span><span className="num font-semibold">{eur(totals.netCents)}</span></div>
            {totals.vatByRate.map((g) => (
              <div key={g.rateBp} className="flex justify-between gap-3 text-ink-soft"><span>{fill(t.vat, { r: (g.rateBp / 100).toLocaleString("de-DE") })}</span><span className="num">{eur(g.vatCents)}</span></div>
            ))}
            <div className="flex justify-between gap-3 border-t border-black/10 pt-2 text-base font-bold"><span>{t.grossTotal}</span><span className="num">{eur(totals.grossCents)}</span></div>
            <p className="pt-1 text-xs text-ink-soft">{t.totalNote}</p>
          </div>
        )}
      </div>
      <div className="space-y-2 border-t border-black/5 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {lines.length > 0 && (ask ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 p-2 ring-1 ring-red-200">
            <span className="text-sm font-semibold text-red-800">{t.clearConfirm}</span>
            <span className="flex gap-2">
              <button type="button" className="btn-ghost px-3 py-1.5" onClick={() => setAsk(false)}>{t.back}</button>
              <button type="button" className="btn-danger px-3 py-1.5" onClick={() => { setAsk(false); onClear(); }}>{t.clear}</button>
            </span>
          </div>
        ) : (
          <button type="button" onClick={() => setAsk(true)} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-red-700"><Icon name="trash" className="h-4 w-4" />{t.clear}</button>
        ))}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onMore} className="btn-ghost">{t.keepLooking}</button>
          <button type="button" onClick={onNext} disabled={!lines.length} className="btn-primary group">{t.next}<Icon name="chevronRight" className="icon-pop h-4 w-4 rtl:rotate-180" /></button>
        </div>
      </div>
    </>
  );
}

function FormStep({ t, f, setF, errs, msg, sending, countries, company, links, totalNet, count, onBack, onSend }: {
  t: L; f: Form; setF: (fn: (f: Form) => Form) => void; errs: FieldErr; msg: string | null; sending: boolean; countries: RegionOption[];
  company: { name: string; address: string; email: string }; links: { imprint: string; privacy: string }; totalNet: number; count: number;
  onBack: () => void; onSend: () => void;
}) {
  const set = (k: keyof Form) => (e: { target: { value: string } }) => { const v = e.target.value; setF((x) => ({ ...x, [k]: v })); };
  const field = (k: keyof Form, label: string, o: { req?: boolean; type?: string; auto?: string; wide?: boolean; ph?: string; mode?: "email" | "tel" | "text" } = {}) => {
    const err = (errs as Record<string, string | undefined>)[k];
    return (
      <label className={`block ${o.wide ? "col-span-2" : "col-span-2 sm:col-span-1"}`}>
        <span className="label">{label}{o.req && <span className="ms-1 text-xs font-semibold text-accent-600">({t.required})</span>}</span>
        <input id={`d-${k}`} value={f[k]} onChange={set(k)} type={o.type ?? "text"} autoComplete={o.auto} inputMode={o.mode} placeholder={o.ph}
          aria-invalid={!!err} aria-describedby={err ? `d-${k}-err` : undefined} required={o.req}
          className={`input ${err ? "border-red-400 focus:border-red-500 focus:ring-red-500/15" : ""}`} dir={k === "email" || k === "phone" || k === "vatId" ? "ltr" : "auto"} />
        {err && <span id={`d-${k}-err`} className="mt-1 block text-xs font-semibold text-red-700">{err}</span>}
      </label>
    );
  };
  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); if (!sending) onSend(); }} noValidate>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <p className="text-sm text-ink-soft">{t.youHint}</p>
        {msg && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200" role="alert">{msg}</p>}
        <div className="grid grid-cols-2 gap-3">
          {field("name", t.name, { req: true, auto: "name", wide: true })}
          {field("email", t.email, { req: true, type: "email", auto: "email", wide: true, mode: "email" })}
          {field("company", t.company, { auto: "organization" })}
          {field("phone", t.phone, { type: "tel", auto: "tel", mode: "tel" })}
        </div>
        <details className="group rounded-2xl bg-slate-50 p-3 ring-1 ring-black/5" open={!!(f.street || f.zip || f.city || f.vatId)}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold">
            {t.address}<Icon name="chevronDown" className="h-4 w-4 transition group-open:rotate-180" />
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {field("street", t.street, { auto: "street-address", wide: true })}
            {field("zip", t.zip, { auto: "postal-code" })}
            {field("city", t.city, { auto: "address-level2" })}
            <label className="col-span-2 block sm:col-span-1">
              <span className="label">{t.country}</span>
              <select value={f.country} onChange={set("country")} autoComplete="country" className="input">
                {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            {field("vatId", t.vatId, { ph: "DE123456789" })}
          </div>
        </details>
        <label className="block">
          <span className="label">{t.note}</span>
          <textarea value={f.note} onChange={set("note")} rows={3} maxLength={1000} placeholder={t.notePh} className="input" dir="auto" />
        </label>
        {/* Falle für Programme – Menschen sehen und erreichen dieses Feld nicht */}
        <div aria-hidden className="absolute -start-[9999px] h-px w-px overflow-hidden">
          <label>Bitte leer lassen<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set("website")} /></label>
        </div>
        <details className="rounded-2xl bg-slate-50 p-3 text-xs leading-relaxed text-ink-soft ring-1 ring-black/5">
          <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-ink"><Icon name="shield" className="h-4 w-4 text-brand-600" />{t.privacyTitle}</summary>
          <p className="mt-2">{fill(t.privacy, { company: company.name, address: company.address, email: company.email })}</p>
          <p className="mt-2 flex flex-wrap gap-3">
            <a href={links.privacy} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 underline">{t.privacyLink}</a>
            <a href={links.imprint} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 underline">{t.imprint}</a>
          </p>
        </details>
      </div>
      <div className="space-y-2 border-t border-black/5 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="flex justify-between text-sm"><span className="text-ink-soft">{fill(t.count, { n: count })}</span><span><span className="num font-bold">{eur(totalNet)}</span> <span className="text-ink-soft">{t.net}</span></span></div>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onBack} className="btn-ghost">{t.back}</button>
          <button type="submit" disabled={sending} className="btn-primary group" data-send>
            <Icon name="send" className="icon-pop h-4 w-4 rtl:-scale-x-100" />{sending ? t.sending : t.send}
          </button>
        </div>
      </div>
    </form>
  );
}
