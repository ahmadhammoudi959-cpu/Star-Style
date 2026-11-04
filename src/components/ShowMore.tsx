import Link from "next/link";
import { Icon } from "./Icon";

/** Lange Listen schrittweise (Wunsch Inhaber 04.11.2026: Lager lädt sonst zu lange) – je Klick STEP Zeilen mehr */
export const LIST_STEP = 60;

/** Anzahl sichtbarer Zeilen aus der Adresszeile (?n=…), immer ein Vielfaches von LIST_STEP */
export function listLimit(n: string | undefined): number {
  const v = Math.floor(Number(n) || 0);
  return Math.min(Math.max(LIST_STEP, Math.ceil(v / LIST_STEP) * LIST_STEP), 5000);
}

/** „Weitere anzeigen“ unter der Liste; die Seite bleibt an ihrer Stelle (scroll={false}) */
export function ShowMore({ shown, total, href, more, showing }: { shown: number; total: number; href: string; more: string; showing: string }) {
  if (shown >= total) return null;
  return (
    <div className="mt-4 flex flex-col items-center gap-2 animate-rise">
      <span className="text-xs text-ink-soft">{showing}</span>
      <Link href={href} scroll={false} className="btn-primary group px-6"><Icon name="plus" className="icon-pop h-4 w-4" />{more}</Link>
    </div>
  );
}
