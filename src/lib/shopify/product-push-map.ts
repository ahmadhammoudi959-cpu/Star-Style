/**
 * Artikel aus unserem System → neues Shopify-Produkt (productSet). Rein und getestet.
 * Grundsätze: Shop-Preis = Einzelhandelspreis (bei Shops mit Bruttopreisen inkl. MwSt.), Größe/Farbe werden Produkt-Optionen,
 * jede Variante bekommt Barcode, Art.-Nr. und den verfügbaren Bestand am Lagerort des Shops.
 */

export type PushVariant = {
  id: string; size: string; color: string; barcode: string | null;
  retailPriceCents: number | null; // eigener Preis der Variante, sonst Artikelpreis
  imageFileId: string | null; available: number;
};

export type PushProduct = {
  id: string; sku: string; nameDe: string; descriptionDe: string; category: string; vendor: string;
  vatRateBp: number; retailPriceCents: number; purchasePriceCents: number; imageFileId: string | null;
  variants: PushVariant[];
};

export type PushImage = { resourceUrl: string; filename: string };

export const SIZE_OPTION = "Größe";
export const COLOR_OPTION = "Farbe";
const PLACEHOLDER = "Standard";

/** Netto-Cent → Shop-Preis-Cent (Shops mit Bruttopreisen: inkl. MwSt.) */
export function shopPriceCents(netCents: number, vatRateBp: number, taxesIncluded: boolean): number {
  return taxesIncluded ? Math.round((netCents * (10000 + vatRateBp)) / 10000) : netCents;
}

const money = (cents: number) => (cents / 100).toFixed(2);

