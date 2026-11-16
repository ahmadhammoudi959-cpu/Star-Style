import Link from "next/link";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import { can, requirePerm } from "@/lib/auth";
import { canOpen } from "@/lib/permissions";
import { chatThread, listChats, loadWaSettings, openChat, WaError } from "@/lib/whatsapp";
import { waReady } from "@/lib/whatsapp-rules";
import { WaInbox, type ChatRow, type Thread } from "./WaInbox";

export const dynamic = "force-dynamic";

/** WhatsApp im System (Wunsch Inhaber 16.11.2026) – ?c=<Chat> öffnet einen Chat, ?to=<Nummer> öffnet/legt ihn an (Kundenseite) */
export default async function WhatsappPage({ searchParams }: { searchParams: Promise<{ c?: string; to?: string; customer?: string }> }) {
  const session = await requirePerm("whatsapp");
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const W = t.wa;
  const s = await loadWaSettings();
  if (!waReady(s)) {
    return (
      <div>
        <PageHeader title={W.title} subtitle={W.subtitle} />
        <div className="card animate-rise flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-start gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><Icon name="chat" className="h-6 w-6" /></span>
            <div><h2 className="font-bold">{W.notSetUp}</h2><p className="text-sm text-ink-soft">{W.notSetUpHint}</p></div>
          </div>
          {can(session, "settings") && <Link href="/settings/whatsapp" className="btn-primary group"><Icon name="settings" className="h-4 w-4" />{W.setUp}</Link>}
        </div>
      </div>
    );
  }
  if (sp.to) {
    let id = "";
    try { id = await openChat(sp.to, sp.customer ?? null); } catch (e) { if (!(e instanceof WaError)) throw e; }
    if (id) redirect(`/whatsapp?c=${id}`);
  }
  const [chats, thread, customers] = await Promise.all([
    listChats(),
    sp.c ? chatThread(sp.c) : Promise.resolve(null),
    db.execute<{ id: string; name: string; number: number; phone: string }>(sql`select id, name, number, phone from customers order by name limit 3000`),
  ]);
  const plain = <T,>(x: T): T => JSON.parse(JSON.stringify(x)); // Datum → Text für den Browser
  return (
    <div>
      <PageHeader title={W.title} subtitle={[s.verifiedName, s.displayPhone].filter(Boolean).join(" · ") || W.subtitle}
        actions={can(session, "settings") ? <Link href="/settings/whatsapp" className="btn-ghost group"><Icon name="settings" className="h-4 w-4" /><span className="hidden sm:inline">{W.settings}</span></Link> : undefined} />
      <WaInbox t={t} intl={intl} initialChats={plain(chats) as ChatRow[]} initialThread={thread ? (plain(thread) as unknown as Thread) : null}
        customers={customers.rows.map((c) => ({ id: String(c.id), name: String(c.name), number: Number(c.number), phone: String(c.phone ?? "") }))} canCustomers={canOpen(session, "/customers")} />
    </div>
  );
}
