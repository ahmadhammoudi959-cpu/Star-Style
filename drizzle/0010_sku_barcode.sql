-- Art.-Nr. = Barcode (Wunsch Inhaber 03.11.2026): Artikel bekommen den Barcode ihrer ersten Variante (Reihenfolge wie im Formular)
-- als Art.-Nr. – vorher standen dort z. B. Shop-Handles („aufbewahrungsschrank-bordeaux-dc006“).
-- Artikel ohne Barcode bleiben unverändert; ebenso, falls ein anderer Artikel diese Nummer schon trägt.
-- Jede Änderung mit Vorher-Stand im audit_log.
WITH first_bc AS (
  SELECT DISTINCT ON (v.product_id) v.product_id, v.barcode
  FROM variants v
  WHERE v.active AND v.barcode IS NOT NULL AND btrim(v.barcode) <> ''
  ORDER BY v.product_id, v.created_at, v.id
), changes AS (
  SELECT p.id, p.sku AS old_sku, f.barcode AS new_sku
  FROM products p JOIN first_bc f ON f.product_id = p.id
  WHERE p.sku <> f.barcode
    AND NOT EXISTS (SELECT 1 FROM products o WHERE o.id <> p.id AND lower(o.sku) = lower(f.barcode))
), upd AS (
  UPDATE products p SET sku = c.new_sku, updated_at = now()
  FROM changes c WHERE p.id = c.id
  RETURNING p.id
)
INSERT INTO audit_log (id, entity, entity_id, action, before, after, user_id)
SELECT gen_random_uuid()::text, 'product', c.id, 'update', jsonb_build_object('sku', c.old_sku),
       jsonb_build_object('sku', c.new_sku, 'reason', 'Art.-Nr. = Barcode'), NULL
FROM changes c JOIN upd u ON u.id = c.id;
--> statement-breakpoint
-- zweiter Durchgang: Nummern, die erst durch den ersten Durchgang frei wurden
WITH first_bc AS (
  SELECT DISTINCT ON (v.product_id) v.product_id, v.barcode
  FROM variants v
  WHERE v.active AND v.barcode IS NOT NULL AND btrim(v.barcode) <> ''
  ORDER BY v.product_id, v.created_at, v.id
), changes AS (
  SELECT p.id, p.sku AS old_sku, f.barcode AS new_sku
  FROM products p JOIN first_bc f ON f.product_id = p.id
  WHERE p.sku <> f.barcode
    AND NOT EXISTS (SELECT 1 FROM products o WHERE o.id <> p.id AND lower(o.sku) = lower(f.barcode))
), upd AS (
  UPDATE products p SET sku = c.new_sku, updated_at = now()
  FROM changes c WHERE p.id = c.id
  RETURNING p.id
)
INSERT INTO audit_log (id, entity, entity_id, action, before, after, user_id)
SELECT gen_random_uuid()::text, 'product', c.id, 'update', jsonb_build_object('sku', c.old_sku),
       jsonb_build_object('sku', c.new_sku, 'reason', 'Art.-Nr. = Barcode'), NULL
FROM changes c JOIN upd u ON u.id = c.id;
