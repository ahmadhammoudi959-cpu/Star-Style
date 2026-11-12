"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { formatDateTime } from "@/lib/dates";
import type { Dict } from "@/i18n/de";
import type { BackupSummary } from "@/lib/backup";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const PART = 8 * 1024 * 1024; // wie PART_MAX auf dem Server (Proxy-Grenzen)
const MAX_NUMBERS = 6;

type Phase =
  | { k: "idle" }
  | { k: "upload"; p: number }
  | { k: "check" }
  | { k: "ready"; id: string; s: BackupSummary }
  | { k: "restore"; p: number; date: string }
  | { k: "done"; date: string }
  | { k: "error"; code: string };

class Fail extends Error { constructor(public code: string) { super(code); } }

/**
 * Datensicherung (Wunsch Inhaber 12.11.2026): „Jetzt sichern“ lädt eine verschlüsselte Datei mit allem herunter.
 * Zurückholen in 3 Schritten: Datei wählen (wird hochgeladen und geprüft, nichts geändert) → ansehen, was verloren geht →
 * bestätigen. Hochladen in Stücken (8 MB) über /api/backup/upload, Zurückholen läuft im Hintergrund, die Seite fragt den Stand ab.
 */
export function BackupPanel({ t, sizeMb, last }: { t: Dict; sizeMb: number; last: { at: string; who: string; mb: number }[] }) {
  const b = t.backup;
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [ask, setAsk] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = phase.k === "upload" || phase.k === "check" || phase.k === "restore";

  // Seite nicht aus Versehen verlassen, solange hochgeladen oder zurückgeholt wird
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const errText = (code: string) => (b.errors as Record<string, string>)[code] ?? b.errors.error;

  async function choose(file: File) {
    const id = crypto.randomUUID();
    const parts = Math.max(1, Math.ceil(file.size / PART));
    try {
      for (let i = 0; i < parts; i++) {
        const lastPart = i === parts - 1;
        setPhase(lastPart ? { k: "check" } : { k: "upload", p: Math.round((i / parts) * 100) });
        let res: Response;
        try {
          res = await fetch(`/api/backup/upload?id=${id}&part=${i}${lastPart ? "&last=1" : ""}`, {
            method: "POST", body: file.slice(i * PART, Math.min(file.size, (i + 1) * PART)), headers: { "content-type": "application/octet-stream" },
          });
        } catch { throw new Fail("network"); }
        const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; summary?: BackupSummary };
        if (!res.ok || !j.ok) throw new Fail(j.error ?? "error");
        if (lastPart) {
          if (!j.summary) throw new Fail("error");
          setPhase({ k: "ready", id, s: j.summary });
        }
      }
    } catch (e) {
      setPhase({ k: "error", code: e instanceof Fail ? e.code : "error" });
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  async function restore(id: string, date: string) {
    setAsk(false);
    setPhase({ k: "restore", p: 0, date });
    try {
      const res = await fetch("/api/backup/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Fail(j.error ?? "error");
    } catch (e) {
      setPhase({ k: "error", code: e instanceof Fail ? e.code : "network" });
      return;
    }
    // Stand abfragen; kurze Aussetzer (z. B. WLAN) überstehen – das Zurückholen läuft auf dem Server weiter
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(`/api/backup/restore?id=${id}`, { cache: "no-store" });
        if (res.status === 404) { setPhase({ k: "error", code: "failed" }); return; }
        if (!res.ok) throw new Error(String(res.status));
        const j = (await res.json()) as { state: "running" | "done" | "failed"; done: number; total: number };
        misses = 0;
        if (j.state === "done") { setPhase({ k: "done", date }); return; }
        if (j.state === "failed") { setPhase({ k: "error", code: "failed" }); return; }
        setPhase({ k: "restore", p: Math.min(99, Math.round((j.done / Math.max(1, j.total)) * 100)), date });
      } catch {
        if (++misses > 120) { setPhase({ k: "error", code: "network" }); return; }
      }
    }
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      {/* Sichern */}
      <section className="card animate-rise p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600"><Icon name="download" className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{b.downloadTitle}</h2>
            <p className="text-sm text-ink-soft">{b.downloadHint}</p>
          </div>
        </div>
        <a href="/api/backup/download" download onClick={() => setStarted(true)}
          className="btn-primary group mt-5 w-full py-3 text-base sm:w-auto sm:px-6" data-backup-download>
          <Icon name="download" className="h-5 w-5" />{b.download}
        </a>
        <p className="hint mt-2">{fill(b.size, { mb: sizeMb })}</p>
        {started && (
          <p role="status" className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900 ring-1 ring-emerald-100">
            <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0" />{b.started}
          </p>
        )}
        <h3 className="mt-6 text-sm font-bold">{b.lastTitle}</h3>
        {last.length ? (
          <ul className="mt-2 divide-y divide-black/5 rounded-xl bg-slate-50 text-sm ring-1 ring-black/[0.03]">
            {last.map((x) => (
              <li key={x.at + x.who} className="flex flex-wrap items-baseline justify-between gap-x-3 px-3 py-2">
                <span className="num font-semibold">{x.at}</span>
                <span className="text-xs text-ink-soft">{x.who} · <bdi dir="ltr" className="num">{x.mb} MB</bdi></span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">{b.never}</p>
        )}
      </section>

      {/* Zurückholen */}
      <section className="card animate-rise p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-700"><Icon name="history" className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold">{b.restoreTitle}</h2>
            <p className="text-sm text-ink-soft">{b.restoreHint}</p>
          </div>
        </div>

        <input ref={input} type="file" accept=".ssbak,application/octet-stream" className="sr-only" id="backup-file" data-backup-file
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }} disabled={busy} />

        {(phase.k === "idle" || phase.k === "error") && (
          <div className="mt-5 space-y-3">
            {phase.k === "error" && (
              <p role="alert" className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 ring-1 ring-red-200">
                <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />{errText(phase.code)}
              </p>
            )}
            <label htmlFor="backup-file" className="btn-ghost group w-full cursor-pointer py-3 sm:w-auto sm:px-6">
              <Icon name="upload" className="h-5 w-5" />{b.choose}
            </label>
          </div>
        )}

        {(phase.k === "upload" || phase.k === "check") && (
          <Progress label={phase.k === "upload" ? fill(b.uploading, { p: phase.p }) : b.checking} p={phase.k === "upload" ? phase.p : null} />
        )}

        {phase.k === "ready" && <Summary t={t} s={phase.s} onRestore={() => setAsk(true)} onOther={() => input.current?.click()} />}

        {phase.k === "restore" && <Progress label={fill(b.restoring, { p: phase.p })} p={phase.p} tone="amber" />}

        {phase.k === "done" && (
          <div className="mt-5 space-y-3">
            <p role="status" className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm font-bold text-emerald-900 ring-1 ring-emerald-200">
              <Icon name="check" className="mt-0.5 h-5 w-5 shrink-0" />{fill(b.done, { date: phase.date })}
            </p>
            <button type="button" onClick={() => location.reload()} className="btn-primary group w-full sm:w-auto sm:px-6">
              <Icon name="history" className="h-5 w-5" />{b.reload}
            </button>
          </div>
        )}
      </section>

      {ask && phase.k === "ready" && (
        <Confirm t={t} s={phase.s} onNo={() => setAsk(false)} onYes={() => void restore(phase.id, formatDateTime(phase.s.createdAt))} />
      )}
    </div>
  );
}

function Progress({ label, p, tone = "brand" }: { label: string; p: number | null; tone?: "brand" | "amber" }) {
  return (
    <div className="mt-5" role="status" aria-live="polite">
      <p className="mb-2 text-sm font-semibold">{label}</p>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
        {p === null
          ? <div className="ss-slide h-full w-1/3 rounded-full bg-gradient-to-r from-brand-600 via-brand-400 to-accent-500" />
          : <div className={`h-full rounded-full transition-[width] duration-500 ${tone === "amber" ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${Math.max(3, p)}%` }} />}
      </div>
    </div>
  );
}

