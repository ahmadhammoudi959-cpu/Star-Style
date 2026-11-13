ALTER TABLE "customers" ADD COLUMN "from_shop" "channel";--> statement-breakpoint
-- Herkunft der vorhandenen Kunden (Wunsch Inhaber 13.11.2026: „تفصل بين الزباين يلي بكريتها من السيستم والزباين يلي جاية من المتجرين“):
-- vom Shop-Kunden-Abgleich angelegt → dieser Shop; aus einer Shop-Bestellung angelegt (Notiz „aus Shopify angelegt“) → Shop der
-- ersten Rechnung (sonst allgemeiner Shop); alle anderen bleiben null = im System angelegt. Protokoll im audit_log.
WITH src AS (
  SELECT c.id, coalesce(
    (SELECT sc.channel::channel FROM shop_customers sc WHERE sc.customer_id = c.id AND sc.created_customer
      ORDER BY coalesce(sc.registered_at, sc.created_at) LIMIT 1),
    CASE WHEN c.notes = 'aus Shopify angelegt' THEN coalesce(
      (SELECT i.channel FROM invoices i WHERE i.customer_id = c.id AND i.channel IN ('GENERAL_SHOP', 'BRAND_SHOP') ORDER BY i.created_at LIMIT 1),
      'GENERAL_SHOP'::channel) END) AS ch
  FROM customers c WHERE c.from_shop IS NULL
), upd AS (
  UPDATE customers c SET from_shop = s.ch FROM src s WHERE s.id = c.id AND s.ch IS NOT NULL RETURNING c.id, c.from_shop
)
INSERT INTO audit_log (id, entity, entity_id, action, before, after, user_id)
SELECT gen_random_uuid()::text, 'customer', u.id, 'update', jsonb_build_object('from_shop', NULL),
       jsonb_build_object('from_shop', u.from_shop, 'reason', 'Herkunft'), NULL
FROM upd u;
