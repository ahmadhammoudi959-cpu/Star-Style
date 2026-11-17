/**
 * Alle Fotos eines Artikels für die Kundenansicht im Artikel-Fenster (Wunsch Inhaber 17.11.2026: „wie ein Katalog“):
 * Lagerfoto, Fotos der Größen/Farben, dann die Shop-Fotos (allgemeiner Shop, dann Marken-Shop; ohne gelöschte und
 * „nur im Shop gelöschte“) – ohne Doppelte (gleiche Datei oder gleicher Inhalt per sha256), nur Bilder.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const PRODUCT_PHOTOS_MAX = 24;
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export type PhotoRow = { fileId: string; sha256: string; mime: string };

/** rein: Reihenfolge bleibt, Doppelte und Nicht-Bilder fallen weg */
export function uniquePhotos(rows: PhotoRow[], max = PRODUCT_PHOTOS_MAX): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.fileId || !IMAGE_MIME.has(r.mime)) continue;
    const ids = [`id:${r.fileId}`, `sha:${r.sha256}`];
    if (ids.some((k) => seen.has(k))) continue;
    ids.forEach((k) => seen.add(k));
    out.push(r.fileId);
    if (out.length >= max) break;
  }
  return out;
}

export async function productPhotoIds(productId: string): Promise<string[]> {
  const r = await db.execute<{ file_id: string; sha256: string; mime: string }>(sql`
    with p as (
      select 0 as grp, 0::bigint as pos, image_file_id as file_id from products where id = ${productId} and image_file_id is not null
      union all
      select 1, row_number() over (order by created_at, id), image_file_id from variants where product_id = ${productId} and image_file_id is not null
      union all
      select case when channel = 'GENERAL_SHOP' then 2 else 3 end, position::bigint, file_id from shop_media
        where product_id = ${productId} and not removed and not hidden
    )
    select p.file_id, f.sha256, f.mime from p join stored_files f on f.id = p.file_id order by p.grp, p.pos`);
  return uniquePhotos(r.rows.map((x) => ({ fileId: String(x.file_id), sha256: String(x.sha256), mime: String(x.mime) })));
}
