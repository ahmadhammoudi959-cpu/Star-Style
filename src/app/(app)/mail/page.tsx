import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { Icon, type IconName } from "@/components/Icon";
import { can, requirePerm } from "@/lib/auth";
import { canOpen } from "@/lib/permissions";
import { listMessages, MailboxError, mailboxConfigured, readMessage, type MailAddress, type MailFolder, type MailMessage } from "@/lib/mailbox";
import { humanSize, inlineSafe } from "@/lib/mail-rules";
import { MailTools } from "./MailTools";

export const dynamic = "force-dynamic";

const ROLE_ICON: Record<MailFolder["role"], IconName> = { inbox: "inbox", sent: "send", drafts: "edit", junk: "alert", trash: "trash", archive: "box", other: "file" };

/**
 * Postfach info@ (Wunsch Inhaber 16.11.2026): Ordner, Liste, Lesen – alles direkt vom Mail-Server (IMAP), nichts kopiert.
 * Handy: Liste ODER Nachricht; ab lg drei Spalten.
 */
export default async function MailPage({ searchParams }: { searchParams: Promise<{ f?: string; p?: string; q?: string; u?: string; sent?: string; trashed?: string }> }) {
  const session = await requirePerm("mail");
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const M = t.mail;
  const f = sp.f || "INBOX", page = Math.max(1, Number(sp.p) || 1), q = (sp.q ?? "").slice(0, 100), uid = Number(sp.u) || 0;

  if (!(await mailboxConfigured())) {
    return (
      <div>
        <PageHeader title={M.title} subtitle={M.subtitle} />
        <div className="card animate-rise flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-start gap-3">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-50 text-brand-600"><Icon name="inbox" className="h-6 w-6" /></span>
            <div><h2 className="font-bold">{M.notSetUp}</h2><p className="text-sm text-ink-soft">{M.notSetUpHint}</p></div>
          </div>
          {can(session, "settings") && <Link href="/settings/mail" className="btn-primary group"><Icon name="settings" className="h-4 w-4" />{M.setUp}</Link>}
        </div>
      </div>
    );
  }

  let list: Awaited<ReturnType<typeof listMessages>> | null = null;
  let msg: MailMessage | null = null;
  let error = "";
  try {
    [list, msg] = await Promise.all([
      listMessages(f, { page, q }),
      uid ? readMessage(f, uid) : Promise.resolve(null),
    ]);
  } catch (e) {
    error = e instanceof MailboxError ? e.code : "network";
    if (!(e instanceof MailboxError)) console.error("mail page", e);
  }
  // Absender = Kunde? (gleiche E-Mail, nie über den Namen)
  const fromAddr = msg?.from[0]?.address ?? "";
  const customer = fromAddr && canOpen(session, "/customers")
    ? (await db.execute<{ id: string; name: string }>(sql`select id, name from customers where lower(trim(email)) = ${fromAddr} order by number limit 1`)).rows[0] ?? null
    : null;

  const href = (o: { f?: string; p?: number; q?: string; u?: number }) => {
    const s = new URLSearchParams();
    s.set("f", o.f ?? f);
    if ((o.p ?? page) > 1) s.set("p", String(o.p ?? page));
    if (o.q ?? q) s.set("q", o.q ?? q);
    if (o.u) s.set("u", String(o.u));
    return `/mail?${s.toString()}`;
  };
  const folderName = (x: MailFolder) => (x.role === "other" ? x.name : M.folders[x.role]);
  const who = (a: MailAddress[]) => a.map((x) => x.name || x.address).join(", ");
  const today = new Date().toISOString().slice(0, 10);
  const when = (iso: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d);
    return local === today ? new Intl.DateTimeFormat(intl, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }).format(d)
      : new Intl.DateTimeFormat(intl, { day: "2-digit", month: "2-digit", year: local.slice(0, 4) === today.slice(0, 4) ? undefined : "2-digit", timeZone: "Europe/Berlin" }).format(d);
  };
  const full = (iso: string) => (iso ? new Intl.DateTimeFormat(intl, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(new Date(iso)) : "");
  const current = list?.folder;

  return (
    <div>
      <PageHeader title={M.title} subtitle={current ? `${folderName(current)} · ${M.unreadN.replace("{n}", String(current.unseen))}` : M.subtitle}
        actions={<>
          <Link href={href({})} className="btn-ghost group" aria-label={M.refresh}><Icon name="refresh" className="h-4 w-4" /><span className="hidden sm:inline">{M.refresh}</span></Link>
          <Link href="/mail/compose" className="btn-primary group"><Icon name="edit" className="h-4 w-4" />{M.compose}</Link>
        </>} />
      {sp.sent === "1" && <Notice tone="ok" text={M.sentOk} />}
      {sp.trashed === "1" && <Notice tone="ok" text={M.trashedOk} />}
      {error && <Notice tone="err" text={(M.errors as Record<string, string>)[error] ?? M.errors.network} />}

      {list && (
        <div className={`grid gap-4 lg:grid-cols-[12rem_minmax(0,22rem)_minmax(0,1fr)] ${msg ? "" : ""}`}>
          {/* Ordner: Handy als Wischleiste, ab lg Spalte */}
          <nav className={`${msg ? "hidden lg:block" : ""} min-w-0`} aria-label={M.foldersTitle}>
            <div className="swipe-row flex gap-2 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible">
              {list.folders.map((x) => (
                <Link key={x.path} href={href({ f: x.path, p: 1, q: "" })}
                  className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${x.path === f ? "bg-brand-600 text-white shadow-card" : "bg-white text-ink ring-1 ring-black/5 hover:bg-brand-50"}`}>
                  <Icon name={ROLE_ICON[x.role]} className="h-4 w-4 shrink-0" /><span className="truncate">{folderName(x)}</span>
                  {x.unseen > 0 && x.role !== "sent" && x.role !== "trash" && <span className={`ms-auto rounded-full px-1.5 text-[0.6875rem] font-bold ${x.path === f ? "bg-white text-brand-700" : "bg-accent-500 text-white"}`}>{x.unseen}</span>}
                </Link>
              ))}
            </div>
          </nav>

          {/* Liste */}
          <section className={`${msg ? "hidden lg:block" : ""} card min-w-0 overflow-hidden animate-rise`}>
            <form method="get" action="/mail" className="flex gap-2 border-b border-black/5 p-3">
              <input type="hidden" name="f" value={f} />
              <input name="q" defaultValue={q} placeholder={M.search} className="input min-w-0 flex-1 py-2" autoComplete="off" />
              <button className="btn-ghost shrink-0 px-3" aria-label={M.search}><Icon name="search" className="h-4 w-4" /></button>
            </form>
            {list.items.length === 0 ? <p className="p-5 text-sm text-ink-soft">{q ? M.noMatch : M.empty}</p> : (
              <ul className="divide-y divide-black/5">
                {list.items.map((m) => {
                  const people = current?.role === "sent" || current?.role === "drafts" ? who(m.to) : who(m.from);
                  const open = m.uid === uid;
                  return (
                    <li key={m.uid}>
                      <Link href={href({ u: m.uid })} className={`block px-4 py-3 transition ${open ? "bg-brand-50" : "hover:bg-slate-50"}`}>
                        <div className="flex items-center gap-2">
                          {!m.seen && <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-label={M.unread} />}
                          <span className={`min-w-0 flex-1 truncate text-sm ${m.seen ? "text-ink-soft" : "font-bold text-ink"}`} dir="auto">{people || "—"}</span>
                          {m.flagged && <Icon name="star" className="h-3.5 w-3.5 shrink-0 text-amber-500" />}
                          {m.attachment && <Icon name="clip" className="h-3.5 w-3.5 shrink-0 text-ink-soft" />}
                          {m.answered && <Icon name="reply" className="h-3.5 w-3.5 shrink-0 text-ink-soft" />}
                          <span className="num shrink-0 text-xs text-ink-soft">{when(m.date)}</span>
                        </div>
                        <div className={`mt-0.5 truncate text-sm ${m.seen ? "" : "font-semibold"}`} dir="auto">{m.subject || M.noSubject}</div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {list.pages > 1 && (
              <div className="flex items-center justify-between gap-2 border-t border-black/5 p-3 text-sm">
                {page > 1 ? <Link href={href({ p: page - 1 })} className="btn-ghost px-3 py-1.5 text-xs">{M.newer}</Link> : <span />}
                <span className="num text-xs text-ink-soft">{page} / {list.pages}</span>
                {page < list.pages ? <Link href={href({ p: page + 1 })} className="btn-ghost px-3 py-1.5 text-xs">{M.older}</Link> : <span />}
              </div>
            )}
          </section>

          {/* Nachricht */}
          <section className={`${msg ? "" : "hidden lg:block"} min-w-0`}>
            {!msg ? (
              <div className="card grid h-full min-h-[16rem] place-items-center p-8 text-center text-sm text-ink-soft"><div><Icon name="inbox" className="mx-auto mb-2 h-8 w-8 text-brand-300" />{M.pick}</div></div>
            ) : (
              <article className="card animate-rise min-w-0 overflow-hidden">
                <div className="space-y-3 border-b border-black/5 p-5">
                  <Link href={href({})} className="btn-ghost group px-3 py-1.5 text-xs lg:hidden"><Icon name="arrowLeft" className="h-4 w-4 rtl:rotate-180" />{M.back}</Link>
                  <h2 className="text-lg font-bold [overflow-wrap:anywhere]" dir="auto">{msg.subject || M.noSubject}</h2>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-ink-soft">{M.from}</dt><dd className="min-w-0 [overflow-wrap:anywhere]"><Addr list={msg.from} /></dd>
                    <dt className="text-ink-soft">{M.to}</dt><dd className="min-w-0 [overflow-wrap:anywhere]"><Addr list={msg.to} /></dd>
                    {msg.cc.length > 0 && <><dt className="text-ink-soft">{M.cc}</dt><dd className="min-w-0 [overflow-wrap:anywhere]"><Addr list={msg.cc} /></dd></>}
                    <dt className="text-ink-soft">{M.date}</dt><dd className="num">{full(msg.date)}</dd>
                  </dl>
                  {customer && (
                    <Link href={`/customers/${customer.id}`} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 ring-1 ring-emerald-200 hover:bg-emerald-100">
                      <Icon name="users" className="h-3.5 w-3.5" />{M.customer}: <span dir="auto">{customer.name}</span>
                    </Link>
                  )}
                  <MailTools t={t} f={f} u={msg.uid} flagged={msg.flagged} trashHref={href({ u: 0 })} />
                </div>
                {msg.attachments.length > 0 && (
                  <ul className="flex flex-wrap gap-2 border-b border-black/5 px-5 py-3">
                    {msg.attachments.map((a) => (
                      <li key={a.index}>
                        <a href={`/api/mail/attachment?${new URLSearchParams({ f, u: String(msg!.uid), i: String(a.index), ...(inlineSafe(a.contentType) ? { view: "1" } : {}) })}`}
                          target="_blank" rel="noopener" className="flex max-w-[16rem] items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-xs ring-1 ring-black/5 transition hover:bg-brand-50">
                          <Icon name="clip" className="h-4 w-4 shrink-0 text-brand-600" /><span className="truncate font-semibold" dir="auto">{a.filename || M.attachment}</span><span className="num shrink-0 text-ink-soft">{humanSize(a.size)}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
                {msg.blockedImages > 0 && <p className="mx-5 mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-ink-soft ring-1 ring-black/5"><Icon name="shield" className="me-1 inline h-3.5 w-3.5" />{M.imagesBlocked.replace("{n}", String(msg.blockedImages))}</p>}
                <div className="p-3 sm:p-5">
                  {msg.html ? (
                    // Fremdes HTML nur im abgeschotteten Rahmen: keine Skripte, keine Formulare, kein Zugriff auf unsere Seite; Links öffnen neu
                    <iframe title={msg.subject || M.noSubject} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
                      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:8px;font:15px/1.5 system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#0f172a;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${msg.html}</body></html>`}
                      className="h-[70vh] w-full rounded-xl bg-white ring-1 ring-black/5" />
                  ) : (
                    <div className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]" dir="auto">{msg.text || "—"}</div>
                  )}
                </div>
              </article>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Addr({ list }: { list: MailAddress[] }) {
  if (!list.length) return <>—</>;
  return <>{list.map((a, i) => <span key={i}>{i > 0 && ", "}{a.name ? <><span dir="auto" className="font-semibold">{a.name}</span> <bdi dir="ltr" className="text-ink-soft">&lt;{a.address}&gt;</bdi></> : <bdi dir="ltr">{a.address}</bdi>}</span>)}</>;
}

function Notice({ tone, text }: { tone: "ok" | "err"; text: string }) {
  return <div role={tone === "ok" ? "status" : "alert"} className={`mb-4 flex animate-rise items-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold ring-1 ${tone === "ok" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-red-50 text-red-800 ring-red-200"}`}><Icon name={tone === "ok" ? "check" : "alert"} className="h-4 w-4 shrink-0" />{text}</div>;
}
