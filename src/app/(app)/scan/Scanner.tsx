"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Thumb } from "@/components/Thumb";
import { formatCents } from "@/lib/money";
import { formatDate } from "@/lib/dates";
import { checkDigitOk } from "@/lib/barcode";
import { formatWeight } from "@/lib/weight";
import type { ScanResult, ScanVariant } from "@/lib/scan";
import { scanLookupAction } from "./actions";
import type { Dict } from "@/i18n/de";

type Detected = { rawValue: string; format: string };
type Detector = { detect: (src: HTMLCanvasElement) => Promise<Detected[]> };
type Phase = "idle" | "starting" | "scanning" | "looking" | "result" | "error";
type CamError = "denied" | "noCamera" | "insecure" | "other" | "lookup";

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "code_93", "itf", "codabar", "qr_code", "data_matrix"];
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/** Eingebauter Barcode-Leser (Android/Chrome), sonst ZXing als WebAssembly (iPhone, Firefox …) */
async function createDetector(): Promise<Detector> {
  const Native = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.includes("ean_13")) return new Native({ formats });
    } catch { /* weiter mit dem eigenen Leser */ }
  }
  const m = await import("barcode-detector/ponyfill");
  await m.prepareZXingModule({
    overrides: { locateFile: (p: string, prefix: string) => (p.endsWith(".wasm") ? `/api/zxing/${m.ZXING_WASM_VERSION}` : prefix + p) },
    fireImmediately: true,
  });
  return new m.BarcodeDetector({ formats: FORMATS as never }) as unknown as Detector;
}

// kurzer Piepton als Bestätigung (geht erst nach einer ersten Berührung, z. B. „Nummer eintippen“)
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) { audio ??= new AC(); if (audio.state === "suspended") void audio.resume(); }
  } catch { /* ohne Ton */ }
}
function feedback() {
  // Vibrieren nur nach einer Berührung erlaubt (sonst meckert der Browser)
  try { if ((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive) navigator.vibrate?.(80); } catch { /* kein Vibrieren */ }
  try {
    if (!audio || audio.state !== "running") return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = 1250; g.gain.value = 0.07;
    o.connect(g); g.connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.09);
  } catch { /* ohne Ton */ }
}

/**
 * Barcode-Scanner (Wunsch Inhaber 03.11.2026): Kamera des Handys im Browser, Barcode der Packung → Bestand im Lager, verfügbar,
 * Preise, Verkäufe, MHD, Shops. Nur lesen. Gelesen wird nur der mittlere Bereich (Rahmen), damit nicht die Nachbarpackung trifft.
 */
