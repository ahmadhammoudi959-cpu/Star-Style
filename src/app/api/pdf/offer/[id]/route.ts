import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSession } from "@/lib/auth";
import { offerPdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, id) });
  if (!o) return new Response("Not found", { status: 404 });
  const bytes = await offerPdf(id);
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Angebot-${o.number}.pdf"`, "Cache-Control": "private, no-store" } });
}
