"use client";
import { Icon, type IconName } from "./Icon";

/** Beschriftete Auswahlliste für Listen-Filter (GET-Formular): Auswahl filtert sofort, ohne Knopf. */
export function FilterSelect({ name, label, allLabel, options, defaultValue = "", icon = "tag", className = "" }: {
  name: string; label: string; allLabel: string; options: { value: string; label: string }[]; defaultValue?: string; icon?: IconName; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="label flex items-center gap-1.5"><Icon name={icon} className="h-4 w-4 text-brand-600" />{label}</span>
      <select name={name} defaultValue={defaultValue} onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className={`input font-semibold ${defaultValue ? "border-brand-400 bg-brand-50 text-brand-800" : ""}`}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
