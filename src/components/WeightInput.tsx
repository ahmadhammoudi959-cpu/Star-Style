"use client";
import { parseWeight, type WeightUnit } from "@/lib/weight";

/** Gewicht eingeben: Zahl + Einheit (g/kg); „1,5 kg“ oder „250 g“ im Text gehen auch */
export function WeightInput({ value, unit, onChange, unitLabel, id }: {
  value: string; unit: WeightUnit; onChange: (v: { weight: string; weightUnit: WeightUnit }) => void; unitLabel: string; id?: string;
}) {
  const bad = value.trim() !== "" && parseWeight(value, unit) === undefined;
  return (
    <div className="relative" dir="ltr">
      <input id={id} inputMode="decimal" value={value} placeholder="0" autoComplete="off"
        onChange={(e) => onChange({ weight: e.target.value, weightUnit: unit })}
        className={`input num pe-[4.25rem] ${bad ? "border-red-400 ring-4 ring-red-100" : ""}`} />
      <select aria-label={unitLabel} value={unit} onChange={(e) => onChange({ weight: value, weightUnit: e.target.value as WeightUnit })}
        className="absolute inset-y-1 end-1 w-16 cursor-pointer rounded-lg border-0 bg-brand-50 ps-2 text-sm font-bold text-brand-700 focus:ring-2 focus:ring-brand-300">
        <option value="g">g</option>
        <option value="kg">kg</option>
      </select>
    </div>
  );
}
