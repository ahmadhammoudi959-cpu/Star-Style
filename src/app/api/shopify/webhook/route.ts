import { handleWebhook } from "@/lib/shopify/webhooks";

export const dynamic = "force-dynamic";

/** Shopify meldet Bestellungen, Stornos und Erstattungen. Antwort sofort, Verarbeitung im Hintergrund. */
export async function POST(req: Request) {
  const raw = await req.text();
  const status = await handleWebhook(raw, req.headers);
  return new Response(status === 200 ? "ok" : "no", { status });
}
