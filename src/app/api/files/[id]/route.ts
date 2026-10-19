import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSession } from "@/lib/auth";

const INLINE = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, id) });
  if (!f) return new Response("Not found", { status: 404 });
  const inline = INLINE.includes(f.mime);
  // Dateien ändern sich nie (neues Foto = neue ID) → lange zwischenspeichern; nur sichere Typen im Browser anzeigen
  return new Response(new Uint8Array(f.data), {
    headers: {
      "Content-Type": inline ? f.mime : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(f.name)}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
