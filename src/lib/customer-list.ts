import "server-only";
/** Kundenliste aus der Datenbank (Seite /customers und Excel-Liste /api/customers/export); Filter rein in ./customer-filter.ts */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { determineTaxMode, type TaxMode } from "./tax";
import { NEW_DAYS, type CustomerRow, type PriceGroup, type ShopCh } from "./customer-filter";
import { shopNewAtSql } from "./shopify/customers";

export async function loadCustomerRows(): Promise<CustomerRow[]> {
  // Herkunft (System/Shop) + Shop-Konten (Wunsch Inhaber 13.11.2026): je Kunde die Shops, in denen er ein Konto hat oder bestellt hat
  const res = await db.execute<Record<string, unknown>>(sql`
    select c.id, c.number, c.type, c.name, c.contact, c.email, c.phone, c.street, c.zip, c.city, c.country, c.vat_id, c.vat_id_status, c.price_group,
      to_char(c.created_at at time zone 'Europe/Berlin', 'YYYY-MM-DD') as created_day,
      c.from_shop, coalesce((select array_agg(distinct sc.channel) from shop_customers sc where sc.customer_id = c.id), '{}') as shops,
      ${shopNewAtSql} as shop_new_at
    from customers c where c.active order by c.name`);
  const str = (v: unknown) => String(v ?? "");
  return res.rows.map((r) => ({
    id: str(r.id), number: Number(r.number), type: r.type === "PERSON" ? "PERSON" : "COMPANY", name: str(r.name), contact: str(r.contact),
    email: str(r.email), phone: str(r.phone), street: str(r.street), zip: str(r.zip), city: str(r.city), country: str(r.country),
    vatId: str(r.vat_id), group: r.price_group as PriceGroup, createdDay: str(r.created_day),
    fromShop: r.from_shop === "GENERAL_SHOP" || r.from_shop === "BRAND_SHOP" ? r.from_shop : null,
    shops: ((r.shops as string[] | null) ?? []).filter((x): x is ShopCh => x === "GENERAL_SHOP" || x === "BRAND_SHOP").sort(),
    isNew: r.shop_new_at != null && Date.now() - new Date(str(r.shop_new_at)).getTime() < NEW_DAYS * 86_400_000,
    mode: determineTaxMode({ type: r.type as "COMPANY", country: str(r.country), vatIdStatus: r.vat_id_status as "NONE" }) as TaxMode,
  }));
}
