import { apiDenied } from "@/lib/auth";
import { chatThread } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

/** Nachrichten eines Chats (alle bzw. neuere als `after`) – die Seite fragt alle paar Sekunden */
export async function GET(req: Request) {
  const denied = await apiDenied("whatsapp");
  if (denied) return denied;
  const u = new URL(req.url);
  const c = u.searchParams.get("c") ?? "";
  if (!c) return new Response("Bad Request", { status: 400 });
  const t = await chatThread(c);
  if (!t) return new Response("Not Found", { status: 404 });
  return Response.json(t, { headers: { "Cache-Control": "private, no-store" } });
}
