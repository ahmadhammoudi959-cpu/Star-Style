import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { getSession } from "@/lib/auth";
import { archivedInvoicePdf, invoicePdf } from "@/lib/pdf";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  const type = new URL(req.url).searchParams.get("type");
  const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, id) });
  if (!inv) return new Response("Not found", { status: 404 });
  const bytes = type === "delivery" ? await invoicePdf(id, "delivery") : await archivedInvoicePdf(id);
  const name = `${type === "delivery" ? "Ladeliste" : inv.kind === "CANCELLATION" ? "Storno" : "Rechnung"}-${inv.number ?? "Entwurf"}.pdf`;
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${name}"`, "Cache-Control": "private, no-store" } });
}
