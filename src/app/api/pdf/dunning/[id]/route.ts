import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSession } from "@/lib/auth";
import { dunningPdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const d = await db.query.dunnings.findFirst({ where: eq(schema.dunnings.id, id), with: { invoice: true } });
  if (!d) return new Response("Not found", { status: 404 });
  const bytes = await dunningPdf(id);
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Mahnung-${d.level}-${d.invoice.number}.pdf"`, "Cache-Control": "private, no-store" } });
}
