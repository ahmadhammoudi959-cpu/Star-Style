import { UploadError, restoreState, startRestore, validUploadId } from "@/lib/backup";
import { backupAdmin } from "../guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Geprüfte Sicherung zurückholen (läuft im Hintergrund, die Seite fragt den Stand ab) */
export async function POST(req: Request) {
  const a = await backupAdmin(req, true);
  if (a instanceof Response) return a;
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id || !validUploadId(id)) return Response.json({ error: "invalid" }, { status: 400 });
  try { startRestore(id, a.uid); return Response.json({ ok: true }); }
  catch (e) { return Response.json({ error: e instanceof UploadError ? e.code : "error" }, { status: 400 }); }
}

export async function GET(req: Request) {
  const a = await backupAdmin(req);
  if (a instanceof Response) return a;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const j = validUploadId(id) ? restoreState(id, a.uid) : null;
  return j ? Response.json(j) : Response.json({ error: "expired" }, { status: 404 });
}
