import { Readable, Transform } from "node:stream";
import { db, schema } from "@/db";
import { writeBackup } from "@/lib/backup";
import { backupFileName } from "@/lib/backup-format";
import { backupAdmin } from "../guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Ganze Datensicherung als Datei herunterladen (nur Admin). Wird beim Herunterladen erzeugt, nichts bleibt auf dem Server. */
export async function GET(req: Request) {
  const a = await backupAdmin(req);
  if (a instanceof Response) return a;
  const name = backupFileName(new Date());
  let bytes = 0;
  const out = new Transform({ transform(chunk: Buffer, _e, cb) { bytes += chunk.length; cb(null, chunk); } });
  writeBackup(out, a.name)
    .then((st) => db.insert(schema.auditLog).values({ entity: "backup", entityId: name, action: "download", after: { bytes, ...st }, userId: a.uid }))
    .catch((e) => { if ((e as Error)?.message !== "aborted") console.error("backup download", e); out.destroy(); });
  return new Response(Readable.toWeb(out) as unknown as ReadableStream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