export function Scanner({ t, intl }: { t: Dict; intl: string }) {
  const S = t.scan;
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<Detector | null>(null);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // nach „Nächsten Artikel scannen“ die gerade gezeigte Packung kurz ignorieren (sie ist meist noch im Bild)
  const lastRef = useRef<{ code: string; until: number }>({ code: "", until: 0 });
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<CamError | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [torch, setTorch] = useState({ supported: false, on: false });
  const [manual, setManual] = useState("");
  const [recent, setRecent] = useState<Extract<ScanResult, { found: true }>[]>([]);

  const stopCamera = useCallback(() => {
    if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorch({ supported: false, on: false });
  }, []);

  const lookup = useCallback(async (code: string) => {
    stopCamera();
    setPhase("looking"); setError(null);
    let r: ScanResult | null = null;
    try { r = await scanLookupAction(code); } catch { r = null; }
    if (!r) { setError("lookup"); setPhase("error"); return; }
    setResult(r); setPhase("result");
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (r.found) {
      const hit = r;
      setRecent((list) => [hit, ...list.filter((x) => !(x.product.id === hit.product.id && x.matchedVariantId === hit.matchedVariantId))].slice(0, 6));
    }
  }, [stopCamera]);

  const tick = useCallback(async () => {
    timerRef.current = null;
    const video = videoRef.current, det = detectorRef.current;
    if (!video || !det || !streamRef.current) return;
    if (video.readyState >= 2 && video.videoWidth) {
      // nur der Bereich im Rahmen: 80 % der Breite, 50 % der Höhe, mittig
      const w = video.videoWidth, h = video.videoHeight, cw = Math.round(w * 0.8), ch = Math.round(h * 0.5);
      const c = (canvasRef.current ??= document.createElement("canvas"));
      c.width = cw; c.height = ch;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, (w - cw) / 2, (h - ch) / 2, cw, ch, 0, 0, cw, ch);
        try {
          const last = lastRef.current;
          const hit = (await det.detect(c)).map((x) => x.rawValue.trim())
            .find((v) => v && checkDigitOk(v) && !(v === last.code && Date.now() < last.until));
          if (hit && streamRef.current) { feedback(); lastRef.current = { code: hit, until: 0 }; void lookup(hit); return; }
        } catch { /* dieses Bild nicht lesbar – nächstes */ }
      }
    }
    if (streamRef.current) timerRef.current = window.setTimeout(() => void tick(), 140);
  }, [lookup]);

  const startCamera = useCallback(async () => {
    stopCamera();
    setResult(null); setError(null); setPhase("starting");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setError("insecure"); setPhase("error"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) { stopCamera(); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setTorch({ supported: Boolean(caps.torch), on: false });
      detectorRef.current ??= await createDetector();
      if (!streamRef.current) return; // inzwischen beendet
      setPhase("scanning");
      void tick();
    } catch (e) {
      console.error("scanner", e);
      const name = (e as { name?: string })?.name;
      stopCamera();
      setError(name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" || name === "OverconstrainedError" ? "noCamera" : "other");
      setPhase("error");
    }
  }, [stopCamera, tick]);

  // beim Öffnen gleich die Kamera; Seite im Hintergrund → Kamera aus (Akku)
  useEffect(() => {
    void startCamera();
    const onHide = () => { if (document.hidden && streamRef.current) { stopCamera(); setPhase((p) => (p === "scanning" || p === "starting" ? "idle" : p)); } };
    document.addEventListener("visibilitychange", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); stopCamera(); };
  }, [startCamera, stopCamera]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const on = !torch.on;
    try { await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }); setTorch({ supported: true, on }); } catch { /* geht nicht */ }
  };
  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    unlockAudio();
    const code = manual.trim();
    if (code) { setManual(""); void lookup(code); }
  };
  const again = () => {
    unlockAudio();
    lastRef.current = { code: lastRef.current.code, until: Date.now() + 2500 };
    window.scrollTo({ top: 0, behavior: "smooth" });
    void startCamera();
  };
  const camVisible = phase === "starting" || phase === "scanning";

  return (
    <div className="mx-auto max-w-xl space-y-4">
      {/* Kamera */}
      <section className={`card overflow-hidden animate-rise ${camVisible ? "" : "hidden"}`}>
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-navy-900">
          <video ref={videoRef} muted playsInline autoPlay className="absolute inset-0 h-full w-full object-cover" />
          {/* Rahmen wie der gelesene Bereich */}
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="relative h-1/2 w-4/5 rounded-2xl shadow-[0_0_0_100vmax_rgba(10,18,40,0.45)] ring-2 ring-white/90">
              {phase === "scanning" && <div className="scan-line absolute inset-x-3 h-0.5 rounded-full bg-accent-500 shadow-[0_0_12px_2px_rgba(227,25,28,0.7)]" />}
            </div>
          </div>
          {phase === "starting" && (
            <div className="absolute inset-0 grid place-items-center text-sm font-semibold text-white">
              <span className="flex items-center gap-2"><span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />{S.starting}</span>
            </div>
          )}
          {torch.supported && (
            <button type="button" onClick={toggleTorch} aria-pressed={torch.on}
              className={`absolute end-3 top-3 grid h-11 w-11 place-items-center rounded-full shadow-lift transition ${torch.on ? "bg-amber-400 text-navy-900" : "bg-black/50 text-white"}`}
              aria-label={torch.on ? S.torchOff : S.torchOn}>
              <Icon name="bolt" className="h-5 w-5" />
            </button>
          )}
        </div>
        <p className="flex items-center justify-center gap-2 px-4 py-3 text-center text-sm font-semibold text-ink-soft">
          <Icon name="scan" className="h-4 w-4 text-brand-600" />{S.hint}
        </p>
      </section>

      {phase === "looking" && (
        <div className="card flex animate-rise items-center justify-center gap-2 p-8 text-sm font-semibold text-ink-soft">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />{S.looking}
        </div>
      )}

      {(phase === "error" || phase === "idle") && (
        <div className="card animate-rise space-y-3 p-5 text-center">
          {phase === "error" && error && (
            <p className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-start text-sm font-semibold text-amber-900 ring-1 ring-amber-200">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />{S.errors[error]}
            </p>
          )}
          <button type="button" onClick={again} className="btn-primary group w-full py-3 text-base"><Icon name="camera" className="h-5 w-5" />{S.startCamera}</button>
        </div>
      )}

      {phase === "result" && result && <ResultCard t={t} intl={intl} r={result} onAgain={again} />}

      {/* Nummer eintippen – wenn der Barcode kaputt ist oder keine Kamera da ist */}
      <form onSubmit={submitManual} className="card animate-rise p-4">
        <label className="label" htmlFor="scan-manual">{S.manual}</label>
        <div className="flex gap-2">
          <input id="scan-manual" value={manual} onChange={(e) => setManual(e.target.value)} placeholder={S.manualPlaceholder}
            dir="ltr" autoComplete="off" enterKeyHint="search" className="input num min-w-0 flex-1" />
          <button className="btn-ghost group shrink-0"><Icon name="search" className="h-4 w-4" />{S.find}</button>
        </div>
      </form>

      {recent.length > 0 && (
        <section className="card animate-rise p-4">
          <h2 className="mb-2 text-sm font-bold text-ink-soft">{S.recent}</h2>
          <ul className="divide-y divide-black/5">
            {recent.map((r) => {
              const v = matched(r);
              return (
                <li key={`${r.product.id}:${r.matchedVariantId}`}>
                  <button type="button" onClick={() => { stopCamera(); setResult(r); setPhase("result"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                    className="flex w-full items-center gap-3 py-2 text-start hover:text-brand-700">
                    <Thumb id={v?.imageFileId ?? r.product.imageFileId} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{r.product.nameDe}</span>
                      {v && label(v) && <span className="block truncate text-xs text-ink-soft" dir="auto">{label(v)}</span>}
                    </span>
                    <span className="num text-sm font-bold">{v ? v.stock : r.variants.reduce((s, x) => s + x.stock, 0)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <details className="card animate-rise p-4 text-sm">
        <summary className="flex cursor-pointer items-center gap-2 font-semibold"><Icon name="home" className="h-4 w-4 text-brand-600" />{S.homeIcon}</summary>
        <p className="mt-2 leading-relaxed text-ink-soft">{S.homeIconHint}</p>
      </details>
    </div>
  );
}

const label = (v: ScanVariant) => [v.size, v.color].filter(Boolean).join(" · ");
const matched = (r: Extract<ScanResult, { found: true }>) =>
  r.variants.find((x) => x.id === r.matchedVariantId) ?? (r.variants.length === 1 ? r.variants[0] : null);

function ResultCard({ t, intl, r, onAgain }: { t: Dict; intl: string; r: ScanResult; onAgain: () => void }) {
  const S = t.scan;
  if (!r.found) {
    return (
      <section id="scan-result" aria-live="polite" className="card animate-rise space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-600"><Icon name="alert" className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{S.notFoundTitle}</h2>
            <p className="text-sm text-ink-soft">{S.notFound} <bdi dir="ltr" className="num font-bold text-ink [overflow-wrap:anywhere]">{r.code}</bdi></p>
          </div>
        </div>
        <button type="button" onClick={onAgain} className="btn-primary group w-full py-3 text-base"><Icon name="scan" className="h-5 w-5" />{S.again}</button>
        <div className="grid gap-2 sm:grid-cols-2">
          <Link href={`/products/new?barcode=${encodeURIComponent(r.code)}`} className="btn-ghost group"><Icon name="plus" className="h-4 w-4" />{S.newProduct}</Link>
          <Link href={`/products?q=${encodeURIComponent(r.code)}`} className="btn-ghost group"><Icon name="search" className="h-4 w-4" />{S.searchName}</Link>
        </div>
      </section>
    );
  }

  const p = r.product;
  const v = matched(r);
  const total = r.variants.reduce((a, x) => ({ stock: a.stock + x.stock, reserved: a.reserved + x.reserved, sold30: a.sold30 + x.sold30, sold90: a.sold90 + x.sold90 }),
    { stock: 0, reserved: 0, sold30: 0, sold90: 0 });
  const stock = v ? v.stock : total.stock, reserved = v ? v.reserved : total.reserved;
  const min = v?.minStock ?? 0;
  const state = stock <= 0 ? "out" : min > 0 && stock <= min ? "low" : "ok";
  const tone = { out: "from-red-500 to-red-700", low: "from-amber-400 to-orange-500", ok: "from-emerald-500 to-teal-600" }[state];
  const lastSale = v ? v.lastSale : r.variants.map((x) => x.lastSale).filter(Boolean).sort().pop() ?? null;
  const expiry = (v ? [v] : r.variants).filter((x) => x.nextExpiry).sort((a, b) => a.nextExpiry!.localeCompare(b.nextExpiry!))[0];
  const priceOf = v ?? r.variants[0];
  const gross = (c: number) => Math.round((c * (10000 + p.vatRateBp)) / 10000);

  return (
    <section id="scan-result" aria-live="polite" className="card animate-rise overflow-hidden">
      {/* Kopf: Foto, Name, Größe/Farbe, Barcode */}
      <div className="flex gap-3 p-4">
        <Thumb id={v?.imageFileId ?? p.imageFileId} size={84} />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-bold leading-snug [overflow-wrap:anywhere]">{p.nameDe}</h2>
          {p.nameNl && <div className="text-xs text-ink-soft [overflow-wrap:anywhere]" dir="auto">{p.nameNl}</div>}
          <div className="flex flex-wrap items-center gap-1.5">
            {v && label(v) && <span className="badge bg-brand-50 text-brand-700" dir="auto">{label(v)}</span>}
            {p.category && <span className="badge bg-black/5 text-ink-soft">{p.category}</span>}
            {!p.active && <span className="badge bg-red-50 text-red-700">{S.inactive}</span>}
          </div>
          <bdi dir="ltr" className="num block text-xs text-ink-soft [overflow-wrap:anywhere]">{v?.barcode ?? p.sku}</bdi>
        </div>
      </div>

      {/* Bestand im Lager – groß */}
      <div className={`mx-4 rounded-2xl bg-gradient-to-br ${tone} p-4 text-white shadow-lift`}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-white/85">{v || r.variants.length === 1 ? S.inStock : S.inStockAll}</div>
            <div className="num text-5xl font-bold leading-none">{stock}</div>
          </div>
          <span className="rounded-full bg-white/20 px-3 py-1 text-sm font-bold">{S.state[state]}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 text-sm text-white/90">
          <span>{S.available}: <b className="num">{stock - reserved}</b></span>
          {reserved > 0 && <span>{S.reserved}: <b className="num">{reserved}</b></span>}
          {min > 0 && <span>{S.minStock}: <b className="num">{min}</b></span>}
        </div>
      </div>

      {/* alle Größen/Farben */}
      {r.variants.length > 1 && (
        <div className="mx-4 mt-3 rounded-xl ring-1 ring-black/5">
          <div className="flex items-center justify-between px-3 pt-2 text-xs font-semibold text-ink-soft">
            <span>{S.variants}</span><span>{fill(S.totalStock, { n: total.stock })}</span>
          </div>
          <ul className="divide-y divide-black/5 text-sm">
            {r.variants.map((x) => (
              <li key={x.id} className={`flex items-center justify-between gap-3 px-3 py-2 ${x.id === v?.id ? "bg-brand-50 font-bold text-brand-800" : ""}`}>
                <span className="min-w-0 truncate" dir="auto">{label(x) || p.nameDe}</span>
                <span className="flex shrink-0 items-center gap-3">
                  {x.reserved > 0 && <span className="text-xs text-ink-soft">{S.available}: <span className="num">{x.available}</span></span>}
                  <span className={`num ${x.stock <= 0 ? "text-red-600" : x.minStock > 0 && x.stock <= x.minStock ? "text-amber-600" : ""}`}>{x.stock}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Preise, Verkäufe, MHD, Lieferant */}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-3 p-4 text-sm">
        <Fact label={S.wholesale}><span className="num font-bold">{formatCents(priceOf.wholesaleCents, intl)}</span></Fact>
        <Fact label={S.retail}>
          <span className="num font-bold">{formatCents(priceOf.retailCents, intl)}</span>
          <span className="block text-xs text-ink-soft">{S.withVat}: <span className="num">{formatCents(gross(priceOf.retailCents), intl)}</span></span>
        </Fact>
        <Fact label={S.sold30}><span className="num font-bold">{v ? v.sold30 : total.sold30}</span></Fact>
        <Fact label={S.sold90}><span className="num font-bold">{v ? v.sold90 : total.sold90}</span></Fact>
        <Fact label={S.lastSale}>{lastSale ? <span className="num font-semibold">{formatDate(lastSale, intl)}</span> : <span className="text-ink-soft">{S.neverSold}</span>}</Fact>
        {expiry && <Fact label={S.expiry}><span className="num font-semibold">{formatDate(expiry.nextExpiry, intl)}</span> <span className="text-xs text-ink-soft">({fill(S.pieces, { n: expiry.nextExpiryQty })})</span></Fact>}
        {priceOf.weightGrams ? <Fact label={S.weight}><span className="num font-semibold">{formatWeight(priceOf.weightGrams)}</span></Fact> : null}
        {p.supplier && <Fact label={S.supplier}><span className="font-semibold [overflow-wrap:anywhere]">{p.supplier}</span></Fact>}
      </dl>

      {/* Online-Shops */}
      {r.shops.length > 0 && (
        <div className="mx-4 mb-4 space-y-1.5">
          <div className="text-xs font-semibold text-ink-soft">{S.online}</div>
          {r.shops.map((s) => (
            <div key={s.channel} className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-sm ring-1 ${s.linked > 0 ? "bg-emerald-50 text-emerald-800 ring-emerald-100" : "bg-black/[0.03] text-ink-soft ring-black/5"}`}>
              <Icon name="globe" className="h-4 w-4 shrink-0" />
              <span className="font-semibold">{t.shop.names[s.channel]}:</span>
              <span>{s.linked > 0 ? S.listed : S.notListed}</span>
              {s.linked > 0 && s.syncOn && s.shownQty != null && <span className="text-xs">· {fill(S.shown, { n: s.shownQty })}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2 border-t border-black/5 bg-brand-50/40 p-4">
        <button type="button" onClick={onAgain} className="btn-primary group w-full py-3 text-base"><Icon name="scan" className="h-5 w-5" />{S.again}</button>
        <div className="grid grid-cols-2 gap-2">
          {v && <Link href={`/stock/${v.id}`} className="btn-ghost group"><Icon name="layers" className="h-4 w-4" />{S.openStock}</Link>}
          <Link href={`/products/${p.id}`} className={`btn-ghost group ${v ? "" : "col-span-2"}`}><Icon name="eye" className="h-4 w-4" />{S.openProduct}</Link>
        </div>
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-0.5">{children}</dd></div>;
}
