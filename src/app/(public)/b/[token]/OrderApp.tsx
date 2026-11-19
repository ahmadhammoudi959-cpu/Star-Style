"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { formatCents, grossFromNet } from "@/lib/money";
import { shrinkImage } from "@/lib/image-client";
import type { Dict } from "@/i18n/de";
import type { RegionOption } from "@/lib/regions";
import {
  DIRECT_MANUAL_VAT_BP, DIRECT_MAX_MANUAL, DIRECT_MAX_QTY, applyProblems, catalogCategories, listTotals, manualPrice, mergeCart, priceRange, productInStock,
  searchCatalog, variantLabel, type CartLine, type CatalogProduct, type CatalogVariant, type DirectGroup,
} from "@/lib/direct-rules";

type L = Dict["directPub"];
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));
const eur = (c: number) => formatCents(c, "de-DE");
const PAGE = 48;
const storeKey = (g: DirectGroup) => `ss-direct-list-${g}`;
// Fotos je Artikel nur einmal je Seitenaufruf holen
const photoCache = new Map<string, string[]>();

/**
 * Artikel von Hand (Wunsch Inhaber 20.11.2026): einen Artikel, den es im Katalog nicht gibt, mit der Kamera fotografieren und
 * Name, Menge, Preis, Größe, Farbe eintippen – kommt mit der Liste an und geht im System nur ins Angebot. Die Liste merkt sich
 * dieses Gerät (Angaben im localStorage, Fotos in IndexedDB – zu groß für localStorage); nach dem Senden ist alles weg.
 */
type Own = { key: string; name: string; qty: number; priceCents: number | null; size: string; color: string; photo: boolean };
const ownStoreKey = (g: DirectGroup) => `ss-direct-own-${g}`;
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const touchDevice = () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
const camOk = () => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

// Fotos der Artikel von Hand: IndexedDB (bleibt beim Neuladen), sonst nur im Speicher (privates Fenster)
const memPhotos = new Map<string, Blob>();
function idb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const r = indexedDB.open("ss-direct", 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("photos")) r.result.createObjectStore("photos"); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
      r.onblocked = () => res(null);
    } catch { res(null); }
  });
}
async function idbRun<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | null> {
  const d = await idb();
  if (!d) return null;
  return new Promise<T | null>((res) => {
    try {
      const tx = d.transaction("photos", mode);
      const rq = fn(tx.objectStore("photos"));
      tx.oncomplete = () => { d.close(); res(rq ? (rq.result ?? null) : null); };
      tx.onerror = tx.onabort = () => { d.close(); res(null); };
    } catch { d.close(); res(null); }
  });
}
const photoPut = async (k: string, b: Blob) => { memPhotos.set(k, b); await idbRun("readwrite", (s) => s.put(b, k)); };
const photoGet = async (k: string): Promise<Blob | null> => {
  const m = memPhotos.get(k);
  if (m) return m;
  const b = await idbRun<unknown>("readonly", (s) => s.get(k));
  return b instanceof Blob ? b : null;
};
const photoDel = async (keys: string[]) => {
  keys.forEach((k) => memPhotos.delete(k));
  if (keys.length) await idbRun("readwrite", (s) => { keys.forEach((k) => s.delete(k)); });
};
/** Fotos dieser Liste (Gruppe), die zu keinem Artikel mehr gehören, wegräumen (gerade eben aufgenommene bleiben: memPhotos) */
const photoKeep = async (prefix: string, keep: Set<string>) => {
  const all = (await idbRun<IDBValidKey[]>("readonly", (s) => s.getAllKeys())) ?? [];
  await photoDel(all.map(String).filter((k) => k.startsWith(prefix) && !keep.has(k) && !memPhotos.has(k)));
};
/** alle Fotos dieser Liste weg (nach dem Senden / Liste leeren) */
const photoClear = async (prefix: string) => {
  for (const k of [...memPhotos.keys()]) if (k.startsWith(prefix)) memPhotos.delete(k);
  await photoKeep(prefix, new Set());
};

