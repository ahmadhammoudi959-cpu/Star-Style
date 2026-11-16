import { apiDenied } from "@/lib/auth";
import { waUnread } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

/** Zahl am Menüpunkt „WhatsApp“: ungelesene Nachrichten in allen Chats */
export async function GET() {
  const denied = await apiDenied("whatsapp");
  if (denied) return denied;
  return Response.json({ count: await waUnread() }, { headers: { "Cache-Control": "private, no-store" } });
}
