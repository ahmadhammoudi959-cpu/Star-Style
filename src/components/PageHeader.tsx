import Link from "next/link";
import { Icon } from "./Icon";

export function PageHeader({ title, subtitle, back, actions }: { title: string; subtitle?: string; back?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3 animate-rise">
      <div className="flex items-center gap-3">
        {back && <Link href={back} className="btn-ghost group h-10 w-10 p-0"><Icon name="arrowLeft" className="h-5 w-5 rtl:rotate-180" /></Link>}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-ink-soft">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
