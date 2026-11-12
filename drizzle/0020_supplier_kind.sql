CREATE TYPE "public"."supplier_kind" AS ENUM('GOODS', 'EXPENSE');--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "kind" "supplier_kind" DEFAULT 'GOODS' NOT NULL;--> statement-breakpoint
-- Firmen, die nur über Ausgaben kamen (z. B. Baumarkt, Steuerbüro), aus der Lieferanten-Oberfläche nehmen (Wunsch Inhaber 12.11.2026).
-- EXPENSE = mindestens eine Ausgabe, keine davon Wareneinkauf (GOODS), bei keinem Artikel und in keinem Wareneingang.
-- Nur die Anzeige ändert sich; Nummern/Kreditoren (DATEV) bleiben. Vorher-Stand im audit_log.
WITH changes AS (
  SELECT s.id FROM suppliers s
  WHERE s.kind = 'GOODS'
    AND EXISTS (SELECT 1 FROM expenses e WHERE e.supplier_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.supplier_id = s.id AND e.category = 'GOODS')
    AND NOT EXISTS (SELECT 1 FROM products p WHERE p.supplier_id = s.id)
    AND NOT EXISTS (SELECT 1 FROM goods_receipts g WHERE g.supplier_id = s.id)
), upd AS (
  UPDATE suppliers s SET kind = 'EXPENSE', updated_at = now()
  FROM changes c WHERE s.id = c.id
  RETURNING s.id
)
INSERT INTO audit_log (id, entity, entity_id, action, before, after, user_id)
SELECT gen_random_uuid()::text, 'supplier', u.id, 'update', jsonb_build_object('kind', 'GOODS'),
       jsonb_build_object('kind', 'EXPENSE', 'reason', 'nur Ausgaben'), NULL
FROM upd u;
