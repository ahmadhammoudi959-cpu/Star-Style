import { apiDenied } from "@/lib/auth";
import { inboxUnread } from "@/lib/mailbox";

export const dynamic = "force-dynamic";

/** Zahl am Menüpunkt „E-Mail“: ungelesene im Posteingang (höchstens alle 60 s vom Server gefragt) */
export async function GET() {
  const denied = await apiDenied("mail");
  if (denied) return denied;
  const count = await inboxUnread();
  return Response.json({ count: count ?? 0 }, { headers: { "Cache-Control": "private, no-store" } });
}
