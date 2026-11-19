"use client";
import { useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { shareText, type DirectGroup } from "@/lib/direct-rules";
import { directLinkAction } from "./actions";

type D = Dict["direct"];
export type LinkCardData = { group: DirectGroup; title: string; url: string | null; exists: boolean; on: boolean; since: string | null };

/** Bestell-Links (je Preisgruppe einer): kopieren, per WhatsApp schicken, als Kunde öffnen, QR-Code drucken; Admin: an/aus, neu */
export function LinkCards({ t, links, mayLink, state }: { t: D; links: LinkCardData[]; mayLink: boolean; state: { on: string; off: string } }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<DirectGroup | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (l: LinkCardData, op: "create" | "renew" | "on" | "off") => {
    if (op === "renew" && !window.confirm(t.renewConfirm)) return;
    if (op === "off" && !window.confirm(t.offConfirm)) return;
    setBusy(`${l.group}:${op}`); setErr(null);
    try {
      const r = await directLinkAction(l.group, op);
      if (r.ok) { window.location.reload(); return; }
      setErr(t.errors[(r.error ?? "error") as keyof D["errors"]] ?? t.errors.error);
    } catch { setErr(t.errors.error); }
    setBusy(null);
  };
  const copy = async (l: LinkCardData) => {
    if (!l.url) return;
    try { await navigator.clipboard.writeText(l.url); setCopied(l.group); window.setTimeout(() => setCopied(null), 2000); } catch { /* Zwischenablage gesperrt */ }
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-bold">{t.linksTitle}</h2>
        <p className="text-sm text-ink-soft">{t.linksHint}</p>
      </div>
      {err && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 ring-1 ring-red-200" role="alert">{err}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {links.map((l) => (
          <div key={l.group} className="card card-hover space-y-3 p-4" data-link={l.group}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${l.group === "WHOLESALE" ? "bg-violet-50 text-violet-700" : "bg-brand-50 text-brand-700"}`}>
                  <Icon name="link" className="icon-pop h-5 w-5" />
                </span>
                <div>
                  <div className="font-bold" dir="auto">{l.title}</div>
                  {l.since && l.exists && <div className="text-xs text-ink-soft">{l.since}</div>}
                </div>
              </div>
              {l.exists && (
                <span className={`badge ${l.on ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-slate-100 text-slate-600"}`}>
                  <span className={`h-2 w-2 rounded-full ${l.on ? "bg-emerald-500" : "bg-slate-400"}`} />{l.on ? state.on : state.off}
                </span>
              )}
            </div>
            {!l.exists ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-ink-soft">{mayLink ? t.notYet : t.notYetStaff}</span>
                {mayLink && (
                  <button type="button" className="btn-primary group" disabled={!!busy} onClick={() => run(l, "create")} data-ai-block>
                    <Icon name="plus" className="icon-pop h-4 w-4" />{t.create}
                  </button>
                )}
              </div>
            ) : (
              <>
                {!l.on && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">{t.isOff}</p>}
                {l.url && (
                  <div className="flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-black/5">
                    <bdi dir="ltr" className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" data-link-url>{l.url}</bdi>
                    <button type="button" onClick={() => copy(l)} className="btn-ghost group shrink-0 px-3 py-1.5 text-xs">
                      <Icon name={copied === l.group ? "check" : "copy"} className="icon-pop h-4 w-4" />{copied === l.group ? t.copied : t.copy}
                    </button>
                  </div>
                )}
                {l.url && l.on && (
                  <div className="flex flex-wrap gap-2">
                    <a href={`https://wa.me/?text=${encodeURIComponent(shareText(t.shareText, l.url))}`} target="_blank" rel="noopener noreferrer" className="btn-ghost group px-3 py-2 text-xs">
                      <Icon name="chat" className="icon-pop h-4 w-4" />{t.whatsapp}
                    </a>
                    <a href={l.url} target="_blank" rel="noopener noreferrer" className="btn-ghost group px-3 py-2 text-xs"><Icon name="eye" className="icon-pop h-4 w-4" />{t.open}</a>
                    <Link href={`/direct/print?g=${l.group}`} className="btn-ghost group px-3 py-2 text-xs"><Icon name="scan" className="icon-pop h-4 w-4" />{t.qr}</Link>
                  </div>
                )}
                {mayLink && (
                  <div className="flex flex-wrap gap-2 border-t border-black/5 pt-3">
                    <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => run(l, l.on ? "off" : "on")} data-ai-block>
                      <Icon name={l.on ? "stop" : "bolt"} className="h-4 w-4" />{l.on ? t.off : t.on}
                    </button>
                    <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => run(l, "renew")} data-ai-block>
                      <Icon name="refresh" className="h-4 w-4" />{t.renew}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
