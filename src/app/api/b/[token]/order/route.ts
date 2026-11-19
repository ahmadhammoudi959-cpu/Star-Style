import { clientIp } from "@/lib/login-guard";
import { DirectError, linkGroup, submitDirectOrder } from "@/lib/direct";
import { parseDirectOrder } from "@/lib/direct-input";
import { DIRECT_PHOTO_MAX_BYTES } from "@/lib/direct-photos";
import { DIRECT_MAX_MANUAL } from "@/lib/direct-rules";

export const dynamic = "force-dynamic";

/**
 * Liste vom Bestell-Link absenden (öffentlich, ohne Anmeldung – Middleware PUBLIC): gültiges Token, nur von unserer eigenen
 * Seite (gleiche Herkunft), Eingaben streng geprüft (src/lib/direct-input.ts), Begrenzung je Netz/E-Mail.
 * Ohne Fotos JSON ≤ 64 KB; mit Fotos von Artikeln von Hand multipart/form-data (Feld `data` = dasselbe JSON, Dateien p0 … p9,
 * je ≤ 6 MB, zusammen ≤ 16 MB). Läuft darum NICHT durch die Middleware (Matcher `api/b/`): Next 15.5 verliert dort bei großen
 * Bodies in Stücken den Anfang (siehe src/middleware.ts) – die Route prüft alles selbst.
 */
const MAX_JSON = 64 * 1024;
const MAX_MULTIPART = 16 * 1024 * 1024;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

function sameOrigin(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  // ältere Browser ohne Sec-Fetch-Site: Origin muss zu unserer Adresse passen
  const origin = req.headers.get("origin"), host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
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

/** JSON-Text bzw. multipart → Eingaben + Fotos (nur Dateien mit Namen p0 … p9, Größe begrenzt) */
async function readBody(req: Request): Promise<{ ok: true; body: unknown; photos: Map<string, Buffer> } | { ok: false; status: number; error: string }> {
  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  const multipart = type.startsWith("multipart/form-data");
  if (!multipart && !type.startsWith("application/json")) return { ok: false, status: 415, error: "form" };
  const raw = await readLimited(req, multipart ? MAX_MULTIPART : MAX_JSON);
  if (raw == null) return { ok: false, status: 413, error: multipart ? "tooBig" : "form" };
  const photos = new Map<string, Buffer>();
  let text: string;
  if (multipart) {
    let fd: FormData;
    try { fd = await new Response(new Uint8Array(raw), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData(); }
    catch { return { ok: false, status: 400, error: "form" }; }
    const data = fd.get("data");
    if (typeof data !== "string" || data.length > MAX_JSON) return { ok: false, status: 400, error: "form" };
    text = data;
    for (let i = 0; i < DIRECT_MAX_MANUAL; i++) {
      const f = fd.get(`p${i}`);
      if (!f || typeof f === "string") continue;
      if (f.size > DIRECT_PHOTO_MAX_BYTES) return { ok: false, status: 413, error: "tooBig" };
      photos.set(`p${i}`, Buffer.from(await f.arrayBuffer()));
    }
  } else text = raw.toString("utf8");
  try { return { ok: true, body: JSON.parse(text), photos }; } catch { return { ok: false, status: 400, error: "form" }; }
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!sameOrigin(req)) return json({ error: "form" }, 403);
  const group = await linkGroup(token);
  if (!group) return json({ error: "closed" }, 404);
  const b = await readBody(req);
  if (!b.ok) return json({ error: b.error }, b.status);
  const p = parseDirectOrder(b.body);
  if (!p.ok) return json({ error: "field", field: p.field }, 400);
  try {
    const r = await submitDirectOrder(p.data, { ip: clientIp(req.headers), group, photos: b.photos });
    return json({ ok: true, number: r.number });
  } catch (e) {
    if (e instanceof DirectError) {
      if (e.code === "rate") return json({ error: "rate" }, 429);
      if (e.code === "photoRate") return json({ error: "photoRate" }, 429);
      if (e.code === "photo") return json({ error: "photo" }, 400);
      if (e.code === "bot") return json({ error: "bot" }, 400);
      if (e.code === "noLines") return json({ error: "field", field: "lines" }, 400);
      if (e.code === "unavailable") return json({ error: "unavailable", problems: e.problems ?? [] }, 409);
    }
    console.error("direct order", e);
    return json({ error: "error" }, 500);
  }
}
