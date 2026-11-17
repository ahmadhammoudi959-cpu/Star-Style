"use client";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { importProductsAction, type ImportState } from "./actions";

type T = Dict["pimport"];

async function upload(file: File): Promise<{ id?: string; error?: string }> {
  const res = await fetch("/api/temp-files", { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: file });
  const j = await res.json().catch(() => ({})) as { id?: string; error?: string };
  return res.ok && j.id ? { id: j.id } : { error: j.error ?? "fileUpload" };
}

/** Schritt 1: Excel/CSV wählen (+ Fotos dazu) → hochladen → Vorschau */
export function ImportUpload({ t }: { t: T }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sheet, setSheet] = useState<File | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const go = async () => {
    if (!sheet) return;
    setBusy(true); setErr(null);
    const s = await upload(sheet);
    if (!s.id) { setErr((t.errors as Record<string, string>)[s.error ?? ""] ?? t.errors.failed); setBusy(false); return; }
    const ids: string[] = [];
    for (const p of photos.slice(0, 200)) { const r = await upload(p); if (r.id) ids.push(r.id); }
    router.push(`/products/import?file=${s.id}${ids.length ? `&photos=${ids.join(",")}` : ""}`);
  };
  return (
    <section className="card animate-rise space-y-4 p-5">
      <label className="block">
        <span className="label">{t.upload}</span>
        <input type="file" accept=".xlsx,.xlsm,.csv" onChange={(e) => setSheet(e.target.files?.[0] ?? null)} data-import-file
          className="input file:me-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:font-semibold file:text-brand-700" />
      </label>
      <label className="block">
        <span className="label">{t.photos}</span>
        <input type="file" accept="image/*" multiple onChange={(e) => setPhotos([...(e.target.files ?? [])])}
          className="input file:me-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-1 file:font-semibold file:text-brand-700" />
      </label>
      <p className="text-sm text-ink-soft">{t.uploadHint}</p>
      {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 ring-1 ring-red-200">{err}</p>}
      <button type="button" onClick={() => void go()} disabled={!sheet || busy} className="btn-primary group">
        {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="upload" className="h-4 w-4" />}
        {busy ? t.uploading : t.check}
      </button>
    </section>
  );
}

/** Schritt 3: importieren (alle Einstellungen gehen als versteckte Felder mit; der Server prüft alles neu) */
export function ImportForm({ t, hidden, count, canShops }: { t: T; hidden: [string, string][]; count: number; canShops: boolean }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importProductsAction, undefined);
  const err = state?.error ? (t.errors as Record<string, string>)[state.error] ?? t.errors.failed : null;
  return (
    <form action={action} className="card animate-rise space-y-4 p-5" data-import-form>
      {hidden.map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {canShops && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold">{t.shops}</legend>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="general" defaultChecked className="h-5 w-5 accent-brand-600" />{t.shopGeneral}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="brand" className="h-5 w-5 accent-brand-600" />{t.shopBrand}</label>
        </fieldset>
      )}
      {err && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700 ring-1 ring-red-200">{err}</p>}
      <button type="submit" disabled={!count || pending} className="btn-primary group w-full justify-center py-3 sm:w-auto" data-import-submit>
        {pending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <Icon name="check" className="h-4 w-4" />}
        {pending ? t.importing : t.importN.replace("{n}", String(count))}
      </button>
    </form>
  );
}
