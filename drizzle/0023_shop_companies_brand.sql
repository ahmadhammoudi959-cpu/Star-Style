-- Großhandelspreise (جملة الجملة) jetzt in beiden Shops (Wunsch Inhaber 13.11.2026: „كل شي بمتجر البراند زي المتجر العام“).
-- Ein Häkchen am Kunden gilt für beide Shops: wer im allgemeinen Shop eingeschaltet ist, wird auch im Marken-Shop vorgemerkt
-- (Status pending → der Worker verbindet ihn beim nächsten Durchlauf). Nichts wird gelöscht; Protokoll im audit_log.
WITH added AS (
  INSERT INTO shop_companies (id, customer_id, channel, wanted, status)
  SELECT gen_random_uuid()::text, g.customer_id, 'BRAND_SHOP', true, 'pending'
  FROM shop_companies g
  WHERE g.channel = 'GENERAL_SHOP' AND g.wanted
    AND NOT EXISTS (SELECT 1 FROM shop_companies b WHERE b.customer_id = g.customer_id AND b.channel = 'BRAND_SHOP')
  RETURNING customer_id
)
INSERT INTO audit_log (id, entity, entity_id, action, before, after, user_id)
SELECT gen_random_uuid()::text, 'customer', a.customer_id, 'shop_reseller', NULL,
       jsonb_build_object('channel', 'BRAND_SHOP', 'wanted', true, 'reason', 'beide Shops'), NULL
FROM added a;
