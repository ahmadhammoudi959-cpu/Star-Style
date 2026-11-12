import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Letzte heruntergeladene Sicherungen (aus dem Protokoll, Eintrag beim fertigen Download) */
export async function recentBackups(limit = 5): Promise<{ at: string; who: string; bytes: number }[]> {
  const r = await db.execute<{ at: string; who: string | null; bytes: string | null }>(sql`
    select a.created_at as at, u.name as who, a.after->>'bytes' as bytes
    from audit_log a left join users u on u.id = a.user_id
    where a.entity = 'backup' and a.action = 'download' order by a.created_at desc limit ${limit}`);
  return r.rows.map((x) => ({ at: new Date(x.at).toISOString(), who: x.who ?? "", bytes: Number(x.bytes ?? 0) }));
}

/** ungefähre Größe einer Sicherung in MB (Fotos/Belege machen fast alles aus) */
export async function backupSizeMb(): Promise<number> {
  const r = await db.execute<{ mb: number }>(sql`select ceil(pg_database_size(current_database()) / 1048576.0 * 0.9)::int as mb`);
  return Number(r.rows[0]?.mb ?? 0);
}
