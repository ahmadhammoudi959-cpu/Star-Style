import type { Dict } from "@/i18n/de";
const TONE: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-700", SENT: "bg-sky-100 text-sky-800", ACCEPTED: "bg-brand-100 text-brand-700", REJECTED: "bg-red-100 text-red-800",
  EXPIRED: "bg-orange-100 text-orange-800", CONVERTED: "bg-violet-100 text-violet-800", ISSUED: "bg-brand-100 text-brand-700", CANCELLED: "bg-red-100 text-red-800",
};
export function StatusBadge({ t, status }: { t: Dict; status: string }) {
  return <span className={`badge ${TONE[status] ?? ""}`}>{t.sales.status[status as keyof Dict["sales"]["status"]] ?? status}</span>;
}
