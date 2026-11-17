import { getAuth } from "@/lib/auth";
import { allowed } from "@/lib/permissions";
import { readWorkbook, SheetError } from "@/lib/sheet-read";
import { readBodyLimited, saveTempFile, TEMP_MAX_BYTES, TempFileError } from "@/lib/temp-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Datei für den Assistenten bzw. den Artikel-Import ablegen (Excel/CSV, PDF, Foto; ≤ 20 MB) – nur vorübergehend, je Person.
 * Läuft NICHT durch die Middleware (sie würde größere Bodys abschneiden, siehe CLAUDE.md „Sicherheit“) → prüft hier selbst:
 * angemeldet, Recht „assistant“ oder „products.edit“, kein Einmal-Passwort, Anfrage von unserer eigenen Seite.
 * Body = die Datei selbst, Name in der Kopfzeile x-file-name (URI-kodiert).
 */
export async function POST(req: Request) {
  const a = await getAuth();
  if (!a) return Response.json({ error: "auth" }, { status: 401 });
  if (a.mustChange || !allowed(a, { any: ["assistant", "products.edit"] })) return Response.json({ error: "forbidden" }, { status: 403 });
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const originHost = (() => { try { return origin ? new URL(origin).host : null; } catch { return null; } })(); // „null“/Unsinn → fremd
  const same = site ? site === "same-origin" : !!originHost && !!host && originHost === host;
  if (!same) return Response.json({ error: "forbidden" }, { status: 403 });
  if (Number(req.headers.get("content-length") ?? 0) > TEMP_MAX_BYTES) return Response.json({ error: "fileTooLarge" }, { status: 413 });
  let name = "datei";
  try { name = decodeURIComponent(req.headers.get("x-file-name") ?? "datei"); } catch { /* bleibt */ }
  try {
    const buf = await readBodyLimited(req.body, TEMP_MAX_BYTES);
    const meta = await saveTempFile(a.uid, name, buf);
    let info = "";
    if (meta.kind === "sheet") {
      const wb = await readWorkbook(buf, meta.name);
      info = wb.sheets.map((s) => `${s.name}: ${s.rows.filter((r) => r.some((c) => c)).length}${s.images.length ? ` · ${s.images.length} 🖼` : ""}`).join(" | ");
    }
    return Response.json({ id: meta.id, name: meta.name, kind: meta.kind, size: meta.size, info }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const code = e instanceof TempFileError || e instanceof SheetError ? e.code : "fileUpload";
    if (code === "fileUpload") console.error("temp-files", e);
    return Response.json({ error: code === "empty" ? "fileType" : code }, { status: code === "fileTooLarge" ? 413 : 400 });
  }
}
