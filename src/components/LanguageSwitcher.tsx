"use client";
import { useState } from "react";
import { setLocale } from "@/app/actions-auth";
import { Icon } from "./Icon";

const LABELS = { de: "Deutsch", ar: "العربية", en: "English", ku: "Kurdî" } as const;
type Lang = keyof typeof LABELS;

export function LanguageSwitcher({ current, compact = false }: { current: Lang; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState<Lang>(current);
  // Nach dem Speichern die Seite neu laden statt router.refresh(): refresh() in einer Transition blieb
  // ab und zu hängen (Auswahl grau, Sprache alt, 07.11.2026). Neu laden setzt auch lang/dir und Schrift sicher.
  const change = async (l: Lang) => {
    if (l === current || busy) return;
    setValue(l);
    setBusy(true);
    try { await setLocale(l); } finally { window.location.reload(); }
  };
  return (
    <label className={`group flex items-center gap-2 rounded-xl ${compact ? "" : "bg-white px-3 py-2 shadow-card ring-1 ring-black/5"}`}>
      <Icon name="globe" className="h-4 w-4 text-brand-600" />
      <select
        aria-label="Language"
        disabled={busy}
        value={value}
        onChange={(e) => change(e.target.value as Lang)}
        className="cursor-pointer bg-transparent text-sm font-semibold text-ink outline-none"
      >
        {(Object.keys(LABELS) as Lang[]).map((l) => <option key={l} value={l} lang={l}>{LABELS[l]}</option>)}
      </select>
    </label>
  );
}
