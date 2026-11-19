import { apiDenied } from "@/lib/auth";
import { newDirectCount } from "@/lib/direct";

export const dynamic = "force-dynamic";

/** Zahl am Menüpunkt „Direktverkauf“: Listen vom Bestell-Link, aus denen noch kein Angebot / keine Rechnung wurde */
export async function GET() {
  const denied = await apiDenied("direct");
  if (denied) return denied;
  return Response.json({ count: await newDirectCount() }, { headers: { "Cache-Control": "private, no-store" } });
}
