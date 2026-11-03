"use client";
import { Icon } from "./Icon";

/** Klar beschriftete Auswahlliste „Kategorie“ – überall gleich (Wunsch Inhaber 03.11.2026: nach Kategorie wählen, als Dropdown).
 *  `autoSubmit`: in einem GET-Formular sofort filtern, ohne extra Knopf. */
export function CategorySelect({ categories, label, allLabel, value, defaultValue, onChange, name, autoSubmit = false, className = "" }: {
  categories: { name: string; n?: number }[]; label: string; allLabel: string;
  value?: string; defaultValue?: string; onChange?: (v: string) => void; name?: string; autoSubmit?: boolean; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label flex items-center gap-1.5"><Icon name="tag" className="h-4 w-4 text-brand-600" />{label}</span>
      <select name={name} {...(value !== undefined ? { value } : { defaultValue: defaultValue ?? "" })}
        onChange={(e) => { onChange?.(e.target.value); if (autoSubmit) e.currentTarget.form?.requestSubmit(); }}
        className={`input font-semibold ${(value ?? defaultValue) ? "border-brand-400 bg-brand-50 text-brand-800" : ""}`}>
        <option value="">{allLabel}</option>
        {categories.map((c) => <option key={c.name} value={c.name}>{c.name}{c.n != null ? ` (${c.n})` : ""}</option>)}
      </select>
    </label>
  );
}
