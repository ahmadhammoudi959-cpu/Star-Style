import "server-only";
/**
 * Werbebild einer Aktion erstellen (im Hintergrund, die Seite fragt den Stand ab): Texte von der KI (oder die vorhandenen beim
 * Neuzeichnen), Fotos der ersten vier Artikel, je Shop-Sprache ein breites (2400×800) und ein hohes (1080×1350) Bild →
 * stored_files. Danach Version +1 → die Shops laden neu hoch (src/lib/shopify/promo-shop.ts).
 * „running“ älter als 5 min (Server neu gestartet) gilt als abgebrochen.
 */
import { createHash } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { audit } from "./stock";
import { promoCopy, type BannerCopy, type CopyLang, COPY_LANGS } from "./ai/promo-copy";
import { BANNER_FORMATS, BANNER_STYLES, preparePhotos, renderBanner } from "./promo-banner";
import { syncPromoShops } from "./shopify/promo-shop";

export const BANNER_SHOWN = 4; // so viele Artikel zeigt das Bild, der Rest als „+n weitere“
const STALE = sql`interval '5 minutes'`;

type Opts = { restyle?: boolean; copy?: Record<string, BannerCopy> | null; keepStyle?: boolean };

/** Startet die Erstellung; "running" = läuft schon. Wirft nichts – Fehler stehen danach in banner_error. */
export async function startBannerJob(id: string, userId: string, opts: Opts = {}): Promise<"started" | "running" | "notFound"> {
  const r = await db.execute<{ id: string }>(sql`update promotions set banner_job = 'running', banner_error = '', updated_at = now()
    where id = ${id} and (banner_job <> 'running' or updated_at < now() - ${STALE}) returning id`);
  if (!r.rows.length) {
    const exists = await db.query.promotions.findFirst({ where: eq(schema.promotions.id, id), columns: { id: true } });
    return exists ? "running" : "notFound";
  }
  void runJob(id, userId, opts).catch(async (e) => {
    console.error("promo banner", e);
    await db.update(schema.promotions).set({ bannerJob: "failed", bannerError: String((e as Error)?.message ?? e).slice(0, 300) }).where(eq(schema.promotions.id, id)).catch(() => {});
  });
  return "started";
}

/** Läuft die Erstellung (noch nicht zu alt)? */
export const jobRunning = (p: { bannerJob: string; updatedAt: Date }) => p.bannerJob === "running" && Date.now() - p.updatedAt.getTime() < 5 * 60_000;

async function runJob(id: string, userId: string, opts: Opts) {
  const p = await db.query.promotions.findFirst({ where: eq(schema.promotions.id, id) });
  if (!p) return;
  const items = (await db.execute<Record<string, unknown>>(sql`
    select pr.id, pr.name_de, pr.name_nl, pr.category,
      coalesce(pr.image_file_id, (select v.image_file_id from variants v where v.product_id = pr.id and v.active and v.image_file_id is not null order by v.created_at limit 1),
        (select m.file_id from shop_media m where m.product_id = pr.id and not m.removed and not m.hidden order by m.position limit 1)) as photo
    from promotion_items i join products pr on pr.id = i.product_id where i.promotion_id = ${id} order by i.position`)).rows;
  if (!items.length) throw new Error("noItems");
  // Artikel mit Foto zuerst aufs Bild (die Reihenfolge bleibt sonst die der Aktion)
  const shown = [...items].sort((a, b) => Number(!a.photo) - Number(!b.photo)).slice(0, BANNER_SHOWN);
  const products = shown.map((x) => ({ name: String(x.name_de), nameNl: String(x.name_nl ?? ""), category: String(x.category ?? "") }));

  const fromAi = !opts.copy;
  const copy = opts.copy && COPY_LANGS.every((l) => opts.copy?.[l]) ? opts.copy as Record<CopyLang, BannerCopy>
    : (await promoCopy(products, p.bannerVersion)).copy;
  const ai = fromAi; // Texte neu geschrieben (KI oder feste Texte)
  const style = opts.keepStyle || opts.copy ? p.bannerStyle : opts.restyle ? (p.bannerStyle + 1) % BANNER_STYLES : p.bannerStyle;

  const photoIds = shown.map((x) => (x.photo ? String(x.photo) : null));
  const fileRows = photoIds.some(Boolean)
    ? await db.select({ id: schema.storedFiles.id, data: schema.storedFiles.data }).from(schema.storedFiles).where(inArray(schema.storedFiles.id, photoIds.filter((x): x is string => !!x)))
    : [];
  const photos = await preparePhotos(photoIds.map((pid) => (pid ? fileRows.find((f) => f.id === pid)?.data ?? null : null)));
  // „+n weitere“: alle Artikel zählen, gezeigt werden höchstens vier
  const morePhotos = [...photos, ...Array(Math.max(0, items.length - shown.length)).fill(null)];
  const until = p.priceOn && p.priceUntil ? p.priceUntil : null;

  const created: Record<string, string> = {};
  for (const lang of COPY_LANGS) {
    for (const format of BANNER_FORMATS) {
      const buf = await renderBanner({ lang, format, discountBp: p.discountBp, copy: copy[lang], photos: morePhotos, until, style });
      const [row] = await db.insert(schema.storedFiles).values({
        name: `aktion-${p.number}-${format}-${lang}.webp`, mime: "image/webp", size: buf.length,
        sha256: createHash("sha256").update(buf).digest("hex"), data: buf,
      }).returning({ id: schema.storedFiles.id });
      created[`${format}-${lang}`] = row.id;
    }
  }
  await db.transaction(async (tx) => {
    const cur = await tx.query.promotions.findFirst({ where: eq(schema.promotions.id, id) });
    if (!cur) { await tx.delete(schema.storedFiles).where(inArray(schema.storedFiles.id, Object.values(created))); return; }
    const old = Object.values(cur.bannerFiles ?? {});
    await tx.update(schema.promotions).set({
      bannerCopy: copy, bannerFiles: created, bannerStyle: style, bannerVersion: cur.bannerVersion + 1, bannerJob: "", bannerError: "",
    }).where(eq(schema.promotions.id, id));
    if (old.length) await tx.delete(schema.storedFiles).where(inArray(schema.storedFiles.id, old));
    await audit(tx, { entity: "promotion", entityId: id, action: "banner", after: { version: cur.bannerVersion + 1, style, newText: ai, copy }, userId });
  });
  void syncPromoShops().catch((e) => console.error("promo shops", e));
}
