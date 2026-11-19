import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { isCatalogPhoto, linkGroup } from "@/lib/direct";

export const dynamic = "force-dynamic";

const IMAGES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

/** Foto für den Bestell-Link (öffentlich): nur mit gültigem Token und nur Fotos von Artikeln aus dem Katalog – sonst nichts */
export async function GET(_: Request, { params }: { params: Promise<{ token: string; id: string }> }) {
  const { token, id } = await params;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id) || !(await linkGroup(token)) || !(await isCatalogPhoto(id))) return new Response("Not found", { status: 404 });
  const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, id) });
  if (!f || !IMAGES.includes(f.mime)) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(f.data), {
    headers: {
      "Content-Type": f.mime,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // Datei ändert sich nie (neues Foto = neue ID)
      "Cache-Control": "private, max-age=604800, immutable",
    },
  });
}
