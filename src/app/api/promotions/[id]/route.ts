import { eq, sql } from "drizzle-orm";
import { apiDenied } from "@/lib/auth";
import { db, schema } from "@/db";
import { promoState } from "@/lib/promotions";
import { jobRunning } from "@/lib/promo-banner-job";

export const dynamic = "force-dynamic";

/** Stand einer Aktion für die Seite (fragt alle 2 s, solange etwas läuft): Bild, Shops, Preise noch vorgemerkt */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await apiDenied("promotions");
  if (denied) return denied;
  const { id } = await params;
  const p = await db.query.promotions.findFirst({ where: eq(schema.promotions.id, id) });
  if (!p) return Response.json({ error: "notFound" }, { status: 404 });
  const [shops, dirty, written] = await Promise.all([
    db.select().from(schema.promotionShops).where(eq(schema.promotionShops.promotionId, id)),
    db.execute<{ n: number }>(sql`select count(*)::int as n from shop_price_dirty d join promotion_items i on i.product_id = d.product_id where i.promotion_id = ${id}`),
    db.execute<{ channel: string; promo_banner: string }>(sql`select channel::text, promo_banner from shops`),
  ]);
  const shown: Record<string, "top" | "below" | null> = {};
  for (const w of written.rows) {
    try {
      const j = JSON.parse(w.promo_banner || "{}") as { top?: { id?: string } | null; below?: { id?: string } | null };
      shown[w.channel] = j.top?.id === id ? "top" : j.below?.id === id ? "below" : null;
    } catch { shown[w.channel] = null; }
  }
  return Response.json({
    job: jobRunning(p) ? "running" : p.bannerJob === "running" ? "failed" : p.bannerJob, error: p.bannerError, version: p.bannerVersion,
    files: p.bannerFiles, copy: p.bannerCopy, state: promoState(p), dirty: Number(dirty.rows[0]?.n ?? 0), shown,
    shops: shops.map((s) => ({ channel: s.channel, error: s.error, uploaded: s.bannerVersion === p.bannerVersion && Object.keys(s.media).length > 0 })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}
