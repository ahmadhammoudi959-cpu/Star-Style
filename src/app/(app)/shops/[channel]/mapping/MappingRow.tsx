"use client";
import { useTransition } from "react";
import { linkAction } from "../../actions";
import { VariantPicker, type PickerOption } from "@/components/VariantPicker";
import type { Dict } from "@/i18n/de";

type Row = { id: string; title: string; sku: string; barcode: string; tracked: boolean; variantId: string | null; ourName: string; matchedBy: string; pushError: string; lastPushedQty: number | null };

export function MappingRow({ t, channel, row, options }: { t: Dict; channel: string; row: Row; options: PickerOption[] }) {
  const [pending, start] = useTransition();
  return (
    <tr className={pending ? "opacity-50" : ""}>
      <td className="align-top">
        <div className="font-semibold">{row.title}</div>
        <div className="text-xs text-ink-soft" dir="ltr">{[row.sku, row.barcode].filter(Boolean).join(" · ") || "—"}</div>
        {!row.tracked && <div className="text-xs font-semibold text-amber-700">{t.shop.notTracked}</div>}
        {row.pushError && <div className="text-xs font-semibold text-red-600" dir="ltr">{row.pushError}</div>}
      </td>
      <td className="w-[45%] align-top">
        {row.variantId ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{row.ourName}</span>
            {row.matchedBy && <span className="badge bg-brand-50 text-brand-700">{(t.shop.matchedBy as Record<string, string>)[row.matchedBy] ?? row.matchedBy}</span>}
            {row.lastPushedQty !== null && <span className="badge bg-slate-100 text-slate-700">{t.shop.pushed}: {row.lastPushedQty}</span>}
            <button type="button" onClick={() => start(async () => { await linkAction(channel, row.id, null); })} className="text-xs font-semibold text-red-600 hover:underline">{t.shop.unlink}</button>
          </div>
        ) : (
          <VariantPicker options={options} placeholder={t.shop.pick} stockLabel={t.ins.stock} onPick={(o) => start(async () => { await linkAction(channel, row.id, o.id); })} />
        )}
      </td>
    </tr>
  );
}
