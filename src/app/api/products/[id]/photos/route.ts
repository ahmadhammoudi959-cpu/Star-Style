import { apiDenied } from "@/lib/auth";
import { productPhotoIds } from "@/lib/product-photos";

export const dynamic = "force-dynamic";

/** Foto-IDs eines Artikels für die Kundenansicht im Artikel-Fenster (Fotos sind für alle Angemeldeten, wie /api/files) */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await apiDenied();
  if (denied) return denied;
  const { id } = await params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return Response.json({ ids: [] }, { status: 400 });
  const ids = await productPhotoIds(id).catch(() => []);
  return Response.json({ ids }, { headers: { "Cache-Control": "private, max-age=60" } });
}
