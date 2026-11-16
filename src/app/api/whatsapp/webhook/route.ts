import { handleWhatsappWebhook, verifyWebhook } from "@/lib/whatsapp";

export const dynamic = "force-dynamic";

const MAX_BYTES = 1024 * 1024; // Meta-Meldungen sind wenige KB

/**
 * Meta (WhatsApp Cloud API) – läuft an der Middleware vorbei (keine Sitzung): GET = Bestätigung mit dem Prüfwort aus den
 * Einstellungen, POST = Nachrichten/Status, nur mit gültiger Signatur (X-Hub-Signature-256, App-Geheimnis).
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ok = await verifyWebhook(u.searchParams.get("hub.mode"), u.searchParams.get("hub.verify_token"));
  if (!ok) return new Response("Forbidden", { status: 403 });
  return new Response(u.searchParams.get("hub.challenge") ?? "", { headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BYTES) return new Response("too large", { status: 413 });
  const raw = await readLimited(req, MAX_BYTES);
  if (raw == null) return new Response("too large", { status: 413 });
  try {
    const r = await handleWhatsappWebhook(raw, req.headers.get("x-hub-signature-256"));
    return new Response(r.reason, { status: r.status });
  } catch (e) {
    console.error("whatsapp webhook", e);
    return new Response("error", { status: 500 }); // Meta versucht es später noch einmal
  }
}

async function readLimited(req: Request, max: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
}
