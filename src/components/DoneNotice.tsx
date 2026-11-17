import { Icon } from "./Icon";

/** Grüne Erfolgsmeldung oben auf einer Seite (z. B. „Lieferant Nr. 5 wurde gelöscht.“) */
export function DoneNotice({ text }: { text: string }) {
  return (
    <div role="status" data-done-notice className="mb-4 flex animate-rise items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
      <Icon name="check" className="h-4 w-4 shrink-0" />{text}
    </div>
  );
}

/** ?deleted=<Nummer> → Nummer (nur ganze Zahlen, sonst nichts anzeigen) */
export const deletedNumber = (v: string | undefined) => (v && /^\d{1,9}$/.test(v) ? Number(v) : null);
