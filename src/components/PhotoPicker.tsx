"use client";
import { useRef, useState } from "react";
import { Icon } from "./Icon";
import { shrinkImage } from "@/lib/image-client";

/**
 * Foto wählen oder mit der Handy-Kamera aufnehmen; wird vor dem Hochladen verkleinert.
 * Sendet die Datei unter `name`, und `${name}Remove=1`, wenn das bisherige Foto entfernt wurde.
 */
export function PhotoPicker({ name, initialId, size = 128, labels, compact = false }: {
  name: string; initialId?: string | null; size?: number; compact?: boolean;
  labels: { add: string; change: string; remove: string; processing: string; error: string };
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(initialId ? `/api/files/${initialId}` : null);
  const [removed, setRemoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function onFile(f: File | undefined) {
    if (!f || !input.current) return;
    setErr(""); setBusy(true);
    try {
      const small = await shrinkImage(f);
      const dt = new DataTransfer(); dt.items.add(small); input.current.files = dt.files;
      setPreview(URL.createObjectURL(small)); setRemoved(false);
    } catch {
      input.current.value = ""; setErr(labels.error);
    } finally { setBusy(false); }
  }

  function remove() {
    if (input.current) input.current.value = "";
    setPreview(null); setRemoved(true);
  }

  const box = { width: size, height: size };
  return (
    <div className={compact ? "flex items-center gap-2" : "flex flex-wrap items-center gap-4"}>
      <button type="button" onClick={() => input.current?.click()} style={box} title={preview ? labels.change : labels.add}
        className="group relative shrink-0 overflow-hidden rounded-xl bg-brand-50 ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-lift">
        {preview
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={preview} alt="" className="h-full w-full object-cover" />
          : <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-brand-600">
              <Icon name="camera" className={compact ? "h-5 w-5" : "h-8 w-8"} />
              {!compact && <span className="px-2 text-center text-xs font-semibold">{labels.add}</span>}
            </span>}
        {busy && <span className="absolute inset-0 flex items-center justify-center bg-white/80 text-xs font-semibold">{labels.processing}</span>}
      </button>
      <input ref={input} type="file" name={name} accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
      {removed && <input type="hidden" name={`${name}Remove`} value="1" />}
      {!compact && (
        <div className="flex flex-col gap-2">
          <button type="button" className="btn-ghost group" onClick={() => input.current?.click()}>
            <Icon name="camera" className="h-4 w-4" />{preview ? labels.change : labels.add}
          </button>
          {preview && <button type="button" className="text-start text-sm font-semibold text-red-600 hover:underline" onClick={remove}>{labels.remove}</button>}
        </div>
      )}
      {err && <p className="w-full text-sm font-semibold text-red-600">{err}</p>}
    </div>
  );
}
