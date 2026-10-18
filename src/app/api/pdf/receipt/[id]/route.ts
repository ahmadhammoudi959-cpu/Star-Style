import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSession } from "@/lib/auth";
import { receiptPdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const p = await db.query.payments.findFirst({ where: eq(schema.payments.id, id) });
  if (!p) return new Response("Not found", { status: 404 });
  const bytes = await receiptPdf(id);
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Quittung-${p.number}.pdf"`, "Cache-Control": "private, no-store" } });
}
