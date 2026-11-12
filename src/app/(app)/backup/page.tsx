import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requireAdmin } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { backupSizeMb, recentBackups } from "@/lib/backup-info";
import { BackupPanel } from "./BackupPanel";

export const dynamic = "force-dynamic";

/** Datensicherung (nur Admin): herunterladen + zurückholen (src/lib/backup.ts) */
export default async function BackupPage() {
  await requireAdmin();
  const { t, intl } = await getI18n();
  const [last, mb] = await Promise.all([recentBackups(5), backupSizeMb()]);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={t.backup.title} subtitle={t.backup.subtitle} />
      <BackupPanel t={t} sizeMb={mb}
        last={last.map((b) => ({ at: formatDateTime(b.at, intl), who: b.who, mb: Math.max(1, Math.round(b.bytes / 1048576)) }))} />
    </div>
  );
}
