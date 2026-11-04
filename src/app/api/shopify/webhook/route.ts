import { handleWebhook } from "@/lib/shopify/webhooks";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1024 * 1024; // Shopify-Meldungen sind wenige KB – größere Anfragen gar nicht erst lesen

/** Shopify meldet Bestellungen, Stornos und Erstattungen. Antwort sofort, Verarbeitung im Hintergrund. */
export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return new Response("too large", { status: 413 });
  const raw = await readLimited(req, MAX_BYTES);
  if (raw == null) return new Response("too large", { status: 413 });
  const status = await handleWebhook(raw, req.headers);
  return new Response(status === 200 ? "ok" : "no", { status });
}

async function readLimited(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
