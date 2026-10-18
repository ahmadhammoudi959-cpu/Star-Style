import Link from "next/link";
import { Icon } from "@/components/Icon";
import { shiftMonth } from "@/lib/periods";

/** Monatsauswahl ‹ Oktober 2026 › – Pfeile spiegeln sich in RTL automatisch. */
export function MonthNav({ month, base, months, extra = "", locked }: { month: string; base: string; months: readonly string[]; extra?: string; locked?: boolean }) {
  const [y, m] = month.split("-");
  const href = (mm: string) => `${base}?month=${mm}${extra}`;
  return (
    <div className="inline-flex items-center gap-1 rounded-xl bg-white p-1 shadow-card ring-1 ring-black/5">
      <Link href={href(shiftMonth(month, -1))} className="group grid h-9 w-9 place-items-center rounded-lg hover:bg-brand-50" aria-label="‹"><Icon name="arrowLeft" className="h-4 w-4 rtl:rotate-180" /></Link>
      <span className="flex min-w-36 items-center justify-center gap-1.5 px-2 text-sm font-bold">{locked && <Icon name="lock" className="h-3.5 w-3.5 text-amber-600" />}{months[Number(m) - 1]} {y}</span>
      <Link href={href(shiftMonth(month, 1))} className="group grid h-9 w-9 place-items-center rounded-lg hover:bg-brand-50" aria-label="›"><Icon name="arrowRight" className="h-4 w-4 rtl:rotate-180" /></Link>
    </div>
  );
}
