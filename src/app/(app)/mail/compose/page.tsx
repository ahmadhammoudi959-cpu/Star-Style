import { redirect } from "next/navigation";
import { getI18n } from "@/i18n";
import { PageHeader } from "@/components/PageHeader";
import { requirePerm } from "@/lib/auth";
import { loadMailSettings, MailboxError, readMessage } from "@/lib/mailbox";
import { forwardSubject, forwardText, mailboxReady, quoteText, replySubject, validEmail } from "@/lib/mail-rules";
import { ComposeForm } from "./ComposeForm";

export const dynamic = "force-dynamic";

/** Neue E-Mail, Antworten, Allen antworten, Weiterleiten – Text (kein HTML), Signatur aus den Einstellungen vorne */
export default async function ComposePage({ searchParams }: { searchParams: Promise<{ mode?: string; f?: string; u?: string; to?: string; subject?: string }> }) {
  await requirePerm("mail");
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const s = await loadMailSettings();
  if (!mailboxReady(s)) redirect("/mail");
  const mode: "new" | "reply" | "all" | "fwd" = sp.mode === "reply" || sp.mode === "all" || sp.mode === "fwd" ? sp.mode : "new";
  const sig = s.signature.trim() ? `\n\n${s.signature.trim()}\n` : "\n";
  const toParam = (sp.to ?? "").trim().toLowerCase();
  const initial = {
    mode, f: sp.f ?? "", u: Number(sp.u) || 0, to: validEmail(toParam) ? toParam : "", cc: "", subject: (sp.subject ?? "").slice(0, 200), text: sig,
    originalAttachments: 0, refSubject: "",
  };
  let error = "";
  if (mode !== "new" && initial.f && initial.u) {
    try {
      const o = await readMessage(initial.f, initial.u, { markSeen: false });
      const me = s.user.toLowerCase();
      const fromLine = o.from.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
      const date = o.date ? new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(new Date(o.date)) : "";
      initial.refSubject = o.subject;
      if (mode === "fwd") {
        initial.subject = forwardSubject(o.subject);
        initial.text = sig + forwardText({ from: fromLine, to: o.to.map((a) => a.address).join(", "), date, subject: o.subject, text: o.text });
        initial.originalAttachments = o.attachments.length;
      } else {
        const back = (o.replyTo.length ? o.replyTo : o.from).map((a) => a.address).filter((a) => a && a !== me);
        const others = mode === "all" ? o.to.map((a) => a.address).filter((a) => a && a !== me && !back.includes(a)) : [];
        initial.to = [...back, ...others].join(", ");
        initial.cc = mode === "all" ? o.cc.map((a) => a.address).filter((a) => a && a !== me).join(", ") : "";
        initial.subject = replySubject(o.subject);
        initial.text = sig + quoteText(o.text, fromLine, date);
      }
    } catch (e) {
      error = e instanceof MailboxError ? e.code : "network";
    }
  }
  const title = mode === "reply" ? t.mail.reply : mode === "all" ? t.mail.replyAll : mode === "fwd" ? t.mail.forward : t.mail.compose;
  return (
    <div>
      <PageHeader title={title} subtitle={initial.refSubject || s.user} back={initial.f && initial.u ? `/mail?${new URLSearchParams({ f: initial.f, u: String(initial.u) })}` : "/mail"} />
      {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-800 ring-1 ring-red-200">{(t.mail.errors as Record<string, string>)[error] ?? t.mail.errors.network}</p>}
      <ComposeForm t={t} intl={intl} from={s.fromName ? `${s.fromName} <${s.user}>` : s.user} initial={initial} />
    </div>
  );
}
