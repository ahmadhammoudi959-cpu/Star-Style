"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { mailFlagAction, mailTrashAction } from "./actions";

/** Knöpfe an einer Nachricht: Antworten, Allen antworten, Weiterleiten, ungelesen, Stern, Papierkorb */
export function MailTools({ t, f, u, flagged, trashHref }: { t: Dict; f: string; u: number; flagged: boolean; trashHref: string }) {
  const M = t.mail;
  const [busy, setBusy] = useState("");
  const [star, setStar] = useState(flagged);
  const [err, setErr] = useState("");
  const q = (mode: string) => `/mail/compose?${new URLSearchParams({ mode, f, u: String(u) })}`;
  const run = async (kind: "unread" | "star" | "trash") => {
    if (busy) return;
    setBusy(kind); setErr("");
    try {
      const r = kind === "trash" ? await mailTrashAction({ f, u })
        : kind === "unread" ? await mailFlagAction({ f, u, seen: false }) : await mailFlagAction({ f, u, flagged: !star });
      if (!r.ok) { setErr((M.errors as Record<string, string>)[r.error] ?? M.errors.network); return; }
      if (kind === "star") { setStar(!star); return; }
      window.location.assign(kind === "trash" ? `${trashHref}${trashHref.includes("?") ? "&" : "?"}trashed=1` : trashHref);
    } catch { setErr(M.errors.network); } finally { setBusy(""); }
  };
  const spin = <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Link href={q("reply")} className="btn-primary group px-3 py-2 text-sm"><Icon name="reply" className="h-4 w-4 rtl:-scale-x-100" />{M.reply}</Link>
        <Link href={q("all")} className="btn-ghost group px-3 py-2 text-sm"><Icon name="users" className="h-4 w-4" />{M.replyAll}</Link>
        <Link href={q("fwd")} className="btn-ghost group px-3 py-2 text-sm"><Icon name="send" className="h-4 w-4 rtl:-scale-x-100" />{M.forward}</Link>
        <button type="button" onClick={() => run("star")} disabled={Boolean(busy)} aria-pressed={star} className="btn-ghost group px-3 py-2 text-sm">
          {busy === "star" ? spin : <Icon name="star" className={`h-4 w-4 ${star ? "fill-amber-400 text-amber-500" : ""}`} />}<span className="hidden sm:inline">{star ? M.unstar : M.star}</span>
        </button>
        <button type="button" onClick={() => run("unread")} disabled={Boolean(busy)} className="btn-ghost group px-3 py-2 text-sm">
          {busy === "unread" ? spin : <Icon name="mail" className="h-4 w-4" />}<span className="hidden sm:inline">{M.markUnread}</span>
        </button>
        <button type="button" onClick={() => run("trash")} disabled={Boolean(busy)} className="btn-ghost group px-3 py-2 text-sm text-red-700">
          {busy === "trash" ? spin : <Icon name="trash" className="h-4 w-4" />}<span className="hidden sm:inline">{M.trash}</span>
        </button>
      </div>
      {err && <p role="alert" className="text-xs font-semibold text-red-700">{err}</p>}
    </div>
  );
}
