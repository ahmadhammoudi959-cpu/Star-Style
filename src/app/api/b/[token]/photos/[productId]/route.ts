import { catalogPhotoIds, linkGroup } from "@/lib/direct";

export const dynamic = "force-dynamic";

/** Alle Fotos eines Artikels für den Bestell-Link (Lagerfoto, Größen/Farben, Shop-Galerie) – nur mit gültigem Token */
export async function GET(_: Request, { params }: { params: Promise<{ token: string; productId: string }> }) {
  const { token, productId } = await params;
  if (!/^[A-Za-z0-9-]{8,64}$/.test(productId) || !(await linkGroup(token))) return new Response("Not found", { status: 404 });
  const ids = await catalogPhotoIds(productId);
  if (!ids) return new Response("Not found", { status: 404 });
  return Response.json({ ids }, { headers: { "Cache-Control": "private, max-age=300" } });
}
