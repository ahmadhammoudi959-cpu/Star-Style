"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setLocale } from "@/app/actions-auth";
import { Icon } from "./Icon";

const LABELS = { de: "Deutsch", ar: "العربية", en: "English" } as const;

export function LanguageSwitcher({ current, compact = false }: { current: "de" | "ar" | "en"; compact?: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <label className={`group flex items-center gap-2 rounded-xl ${compact ? "" : "bg-white px-3 py-2 shadow-card ring-1 ring-black/5"}`}>
      <Icon name="globe" className="h-4 w-4 text-brand-600" />
      <select
        aria-label="Language"
        disabled={pending}
        value={current}
        onChange={(e) => start(async () => { await setLocale(e.target.value as "de"); router.refresh(); })}
        className="cursor-pointer bg-transparent text-sm font-semibold text-ink outline-none"
      >
        {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((l) => <option key={l} value={l}>{LABELS[l]}</option>)}
      </select>
    </label>
  );
}