/** Foto vom Handy/Computer: verkleinert (≤ 1600 px, WebP/JPEG – auch HEIC vom iPhone, wenn der Browser es lesen kann) */
async function preparePhoto(f: File | Blob): Promise<Blob> {
  const file = f instanceof File ? f : new File([f], "foto.jpg", { type: f.type || "image/jpeg" });
  return shrinkImage(file, 1600);
}

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
  // Artikel von Hand: Liste, Fotos (Objekt-Adressen zum Anzeigen) und das offene Fenster (neu bzw. ändern)
  const [own, setOwn] = useState<Own[]>([]);
  const [ownUrls, setOwnUrls] = useState<Record<string, string>>({});
  const [ownEdit, setOwnEdit] = useState<null | { item: Own | null; photo: Blob | null; webcam: boolean; busy?: boolean; err?: string }>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const prefix = `${group}:`;

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
    // Artikel von Hand dieses Geräts + ihre Fotos
    let items: Own[] = [];
    try {
      const raw = localStorage.getItem(ownStoreKey(group));
      const a: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(a)) items = a.filter((x): x is Own => !!x && typeof x.key === "string" && typeof x.name === "string" && Number.isInteger(x.qty)).slice(0, DIRECT_MAX_MANUAL);
    } catch { /* egal */ }
    setOwn(items);
    let alive = true;
    (async () => {
      const urls: Record<string, string> = {};
      const ok = new Set<string>();
      for (const it of items) {
        const b = it.photo ? await photoGet(`${group}:${it.key}`) : null;
        if (b) { urls[it.key] = URL.createObjectURL(b); ok.add(it.key); }
      }
      if (!alive) { Object.values(urls).forEach((u) => URL.revokeObjectURL(u)); return; }
      const loadedKeys = new Set(items.map((x) => x.key));
      setOwnUrls((u) => ({ ...urls, ...u }));
      // Foto nicht mehr da (Speicher geleert) → Artikel bleibt ohne Foto; inzwischen neu Angelegtes bleibt unberührt
      setOwn((cur) => cur.map((x) => (loadedKeys.has(x.key) && x.photo && !ok.has(x.key) ? { ...x, photo: false } : x)));
      await photoKeep(`${group}:`, new Set([...ok].map((k) => `${group}:${k}`)));
    })().catch(() => { /* Fotos fehlen – Artikel bleiben ohne Foto */ });
    setLoaded(true);
    return () => { alive = false; };
  }, [group, byVariant]);
  useEffect(() => {
    if (!loaded) return;
    try { if (cart.length) localStorage.setItem(storeKey(group), JSON.stringify(cart)); else localStorage.removeItem(storeKey(group)); } catch { /* egal */ }
  }, [cart, loaded, group]);
  useEffect(() => {
    if (!loaded) return;
    try { if (own.length) localStorage.setItem(ownStoreKey(group), JSON.stringify(own)); else localStorage.removeItem(ownStoreKey(group)); } catch { /* egal */ }
  }, [own, loaded, group]);

  // ── Artikel von Hand: Kachel → Kamera (Handy: Kamera-App sofort, im selben Tipp; Computer: Kamera im Fenster) ──
  const startOwn = () => {
    if (own.length >= DIRECT_MAX_MANUAL) { setMsg(fill(t.errors.ownMax, { n: DIRECT_MAX_MANUAL })); setSheet("list"); return; }
    const touch = touchDevice();
    setOwnEdit({ item: null, photo: null, webcam: !touch && camOk() });
    if (touch) camRef.current?.click(); // muss im Tipp selbst passieren, sonst blockt das Handy die Kamera
  };
  const onCamFile = async (f: File | undefined) => {
    if (!f) return;
    setOwnEdit((e) => (e ? { ...e, busy: true, err: undefined } : e));
    try {
      const b = await preparePhoto(f);
      setOwnEdit((e) => (e ? { ...e, photo: b, webcam: false, busy: false } : e));
    } catch { setOwnEdit((e) => (e ? { ...e, busy: false, err: t.errors.photo } : e)); }
  };
  const saveOwn = async (v: Omit<Own, "key" | "photo">, photo: Blob | null, keep: Own | null) => {
    const key = keep?.key ?? newKey();
    const k = `${group}:${key}`;
    if (photo) {
      await photoPut(k, photo).catch(() => { /* dann nur im Speicher */ });
      setOwnUrls((u) => { if (u[key]) URL.revokeObjectURL(u[key]); return { ...u, [key]: URL.createObjectURL(photo) }; });
    } else if (keep?.photo) {
      // Foto entfernt
      await photoDel([k]).catch(() => {});
      setOwnUrls((u) => { if (u[key]) URL.revokeObjectURL(u[key]); const c = { ...u }; delete c[key]; return c; });
    }
    const item: Own = { ...v, key, photo: !!photo };
    setOwn((list) => (keep ? list.map((x) => (x.key === key ? item : x)) : [...list, item]));
    setOwnEdit(null);
  };
  const removeOwn = (key: string) => {
    setOwn((list) => list.filter((x) => x.key !== key));
    setOwnUrls((u) => { if (u[key]) URL.revokeObjectURL(u[key]); const c = { ...u }; delete c[key]; return c; });
    void photoDel([`${group}:${key}`]).catch(() => {});
  };
  const setOwnQty = (key: string, n: number) => {
    const q = Math.max(0, Math.min(DIRECT_MAX_QTY, Math.floor(n) || 0));
    if (q <= 0) { removeOwn(key); return; }
    setOwn((list) => list.map((x) => (x.key === key ? { ...x, qty: q } : x)));
  };
  const clearOwn = () => {
    Object.values(ownUrls).forEach((u) => URL.revokeObjectURL(u));
    setOwnUrls({});
    setOwn([]);
    void photoClear(prefix).catch(() => {});
  };
  const editOwn = (it: Own) => {
    void (async () => {
      const b = it.photo ? await photoGet(`${group}:${it.key}`) : null;
      setOwnEdit({ item: it, photo: b, webcam: false });
    })();
  };

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
  const totals = listTotals(lines.map((l) => ({ qty: l.qty, priceCents: l.v.priceCents, vatRateBp: l.v.vatRateBp })), own);
  const count = lines.length + own.length;
  const open = openId ? catalog.find((p) => p.id === openId) ?? null : null;

  // Seite darunter nicht mitscrollen; Esc schließt das oberste Fenster
  useEffect(() => {
    const on = !!open || !!sheet || !!ownEdit;
    document.documentElement.style.overflow = on ? "hidden" : "";
    return () => { document.documentElement.style.overflow = ""; };
  }, [open, sheet, ownEdit]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (ownEdit) setOwnEdit(null);
      else if (openId) setOpenId(null);
      else if (sheet === "form") setSheet("list");
      else if (sheet) setSheet(null);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [openId, sheet, ownEdit]);

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
    if (!cart.length && !own.length) { setMsg(t.errors.lines); return; }
    setSending(true);
    try {
      // Artikel von Hand: Fotos als Dateien p0 … (multipart), sonst wie immer JSON
      const blobs: Blob[] = [];
      const manual: { name: string; qty: number; priceCents: number | null; size: string; color: string; photo: string | null }[] = [];
      for (const o of own) {
        const b = o.photo ? await photoGet(`${group}:${o.key}`) : null;
        manual.push({ name: o.name, qty: o.qty, priceCents: o.priceCents, size: o.size, color: o.color, photo: b ? `p${blobs.length}` : null });
        if (b) blobs.push(b);
      }
      const payload = JSON.stringify({ ...f, elapsedMs: Math.round(performance.now() - t0.current), lang: locale, lines: cart, manual });
      let body: BodyInit = payload;
      const headers: Record<string, string> = {};
      if (blobs.length) {
        const fd = new FormData();
        fd.append("data", payload);
        blobs.forEach((b, i) => fd.append(`p${i}`, b, `p${i}.${b.type === "image/webp" ? "webp" : "jpg"}`));
        body = fd; // Grenze (boundary) setzt der Browser selbst
      } else headers["Content-Type"] = "application/json";
      const res = await fetch(`/api/b/${encodeURIComponent(token)}/order`, { method: "POST", headers, credentials: "same-origin", body });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; number?: number; error?: string; field?: string; problems?: { variantId: string; available: number }[] };
      if (res.ok && j.ok && j.number) {
        setDone({ number: j.number, name: f.name.trim(), email: f.email.trim() });
        setCart([]);
        clearOwn();
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
      const known: Record<string, string> = {
        rate: t.errors.rate, closed: t.errors.closed, bot: t.errors.bot, photo: t.errors.photo, photoRate: t.errors.photoRate, tooBig: t.errors.tooBig,
      };
      setMsg(known[j.error ?? ""] ?? (res.status === 413 ? t.errors.tooBig : t.errors.form));
    } catch { setMsg(t.errors.network); }
    finally { setSending(false); }
  };

  const shown = found.slice(0, limit);
  const barOn = count > 0 && !open && !sheet && !ownEdit;

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
              {count > 0 && <span className="num min-w-[1.375rem] rounded-full bg-accent-500 px-1.5 text-center text-xs font-bold leading-[1.375rem]">{count}</span>}
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
          <div className="card flex flex-col items-center gap-3 p-6 text-center">
            <p className="font-semibold text-ink-soft">{t.none}</p>
            <p className="max-w-md text-sm text-ink-soft">{t.ownNotFound}</p>
            <button type="button" onClick={startOwn} className="btn-primary group" data-own-start><Icon name="camera" className="icon-pop h-5 w-5" />{t.ownTile}</button>
          </div>
        ) : (
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6" data-catalog>
            {/* Artikel von Hand: erste Kachel – antippen öffnet sofort die Kamera */}
            <button type="button" onClick={startOwn} data-own-tile
              className="group card card-hover flex flex-col items-center justify-center gap-3 border-2 border-dashed border-brand-300 bg-brand-50/60 p-4 text-center text-brand-800 transition hover:border-brand-500 hover:bg-brand-50">
              <span className="relative grid h-16 w-16 place-items-center rounded-2xl bg-white text-brand-600 shadow-card ring-1 ring-brand-100">
                <Icon name="camera" className="icon-pop h-8 w-8" />
                <span className="absolute -end-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full bg-accent-500 text-white shadow-card"><Icon name="plus" className="h-4 w-4" /></span>
              </span>
              <span className="text-sm font-bold leading-snug">{t.ownTile}</span>
              <span className="text-xs leading-snug text-brand-700/80">{t.ownTileHint}</span>
              {own.length > 0 && <span className="num rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-brand-700 ring-1 ring-brand-200">{fill(t.ownCount, { n: own.length })}</span>}
            </button>
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
            <span className="num grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-500 font-bold">{count}</span>
            <span className="min-w-0 flex-1 text-start">
              <span className="block font-bold">{t.list}</span>
              <span className="block truncate text-sm text-white/75"><span className="num">{eur(totals.netCents)}</span> {t.net}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 font-semibold">{t.next}<Icon name="chevronRight" className="icon-pop h-5 w-5 rtl:rotate-180" /></span>
          </button>
        </div>
      )}

      {/* Handy: Kamera-App direkt aus der Kachel (capture); das Foto landet im Fenster „Artikel von Hand“ */}
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" aria-hidden tabIndex={-1}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onCamFile(f); }} />
      {ownEdit && (
        <OwnSheet t={t} state={ownEdit} setState={setOwnEdit} onCamFile={onCamFile} onSave={saveOwn} onRemove={(k) => { removeOwn(k); setOwnEdit(null); }}
          onClose={() => setOwnEdit(null)} />
      )}

      {open && (
        <ProductSheet p={open} t={t} token={token} img={img} qtyOf={qtyOf} setQty={setQty} onClose={() => setOpenId(null)}
          listCount={count} onList={() => { setOpenId(null); setSheet("list"); }} />
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
                own={own} ownUrls={ownUrls} onOwnQty={setOwnQty} onOwnEdit={editOwn} onOwnAdd={() => { setMsg(null); startOwn(); }}
                onMore={() => setSheet(null)} onNext={() => { setMsg(null); setSheet("form"); }} onClear={() => { setCart([]); clearOwn(); setMsg(null); }} />
            )}
            {sheet === "form" && (
              <FormStep t={t} f={f} setF={setF} errs={errs} msg={msg} sending={sending} countries={countries} company={company} links={links}
                totalNet={totals.netCents} count={count} onBack={() => setSheet("list")} onSend={send} />
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

function ListStep({ t, lines, totals, img, setQty, adjusted, msg, own, ownUrls, onOwnQty, onOwnEdit, onOwnAdd, onMore, onNext, onClear }: {
  t: L; lines: Line[]; totals: ReturnType<typeof listTotals>; img: (id: string) => string; setQty: (id: string, n: number) => void;
  adjusted: string[]; msg: string | null; own: Own[]; ownUrls: Record<string, string>; onOwnQty: (key: string, n: number) => void;
  onOwnEdit: (it: Own) => void; onOwnAdd: () => void; onMore: () => void; onNext: () => void; onClear: () => void;
}) {
  const [ask, setAsk] = useState(false);
  const count = lines.length + own.length;
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {msg && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200" role="alert">{msg}</p>}
        {count === 0 && <p className="py-10 text-center text-ink-soft">{t.listEmpty}</p>}
        {lines.map((l) => {
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
        {/* Artikel von Hand: Foto, Name, Größe · Farbe, Menge; antippen = ändern */}
        {own.map((o) => {
          const label = variantLabel(o);
          return (
            <div key={o.key} className="flex gap-3 rounded-2xl bg-amber-50/60 p-2.5 ring-1 ring-amber-200" data-own-line={o.key}>
              <button type="button" onClick={() => onOwnEdit(o)} aria-label={`${t.ownEdit}: ${o.name}`}
                className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-white ring-1 ring-black/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {ownUrls[o.key] ? <img src={ownUrls[o.key]} alt="" className="h-full w-full object-cover" /> : <span className="grid h-full place-items-center"><Icon name="camera" className="h-7 w-7 text-amber-400" /></span>}
              </button>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold leading-snug [overflow-wrap:anywhere]" dir="auto">{o.name}</div>
                    {label && <div className="text-xs text-ink-soft" dir="auto">{label}</div>}
                    <span className="mt-0.5 inline-flex items-center gap-1 text-[0.6875rem] font-semibold text-amber-800"><Icon name="camera" className="h-3 w-3" />{t.ownBadge}</span>
                  </div>
                  <button type="button" onClick={() => onOwnEdit(o)} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white ring-1 ring-black/10 hover:bg-brand-50" aria-label={t.ownEdit} data-own-edit>
                    <Icon name="edit" className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Stepper n={o.qty} onChange={(x) => onOwnQty(o.key, x)} t={t} />
                  <div className="text-end text-sm">
                    {o.priceCents != null && o.priceCents > 0 ? <>
                      <div className="num font-bold">{eur(o.qty * o.priceCents)}</div>
                      <div className="num text-xs text-ink-soft">{o.qty} × {eur(o.priceCents)}</div>
                    </> : <div className="text-xs font-semibold text-ink-soft">{t.ownNoPrice}</div>}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {count > 0 && own.length < DIRECT_MAX_MANUAL && (
          <button type="button" onClick={onOwnAdd} className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand-200 px-3 py-2.5 text-sm font-semibold text-brand-700 transition hover:border-brand-400 hover:bg-brand-50" data-own-add>
            <Icon name="camera" className="h-4 w-4" />{t.ownTile}
          </button>
        )}
        {count > 0 && (
          <div className="space-y-1.5 rounded-2xl bg-white p-4 text-sm ring-1 ring-black/10">
            <div className="flex justify-between gap-3"><span>{t.netTotal}</span><span className="num font-semibold">{eur(totals.netCents)}</span></div>
            {totals.vatByRate.map((g) => (
              <div key={g.rateBp} className="flex justify-between gap-3 text-ink-soft"><span>{fill(t.vat, { r: (g.rateBp / 100).toLocaleString("de-DE") })}</span><span className="num">{eur(g.vatCents)}</span></div>
            ))}
            <div className="flex justify-between gap-3 border-t border-black/10 pt-2 text-base font-bold"><span>{t.grossTotal}</span><span className="num">{eur(totals.grossCents)}</span></div>
            <p className="pt-1 text-xs text-ink-soft">{t.totalNote}</p>
            {own.some((o) => o.priceCents == null || o.priceCents <= 0) && <p className="text-xs text-ink-soft">{t.ownTotalNote}</p>}
          </div>
        )}
      </div>
      <div className="space-y-2 border-t border-black/5 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        {count > 0 && (ask ? (
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
          <button type="button" onClick={onNext} disabled={!count} className="btn-primary group">{t.next}<Icon name="chevronRight" className="icon-pop h-4 w-4 rtl:rotate-180" /></button>
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

type OwnState = { item: Own | null; photo: Blob | null; webcam: boolean; busy?: boolean; err?: string };

/**
 * Fenster „Artikel von Hand“: Foto (Handy: Kamera-App; Computer: Kamera im Fenster; oder ein Foto auswählen), dann Name
 * (Pflicht), Menge, Preis je Stück netto (frei lassen = auf Anfrage), Größe, Farbe → in die Liste. Ändern/Entfernen genauso.
 */
function OwnSheet({ t, state, setState, onCamFile, onSave, onRemove, onClose }: {
  t: L; state: OwnState; setState: (fn: (s: OwnState | null) => OwnState | null) => void; onCamFile: (f: File | undefined) => Promise<void>;
  onSave: (v: Omit<Own, "key" | "photo">, photo: Blob | null, keep: Own | null) => Promise<void>; onRemove: (key: string) => void; onClose: () => void;
}) {
  const it = state.item;
  const [name, setName] = useState(it?.name ?? "");
  const [qty, setQty] = useState(String(it?.qty ?? 1));
  const [price, setPrice] = useState(it?.priceCents ? (it.priceCents / 100).toFixed(2).replace(".", ",") : "");
  const [size, setSize] = useState(it?.size ?? "");
  const [color, setColor] = useState(it?.color ?? "");
  const [errs, setErrs] = useState<{ name?: string; price?: string }>({});
  const [saving, setSaving] = useState(false);
  const [cam, setCam] = useState<"off" | "starting" | "live" | "error">("off");
  const [url, setUrl] = useState<string | null>(null);
  const camIn = useRef<HTMLInputElement>(null);
  const pickIn = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    if (!state.photo) { setUrl(null); return; }
    const u = URL.createObjectURL(state.photo);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [state.photo]);
  // Kamera im Fenster (Computer): an, solange webcam gilt; beim Schließen/Foto sofort aus
  useEffect(() => {
    if (!state.webcam) { setCam("off"); return; }
    if (!camOk()) { setCam("error"); return; }
    let stream: MediaStream | null = null, alive = true;
    setCam("starting");
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (!alive) { s.getTracks().forEach((x) => x.stop()); return; }
        stream = s;
        const v = video.current;
        if (v) { v.srcObject = s; void v.play().catch(() => {}); }
        setCam("live");
      })
      .catch(() => { if (alive) setCam("error"); });
    return () => { alive = false; stream?.getTracks().forEach((x) => x.stop()); };
  }, [state.webcam]);
  // neues Foto da → gleich den Namen tippen
  useEffect(() => { if (state.photo && !it) nameRef.current?.focus(); }, [state.photo, it]);

  const snap = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const k = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    const b = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.86));
    if (b) setState((s) => (s ? { ...s, photo: b, webcam: false, err: undefined } : s));
  };
  // Neues Foto: Handy → Kamera-App (im selben Tipp), Computer → Kamera im Fenster
  const take = () => {
    if (touchDevice() || !camOk()) camIn.current?.click();
    else setState((s) => (s ? { ...s, webcam: true, err: undefined } : s));
  };
  const pv = manualPrice(price);
  const gross = typeof pv === "number" && pv > 0 ? grossFromNet(pv, DIRECT_MANUAL_VAT_BP) : null;
  const q = Math.max(1, Math.min(DIRECT_MAX_QTY, parseInt(qty, 10) || 1));

  const save = async () => {
    const e: { name?: string; price?: string } = {};
    if (!name.trim()) e.name = t.errors.ownName;
    if (pv === "bad") e.price = t.errors.ownPrice;
    setErrs(e);
    if (e.name) { nameRef.current?.focus(); return; }
    if (e.price) { document.getElementById("own-price")?.focus(); return; }
    setSaving(true);
    try {
      await onSave({ name: name.trim().slice(0, 120), qty: q, priceCents: pv === "bad" ? null : pv, size: size.trim().slice(0, 40), color: color.trim().slice(0, 40) }, state.photo, it);
    } finally { setSaving(false); }
  };
  const fileIn = (ref: React.RefObject<HTMLInputElement | null>, capture: boolean) => (
    <input ref={ref} type="file" accept="image/*" {...(capture ? { capture: "environment" as const } : {})} className="hidden" aria-hidden tabIndex={-1}
      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onCamFile(f); }} />
  );
  const field = (id: string, label: string, value: string, set: (v: string) => void, o: { ph?: string; err?: string; mode?: "decimal" | "text"; req?: boolean; refEl?: React.RefObject<HTMLInputElement | null>; wide?: boolean } = {}) => (
    <label className={`block ${o.wide ? "col-span-2" : "col-span-2 sm:col-span-1"}`}>
      <span className="label">{label}{o.req && <span className="ms-1 text-xs font-semibold text-accent-600">({t.required})</span>}</span>
      <input id={id} ref={o.refEl} value={value} onChange={(e) => set(e.target.value)} placeholder={o.ph} inputMode={o.mode} maxLength={id === "own-name" ? 120 : 40}
        aria-invalid={!!o.err} aria-describedby={o.err ? `${id}-err` : undefined} dir={o.mode === "decimal" ? "ltr" : "auto"}
        className={`input ${o.err ? "border-red-400 focus:border-red-500 focus:ring-red-500/15" : ""}`} />
      {o.err && <span id={`${id}-err`} className="mt-1 block text-xs font-semibold text-red-700">{o.err}</span>}
    </label>
  );

  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-end justify-center bg-navy-900/70 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={t.ownTitle} onClick={(e) => e.stopPropagation()} data-own-sheet
        className="relative flex max-h-[94dvh] w-full max-w-xl animate-rise flex-col overflow-hidden rounded-t-3xl bg-white shadow-lift sm:max-h-[90vh] sm:rounded-3xl">
        <div className="flex items-center gap-3 border-b border-black/5 px-4 py-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="camera" className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold">{it ? t.ownEdit : t.ownTitle}</h2>
            <p className="truncate text-xs text-ink-soft">{t.ownHint}</p>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={t.close} className="grid h-10 w-10 place-items-center rounded-xl ring-1 ring-black/10 hover:bg-brand-50"><Icon name="x" className="h-5 w-5" /></button>
        </div>
        <form className="flex min-h-0 flex-1 flex-col" noValidate onSubmit={(e) => { e.preventDefault(); if (!saving && !state.busy) void save(); }}>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div className="space-y-2">
              <div className={`relative grid aspect-[4/3] place-items-center overflow-hidden rounded-2xl ring-1 ring-black/5 ${state.webcam && cam !== "error" ? "bg-navy-900" : "bg-slate-50"}`} data-own-photo={url ? "set" : state.webcam ? "camera" : "none"}>
                {state.webcam && cam !== "error" ? (
                  <>
                    <video ref={video} playsInline muted autoPlay className="h-full w-full object-cover" data-own-video />
                    {cam !== "live" && <span className="absolute inset-0 grid place-items-center text-sm font-semibold text-white/80">{t.ownCameraStarting}</span>}
                  </>
                ) : url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt={name || t.ownTitle} className="h-full w-full object-contain" />
                ) : (
                  <span className="flex flex-col items-center gap-2 px-6 text-center text-ink-soft">
                    <Icon name="camera" className="h-12 w-12 text-brand-300" />
                    <span className="text-sm">{t.ownPhotoHint}</span>
                  </span>
                )}
                {state.busy && <span className="absolute inset-0 grid place-items-center bg-white/80 text-sm font-semibold">{t.ownPhotoBusy}</span>}
              </div>
              {cam === "error" && <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 ring-1 ring-amber-200" role="status">{t.ownCameraOff}</p>}
              {state.err && <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-800 ring-1 ring-red-200" role="alert">{state.err}</p>}
              <div className="flex flex-wrap gap-2">
                {state.webcam && cam !== "error" ? (
                  <>
                    <button type="button" onClick={() => void snap()} disabled={cam !== "live"} className="btn-primary group flex-1" data-own-snap><Icon name="camera" className="icon-pop h-4 w-4" />{t.ownShoot}</button>
                    <button type="button" onClick={() => pickIn.current?.click()} className="btn-ghost group"><Icon name="image" className="h-4 w-4" />{t.ownPickPhoto}</button>
                    <button type="button" onClick={() => setState((s) => (s ? { ...s, webcam: false } : s))} className="btn-ghost">{t.ownCameraStop}</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={take} className={`${url ? "btn-ghost" : "btn-primary"} group flex-1`} data-own-take><Icon name="camera" className="icon-pop h-4 w-4" />{url ? t.ownRetake : t.ownTakePhoto}</button>
                    <button type="button" onClick={() => pickIn.current?.click()} className="btn-ghost group" data-own-pick><Icon name="image" className="h-4 w-4" />{t.ownPickPhoto}</button>
                    {url && <button type="button" onClick={() => setState((s) => (s ? { ...s, photo: null } : s))} className="btn-ghost text-red-700">{t.ownRemovePhoto}</button>}
                  </>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {field("own-name", t.ownName, name, setName, { ph: t.ownNamePh, err: errs.name, req: true, refEl: nameRef, wide: true })}
              <div className="col-span-2 sm:col-span-1">
                <span className="label">{t.qty}</span>
                <div className="flex items-center rounded-xl bg-white ring-1 ring-black/10">
                  <button type="button" aria-label={t.minus} onClick={() => setQty(String(Math.max(1, q - 1)))} className="grid h-11 w-11 place-items-center rounded-s-xl hover:bg-brand-50"><Icon name="minus" className="h-4 w-4" /></button>
                  <input value={qty} inputMode="numeric" aria-label={t.qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, "").slice(0, 3))} onBlur={() => setQty(String(q))}
                    className="num h-11 min-w-0 flex-1 bg-transparent text-center font-bold outline-none" data-own-qty />
                  <button type="button" aria-label={t.plus} onClick={() => setQty(String(Math.min(DIRECT_MAX_QTY, q + 1)))} className="grid h-11 w-11 place-items-center rounded-e-xl hover:bg-brand-50"><Icon name="plus" className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="col-span-2 sm:col-span-1">
                {field("own-price", t.ownPrice, price, setPrice, { ph: "0,00", err: errs.price, mode: "decimal", wide: true })}
                {gross != null && <span className="num mt-1 block text-xs text-ink-soft">{fill(t.gross, { p: eur(gross) })}</span>}
              </div>
              {field("own-size", t.ownSize, size, setSize, { ph: t.ownSizePh })}
              {field("own-color", t.ownColor, color, setColor, { ph: t.ownColorPh })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-black/5 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {it && <button type="button" onClick={() => onRemove(it.key)} className="btn-ghost group text-red-700" data-own-remove><Icon name="trash" className="h-4 w-4" />{t.remove}</button>}
            <button type="button" onClick={onClose} className="btn-ghost ms-auto">{t.back}</button>
            <button type="submit" disabled={saving || !!state.busy} className="btn-primary group" data-own-save>
              <Icon name={it ? "check" : "plus"} className="icon-pop h-4 w-4" />{it ? t.ownSave : t.ownAdd}
            </button>
          </div>
        </form>
        {fileIn(camIn, true)}
        {fileIn(pickIn, false)}
      </div>
    </div>,
    document.body,
  );
}
