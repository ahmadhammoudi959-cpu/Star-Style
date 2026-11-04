import { fill } from "@/i18n";
import type { CategoryStoreState } from "@/lib/shopify/category-map";
import type { Dict } from "@/i18n/de";

/** Zustand einer Kategorie in einem Shop: gleicher Name ✓ / unter einer anderen Shop-Kategorie / fehlt */
export function StoreChip({ t, st }: { t: Dict; st: CategoryStoreState | undefined }) {
  if (!st) return null;
  if (st.state === "missing") return <span className="badge bg-slate-100 text-slate-600">{t.cat.store.missing}</span>;
  return (
    <span className={`badge ring-1 ${st.state === "same" ? "bg-emerald-50 text-emerald-700 ring-emerald-100" : "bg-brand-50 text-brand-700 ring-brand-100"}`}>
      {st.state === "same" ? t.cat.store.same : fill(t.cat.store.mapped, { c: st.label })}
    </span>
  );
}
