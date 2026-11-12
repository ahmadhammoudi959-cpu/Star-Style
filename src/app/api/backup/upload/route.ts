import { BackupFormatError } from "@/lib/backup-format";
import { UploadError, uploadPart, validUploadId } from "@/lib/backup";
import { backupAdmin } from "../guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Sicherung zum Zurückholen hochladen – in Stücken (höchstens 8 MB, Proxy-Grenzen), der Reihe nach.
 * Läuft NICHT durch die Middleware (sie würde große Bodys abschneiden, siehe CLAUDE.md „Sicherheit“) → prüft hier selbst.
 * Beim letzten Stück: ganze Datei prüfen → Zusammenfassung (nichts geändert).
 */
export async function POST(req: Request) {
  const a = await backupAdmin(req, true);
  if (a instanceof Response) return a;
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "", part = Number(u.searchParams.get("part")), last = u.searchParams.get("last") === "1";
  if (!validUploadId(id) || !Number.isInteger(part) || part < 0 || part > 400 || !req.body) return Response.json({ error: "invalid" }, { status: 400 });
  try {
    const summary = await uploadPart({ id, part, last, owner: a.uid, body: req.body });
    return Response.json(summary ? { ok: true, summary } : { ok: true });
  } catch (e) {
    const code = e instanceof UploadError || e instanceof BackupFormatError ? e.code : "error";
    if (code === "error") console.error("backup upload", e);
    return Response.json({ error: code }, { status: 400 });
  }
}
