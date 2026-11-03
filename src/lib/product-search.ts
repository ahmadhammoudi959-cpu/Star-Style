/** Artikelsuche – überall gleich (Wunsch Inhaber 03.11.2026): Name (DE/NL), Art.-Nr., Barcode, Größe/Farbe oder Kategorie. Rein, getestet. */
export type SearchableOption = {
  id: string; sku: string; nameDe: string; nameNl: string; size: string; color: string; barcode: string | null; productId?: string; category?: string;
};

/** Treffer; exakter Barcode bzw. exakte Art.-Nr. zuerst. Leere Suche → alle. */
export function searchOptions<T extends SearchableOption>(options: T[], q: string): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return options;
  const exact = options.filter((o) => o.barcode === s || o.sku.toLowerCase() === s);
  const rest = options.filter((o) => !exact.includes(o) &&
    [o.nameDe, o.nameNl, o.sku, o.barcode ?? "", o.size, o.color, o.category ?? ""].some((f) => f.toLowerCase().includes(s)));
  return [...exact, ...rest];
}

/** Kategorien mit Anzahl der Artikel (nicht Varianten), alphabetisch */
export function categoryCounts(options: SearchableOption[]): { name: string; n: number }[] {
  const m = new Map<string, Set<string>>();
  for (const o of options) {
    if (!o.category) continue;
    if (!m.has(o.category)) m.set(o.category, new Set());
    m.get(o.category)!.add(o.productId ?? o.id);
  }
  return [...m.entries()].map(([name, ids]) => ({ name, n: ids.size })).sort((a, b) => a.name.localeCompare(b.name, "de"));
}
