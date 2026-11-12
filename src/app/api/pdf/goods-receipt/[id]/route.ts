import { apiDenied } from "@/lib/auth";
import { getI18n } from "@/i18n";
import { goodsReceiptPdf } from "@/lib/goods-receipt-pdf";

export const dynamic = "force-dynamic";

/** Wareneingang als PDF (Design wie die Rechnung, Sprache des Nutzers) */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await apiDenied("stock.receive"); if (denied) return denied;
  const { id } = await params;
  const { t, locale } = await getI18n();
  const out = await goodsReceiptPdf(id, t, locale);
  if (!out) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(out.bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Wareneingang-${out.number.replace(/[^\w.-]/g, "")}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
