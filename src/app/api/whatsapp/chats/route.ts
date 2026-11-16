import { apiDenied } from "@/lib/auth";
import { listChats } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

/** Chatliste (für die Seite „WhatsApp“, wird alle paar Sekunden neu geholt) */
export async function GET(req: Request) {
  const denied = await apiDenied("whatsapp");
  if (denied) return denied;
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return Response.json({ chats: await listChats(q) }, { headers: { "Cache-Control": "private, no-store" } });
}
