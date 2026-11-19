import { apiDenied } from "@/lib/auth";
import { shopOrdersWaitingCount } from "@/lib/shipments";

export const dynamic = "force-dynamic";

/**
 * Rote Zahl am Menüpunkt „Verkauf“ (Wunsch Inhaber 19.11.2026: „wie bei WhatsApp und E-Mail“): Online-Bestellungen,
 * die noch verschickt oder abgeholt werden müssen (dieselben wie die Hinweise auf der Startseite)
 */
export async function GET() {
  const denied = await apiDenied("sales.shipping");
  if (denied) return denied;
  return Response.json({ count: await shopOrdersWaitingCount() }, { headers: { "Cache-Control": "private, no-store" } });
}
