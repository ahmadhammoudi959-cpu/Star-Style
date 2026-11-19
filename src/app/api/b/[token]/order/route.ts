import { clientIp } from "@/lib/login-guard";
import { DirectError, linkGroup, submitDirectOrder } from "@/lib/direct";
import { parseDirectOrder } from "@/lib/direct-input";

export const dynamic = "force-dynamic";

/**
 * Liste vom Bestell-Link absenden (öffentlich, ohne Anmeldung – Middleware PUBLIC): gültiges Token, nur von unserer eigenen
 * Seite (gleiche Herkunft), JSON ≤ 64 KB, Eingaben streng geprüft (src/lib/direct-input.ts), Begrenzung je Netz/E-Mail.
 */
const MAX_BYTES = 64 * 1024;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  // ältere Browser ohne Sec-Fetch-Site: Origin muss zu unserer Adresse passen
  const origin = req.headers.get("origin"), host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
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

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!sameOrigin(req)) return json({ error: "form" }, 403);
  const group = await linkGroup(token);
  if (!group) return json({ error: "closed" }, 404);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "form" }, 415);
  const raw = await readLimited(req, MAX_BYTES);
  if (raw == null) return json({ error: "form" }, 413);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json({ error: "form" }, 400); }
  const p = parseDirectOrder(body);
  if (!p.ok) return json({ error: "field", field: p.field }, 400);
  try {
    const r = await submitDirectOrder(p.data, { ip: clientIp(req.headers), group });
    return json({ ok: true, number: r.number });
  } catch (e) {
    if (e instanceof DirectError) {
      if (e.code === "rate") return json({ error: "rate" }, 429);
      if (e.code === "bot") return json({ error: "bot" }, 400);
      if (e.code === "unavailable") return json({ error: "unavailable", problems: e.problems ?? [] }, 409);
    }
    console.error("direct order", e);
    return json({ error: "error" }, 500);
  }
}
