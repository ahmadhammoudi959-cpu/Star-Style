/**
 * Preis mit Aktion (Wunsch Inhaber 19.11.2026: „المنتج … ككارت … يطلع عليه انه 20% ينشحط السعر“): rotes „-20%“,
 * alter Preis durchgestrichen, neuer Preis – im Artikel-Fenster, im Katalog, in der Kundenansicht und am Bestell-Link.
 */
export function PromoPrice({ price, was, pct, className = "" }: { price: string; was?: string | null; pct?: number | null; className?: string }) {
  if (!pct) return <span className={`num ${className}`}>{price}</span>;
  return (
    <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5" dir="ltr" data-promo-price>
      <span className="badge self-center bg-accent-600 px-1.5 py-0 text-[0.6875rem] font-black text-white">-{pct}%</span>
      {was && <s className="num text-[0.75em] font-normal text-ink-soft">{was}</s>}
      <span className={`num text-accent-700 ${className}`}>{price}</span>
    </span>
  );
}

/** Rotes Abzeichen in der Ecke einer Karte (Katalog) */
export function PromoCorner({ pct }: { pct?: number | null }) {
  if (!pct) return null;
  return <span className="num pointer-events-none absolute start-2 top-2 z-[1] rounded-full bg-accent-600 px-2 py-0.5 text-xs font-black text-white shadow-card" dir="ltr" data-promo-corner>-{pct}%</span>;
}