function lostLines(t: Dict, s: BackupSummary): string[] {
  const b = t.backup;
  const out: string[] = [];
  const inv = s.lost.invoices;
  if (inv.length) out.push(fill(b.lostInvoices, { n: inv.length, list: (inv.length > MAX_NUMBERS ? [...inv.slice(0, MAX_NUMBERS), "…"] : inv).join(", ") }));
  if (s.lost.payments) out.push(fill(b.lostPayments, { n: s.lost.payments }));
  if (s.lost.exports) out.push(fill(b.lostExports, { n: s.lost.exports }));
  return out;
}

function Summary({ t, s, onRestore, onOther }: { t: Dict; s: BackupSummary; onRestore: () => void; onOther: () => void }) {
  const b = t.backup;
  const lost = lostLines(t, s);
  return (
    <div className="mt-5 space-y-3" data-backup-summary>
      <div className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-black/[0.03]">
        <p className="font-bold">{fill(b.from, { date: formatDateTime(s.createdAt) })}</p>
        {s.createdBy && <p className="text-xs text-ink-soft">{fill(b.createdBy, { who: s.createdBy })}</p>}
        <p className="mt-1 text-sm">{fill(b.contains, { p: s.counts.products, c: s.counts.customers, i: s.counts.invoices, f: s.counts.files })}</p>
      </div>
      {lost.length ? (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <p className="font-bold">{b.lostTitle}</p>
          <ul className="mt-1 list-disc space-y-0.5 ps-5">{lost.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>
      ) : (
        <p className="rounded-xl bg-emerald-50 px-4 py-2 text-sm text-emerald-900 ring-1 ring-emerald-100">{b.nothingLost}</p>
      )}
      {s.blocked ? (
        <>
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800 ring-1 ring-red-200">
            <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />{(b.blocked as Record<string, string>)[s.blocked] ?? b.errors.error}
          </p>
          <button type="button" onClick={onOther} className="btn-ghost group w-full sm:w-auto sm:px-6"><Icon name="upload" className="h-5 w-5" />{b.choose}</button>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-soft">{b.alsoLost}</p>
          <p className="text-sm text-ink-soft">{b.keeps}</p>
          <div className="flex flex-col gap-2">
            <button type="button" onClick={onRestore} data-backup-restore
              className="btn group w-full bg-red-600 py-3 text-base text-white shadow-card hover:bg-red-700">
              <Icon name="history" className="h-5 w-5" />{b.restore}
            </button>
            <button type="button" onClick={onOther} className="btn-ghost group w-full"><Icon name="upload" className="h-5 w-5" />{b.choose}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Letzte Rückfrage als eigenes Fenster: Häkchen nötig, Fokus auf „Abbrechen“, Esc/Hintergrund schließt */
function Confirm({ t, s, onYes, onNo }: { t: Dict; s: BackupSummary; onYes: () => void; onNo: () => void }) {
  const b = t.backup;
  const [sure, setSure] = useState(false);
  const noRef = useRef(onNo);
  noRef.current = onNo;
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") noRef.current(); };
    document.addEventListener("keydown", esc);
    cancel.current?.focus({ preventScroll: true });
    return () => { document.body.style.overflow = prev; document.removeEventListener("keydown", esc); };
  }, []);
  const lost = lostLines(t, s);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-navy-900/50 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="backup-ask-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) noRef.current(); }}>
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-2xl bg-white p-5 shadow-lift animate-rise sm:rounded-2xl">
        <div className="mb-3 flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-red-50 text-red-600"><Icon name="alert" className="h-6 w-6" /></span>
          <div className="min-w-0">
            <h2 id="backup-ask-title" className="text-lg font-bold leading-snug">{fill(b.confirmTitle, { date: formatDateTime(s.createdAt) })}</h2>
            <p className="mt-1 text-sm text-ink-soft">{b.confirmText}</p>
          </div>
        </div>
        <ul className="space-y-1.5 text-sm">
          {[...lost, b.alsoLost, b.keeps].map((f) => (
            <li key={f} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2"><Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />{f}</li>
          ))}
        </ul>
        <a href="/api/backup/download" download className="btn-ghost group mt-3 w-full text-sm"><Icon name="download" className="h-4 w-4" />{b.downloadNow}</a>
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm font-semibold">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-red-600" data-backup-sure />
          {b.confirmCheck}
        </label>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" onClick={onYes} disabled={!sure} data-backup-yes
            className="btn group w-full bg-red-600 py-3 text-base text-white shadow-card hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40">
            <Icon name="history" className="h-5 w-5" />{b.restore}
          </button>
          <button ref={cancel} type="button" onClick={onNo} className="btn-ghost w-full">{t.common.cancel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
