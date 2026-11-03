import "server-only";
/**
 * Barcode-Scanner (Wunsch Inhaber 03.11.2026): Code der Packung → alles zum Artikel auf einen Blick, nur lesen.
 * Treffer über den Barcode der Variante (auch UPC-A ↔ EAN-13), sonst über die Art.-Nr.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { barcodeCandidates } from "./barcode";

export type ScanVariant = {
  id: string; size: string; color: string; barcode: string | null; imageFileId: string | null;
  stock: number; reserved: number; available: number; minStock: number; weightGrams: number | null;
  nextExpiry: string | null; nextExpiryQty: number;
  wholesaleCents: number; retailCents: number;
  sold30: number; sold90: number; lastSale: string | null;
};
export type ScanShop = { channel: "BRAND_SHOP" | "GENERAL_SHOP"; ticked: boolean; linked: number; shownQty: number | null; syncOn: boolean };
export type ScanResult =
  | { found: false; code: string }
  | {
    found: true; code: string; matchedVariantId: string | null;
    product: {
      id: string; sku: string; nameDe: string; nameNl: string; category: string; imageFileId: string | null; supplier: string;
      vatRateBp: number; tracksExpiry: boolean; active: boolean;
    };
    variants: ScanVariant[];
    shops: ScanShop[];
  };

export async function lookupCode(raw: string): Promise<ScanResult> {
  const code = raw.replace(/\s+/g, "").trim().slice(0, 64);
  const candidates = barcodeCandidates(code);
  if (!candidates.length) return { found: false, code };

  // 1) Barcode einer Variante  2) Art.-Nr. des Artikels (ohne Groß/klein)
  let productId: string | null = null, matchedVariantId: string | null = null;
  const byBarcode = await db.execute<{ id: string; product_id: string }>(sql`
    select v.id, v.product_id from variants v where v.barcode in (${sql.join(candidates.map((c) => sql`${c}`), sql`, `)})
    order by v.active desc limit 1`);
  if (byBarcode.rows[0]) {
    productId = byBarcode.rows[0].product_id;
    matchedVariantId = byBarcode.rows[0].id;
  } else {
    const bySku = await db.execute<{ id: string }>(sql`select id from products where lower(sku) = lower(${code}) order by active desc limit 1`);
    productId = bySku.rows[0]?.id ?? null;
  }
  if (!productId) return { found: false, code };

  const p = (await db.execute<Record<string, unknown>>(sql`
    select p.id, p.sku, p.name_de, p.name_nl, p.category, p.image_file_id, p.vat_rate_bp, p.tracks_expiry, p.active,
           p.wholesale_price_cents, p.retail_price_cents, p.in_brand_shop, p.in_general_shop, coalesce(s.name, '') as supplier
    from products p left join suppliers s on s.id = p.supplier_id where p.id = ${productId}`)).rows[0];

  // je Größe/Farbe: Bestand, reserviert (offene Angebote), nächstes MHD, Preise, verkauft (Rechnungen abzüglich Stornos)
  const vs = await db.execute<Record<string, unknown>>(sql`
    select v.id, v.size, v.color, v.barcode, v.image_file_id, v.stock_qty, v.min_stock, v.wholesale_price_cents, v.retail_price_cents, v.weight_grams,
           coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0)::int as reserved,
           e.expiry as next_expiry,
           coalesce((select sum(b.qty_left) from batches b where b.variant_id = v.id and b.qty_left > 0 and b.expiry_date = e.expiry), 0)::int as next_expiry_qty,
           coalesce((select -sum(m.qty) from stock_movements m where m.variant_id = v.id and m.ref_type = 'invoice'
             and m.type in ('SALE', 'CANCEL') and m.created_at >= now() - interval '30 days'), 0)::int as sold30,
           coalesce((select -sum(m.qty) from stock_movements m where m.variant_id = v.id and m.ref_type = 'invoice'
             and m.type in ('SALE', 'CANCEL') and m.created_at >= now() - interval '90 days'), 0)::int as sold90,
           (select to_char(max(m.created_at) at time zone 'Europe/Berlin', 'YYYY-MM-DD') from stock_movements m
             where m.variant_id = v.id and m.ref_type = 'invoice' and m.type = 'SALE') as last_sale
    from variants v
    left join lateral (select min(b.expiry_date) as expiry from batches b where b.variant_id = v.id and b.qty_left > 0 and b.expiry_date is not null) e on true
    where v.product_id = ${productId} and (v.active or v.id = ${matchedVariantId ?? ""})
    order by v.created_at, v.id`);

  const shopRows = await db.execute<{ channel: "BRAND_SHOP" | "GENERAL_SHOP"; domain: string; secret: boolean; active: boolean; linked: number; shown: number | null }>(sql`
    select s.channel, s.domain, (s.client_secret_enc <> '' or s.static_token_enc <> '') as secret, s.active,
           (select count(distinct sv.variant_id) from shop_variants sv join variants v on v.id = sv.variant_id
             where sv.channel = s.channel and v.product_id = ${productId} and v.active)::int as linked,
           (select sum(sv.last_pushed_qty) from shop_variants sv join variants v on v.id = sv.variant_id
             where sv.channel = s.channel and v.product_id = ${productId} and v.active)::int as shown
    from shops s order by s.channel desc`);

  const wholesale = Number(p.wholesale_price_cents), retail = Number(p.retail_price_cents);
  return {
    found: true, code, matchedVariantId,
    product: {
      id: String(p.id), sku: String(p.sku), nameDe: String(p.name_de), nameNl: String(p.name_nl ?? ""), category: String(p.category ?? ""),
      imageFileId: (p.image_file_id as string | null) ?? null, supplier: String(p.supplier), vatRateBp: Number(p.vat_rate_bp),
      tracksExpiry: Boolean(p.tracks_expiry), active: Boolean(p.active),
    },
    variants: vs.rows.map((v) => {
      const stock = Number(v.stock_qty), reserved = Number(v.reserved);
      return {
        id: String(v.id), size: String(v.size ?? ""), color: String(v.color ?? ""), barcode: (v.barcode as string | null) ?? null,
        imageFileId: (v.image_file_id as string | null) ?? null, stock, reserved, available: stock - reserved, minStock: Number(v.min_stock),
        weightGrams: v.weight_grams == null ? null : Number(v.weight_grams),
        nextExpiry: v.next_expiry ? String(v.next_expiry).slice(0, 10) : null, nextExpiryQty: Number(v.next_expiry_qty),
        wholesaleCents: v.wholesale_price_cents != null ? Number(v.wholesale_price_cents) : wholesale,
        retailCents: v.retail_price_cents != null ? Number(v.retail_price_cents) : retail,
        sold30: Math.max(0, Number(v.sold30)), sold90: Math.max(0, Number(v.sold90)), lastSale: (v.last_sale as string | null) ?? null,
      };
    }),
    shops: shopRows.rows.filter((s) => s.domain && s.secret).map((s) => ({
      channel: s.channel, ticked: Boolean(s.channel === "BRAND_SHOP" ? p.in_brand_shop : p.in_general_shop),
      linked: Number(s.linked), shownQty: s.shown == null ? null : Number(s.shown), syncOn: Boolean(s.active),
    })),
  };
}