/** Beschreibung als einfaches HTML: Absätze bei Leerzeilen, sonst Zeilenumbrüche */
export function descriptionHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\r?\n/g, "<br>")}</p>`).join("");
}

/** Optionswerte je Variante. Leere Werte bei mehreren Varianten → „Standard“ (Shopify verlangt einen Wert je Option). */
export function variantOptions(variants: Pick<PushVariant, "size" | "color">[]): { names: string[]; values: string[][] } {
  const hasSize = variants.some((v) => v.size.trim());
  const hasColor = variants.some((v) => v.color.trim());
  if (!hasSize && !hasColor) return { names: ["Title"], values: variants.map(() => ["Default Title"]) };
  const names = [...(hasSize ? [SIZE_OPTION] : []), ...(hasColor ? [COLOR_OPTION] : [])];
  const seen = new Set<string>();
  const values = variants.map((v) => {
    const base = [...(hasSize ? [v.size.trim() || PLACEHOLDER] : []), ...(hasColor ? [v.color.trim() || PLACEHOLDER] : [])];
    let vals = base;
    // Kombination muss eindeutig sein (z. B. „“ und „Standard“ ergäben dasselbe) → letzten Wert nummerieren
    for (let k = 2; seen.has(vals.join("|").toLowerCase()); k++) vals = [...base.slice(0, -1), `${base[base.length - 1]} (${k})`];
    seen.add(vals.join("|").toLowerCase());
    return vals;
  });
  return { names, values };
}

/** Art.-Nr. im Shop: bei einer Variante die Artikelnummer, sonst Artikelnummer-Größe-Farbe */
/** SKU im Shop: Art.-Nr. = Barcode (Wunsch Inhaber) → der Barcode der Variante; ohne Barcode Art.-Nr. bzw. Art.-Nr.-Größe-Farbe */
export function variantSku(sku: string, v: Pick<PushVariant, "size" | "color"> & { barcode?: string | null }, single: boolean): string {
  if (v.barcode?.trim()) return v.barcode.trim();
  if (single) return sku;
  const part = (s: string) => s.trim().replace(/\s+/g, "-");
  return [sku, part(v.size), part(v.color)].filter(Boolean).join("-").slice(0, 255);
}

export function buildProductSet(p: PushProduct, o: { taxesIncluded: boolean; locationId: string; images: Map<string, PushImage> }) {
  const opts = variantOptions(p.variants);
  const single = p.variants.length === 1;
  // Fotos: Artikelfoto zuerst (Titelbild), dann eigene Fotos der Varianten – jedes nur einmal
  const fileIds = [p.imageFileId, ...p.variants.map((v) => v.imageFileId)].filter((f): f is string => Boolean(f && o.images.has(f)));
  const unique = [...new Set(fileIds)];
  const file = (id: string) => ({ originalSource: o.images.get(id)!.resourceUrl, contentType: "IMAGE", alt: p.nameDe, filename: o.images.get(id)!.filename });
  const optionValues = (k: number) => opts.names.map((n, i) => ({ optionName: n, name: opts.values[k][i] }));

  return {
    title: p.nameDe,
    ...(p.descriptionDe.trim() ? { descriptionHtml: descriptionHtml(p.descriptionDe) } : {}),
    ...(p.vendor.trim() ? { vendor: p.vendor.trim() } : {}),
    ...(p.category.trim() ? { productType: p.category.trim() } : {}),
    status: "ACTIVE",
    productOptions: opts.names.map((n, i) => ({
      name: n, position: i + 1,
      values: [...new Set(opts.values.map((v) => v[i]))].map((name) => ({ name })),
    })),
    ...(unique.length ? { files: unique.map(file) } : {}),
    variants: p.variants.map((v, k) => ({
      optionValues: optionValues(k),
      price: money(shopPriceCents(v.retailPriceCents ?? p.retailPriceCents, p.vatRateBp, o.taxesIncluded)),
      ...(v.barcode ? { barcode: v.barcode } : {}),
      inventoryItem: {
        sku: variantSku(p.sku, v, single), tracked: true,
        ...(p.purchasePriceCents > 0 ? { cost: money(p.purchasePriceCents) } : {}),
      },
      inventoryQuantities: [{ locationId: o.locationId, name: "available", quantity: Math.max(0, v.available) }],
      ...(v.imageFileId && o.images.has(v.imageFileId) && v.imageFileId !== p.imageFileId ? { file: file(v.imageFileId) } : {}),
    })),
  };
}

/** Welche Shop-Variante gehört zu welcher unserer Varianten? (über die Optionswerte, Reihenfolge als Rückfall) */
export function matchCreatedVariants(
  ours: Pick<PushVariant, "id" | "size" | "color">[],
  created: { id: string; selectedOptions: { name: string; value: string }[] }[],
): Map<string, string> {
  const opts = variantOptions(ours);
  const key = (vals: string[]) => vals.join("|").toLowerCase();
  const byKey = new Map<string, string>(created.map((c) => [key(opts.names.map((n) => c.selectedOptions.find((s) => s.name === n)?.value ?? "")), c.id]));
  const out = new Map<string, string>();
  ours.forEach((v, k) => {
    const id = byKey.get(key(opts.values[k])) ?? (ours.length === created.length ? created[k]?.id : undefined);
    if (id) out.set(v.id, id);
  });
  return out;
}

// ───────────────────────── Ergebnis für die Oberfläche ─────────────────────────

export type PushChannel = "BRAND_SHOP" | "GENERAL_SHOP";
export type PushOutcome = "created" | "createdHidden" | "linked" | "partial" | "failed";
export const PUSH_REASONS = ["noLocation", "noPrice", "currency", "noWriteAccess", "duplicate", "other"] as const;
export type PushReason = (typeof PUSH_REASONS)[number];
export type PushResult = { channel: PushChannel; outcome: PushOutcome; reason?: PushReason; missing?: number; imagesFailed?: boolean };

/** Kurzform für die Adresszeile nach dem Speichern, z. B. „GENERAL_SHOP.created..0~BRAND_SHOP.failed.noWriteAccess.0“ */
export function encodePush(results: PushResult[]): string {
  return results.map((r) => [r.channel, r.outcome, r.reason ?? (r.missing != null ? String(r.missing) : ""), r.imagesFailed ? "1" : "0"].join(".")).join("~");
}

/** Gegenstück zu encodePush – nur bekannte Werte werden übernommen */
export function decodePush(s: string | undefined): PushResult[] {
  if (!s) return [];
  const outcomes: PushOutcome[] = ["created", "createdHidden", "linked", "partial", "failed"];
  return s.split("~").slice(0, 2).flatMap((part) => {
    const [channel, outcome, extra = "", img = "0"] = part.split(".");
    if ((channel !== "BRAND_SHOP" && channel !== "GENERAL_SHOP") || !outcomes.includes(outcome as PushOutcome)) return [];
    const reason = (PUSH_REASONS as readonly string[]).includes(extra) ? (extra as PushReason) : undefined;
    const missing = /^\d{1,4}$/.test(extra) ? Number(extra) : undefined;
    return [{ channel, outcome: outcome as PushOutcome, ...(reason ? { reason } : {}), ...(missing != null ? { missing } : {}), imagesFailed: img === "1" }];
  });
}
