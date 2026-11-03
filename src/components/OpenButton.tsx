import Link from "next/link";
import { Icon } from "./Icon";

/** Deutlicher Knopf „Öffnen/عرض“ in jeder Liste (Wunsch Inhaber 03.11.2026: nicht suchen müssen, wo man klickt) */
export function OpenButton({ href, label, className = "px-3 py-1.5 text-xs" }: { href: string; label: string; className?: string }) {
  return (
    <Link href={href} className={`btn group gap-1.5 whitespace-nowrap bg-brand-600 text-white shadow-card hover:bg-brand-700 hover:shadow-lift ${className}`}>
      <Icon name="eye" className="h-4 w-4" />{label}
    </Link>
  );
}
