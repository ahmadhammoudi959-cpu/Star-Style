"use client";

/** Häkchen in einem GET-Filterformular, das sofort filtert (kein extra Knopf nötig) */
export function AutoSubmitCheckbox({ name, value = "1", defaultChecked, label }: { name: string; value?: string; defaultChecked?: boolean; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-xl bg-white px-3 py-2.5 text-sm font-semibold ring-1 ring-black/10 hover:bg-brand-50">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-5 w-5 accent-brand-600" />
      {label}
    </label>
  );
}
