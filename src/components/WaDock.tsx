"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { extVersionFromMessage, unreadFromMessage, WA_UNREAD_EVENT, WA_WEB_ORIGIN, waDigits, waMeUrl, waWebUrl } from "@/lib/wa-web";

const ON_KEY = "ss-wa-on"; // nach dem ersten Öffnen lädt WhatsApp bei jedem Start gleich mit (Zahl im Menü, sofort da)

/**
 * WhatsApp Web im System (Wunsch Inhaber 16.11.2026): ein Rahmen im Layout, der beim Wechsel zwischen Seiten
 * bestehen bleibt (WhatsApp lädt nicht jedes Mal neu) und nur auf /whatsapp sichtbar ist.
 * Braucht die Chrome-Erweiterung „Star Style – WhatsApp im System“ (src/lib/wa-extension.ts); ohne sie: Anleitung + Download,
 * auf dem Handy: Hinweis auf die App (?to=<Nummer> öffnet dort den Chat in der App).
 */
export function WaDock({ t }: { t: Dict["waWeb"] }) {
  const path = usePathname();
  const sp = useSearchParams();
  const on = path === "/whatsapp";
  const to = on ? sp.get("to") : null;
  const [ext, setExt] = useState<string | false | null>(null); // Version der Erweiterung, false = nicht da, null = wird geprüft
  const [phone, setPhone] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [key, setKey] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const lastTo = useRef<string | null>(null);

  // Erweiterung da? (sie antwortet auf unserer Seite per postMessage) + Zahl ungelesener Chats aus dem Rahmen
  useEffect(() => {
    let found = false;
    const onMsg = (e: MessageEvent) => {
      if (e.source === window && e.origin === window.location.origin) {
        const v = extVersionFromMessage(e.data);
        if (v) { found = true; setExt(v); }
        return;
      }
      if (e.origin === WA_WEB_ORIGIN && frame.current && e.source === frame.current.contentWindow) {
        const n = unreadFromMessage(e.data);
        if (n === null) return;
        (window as unknown as { __ssWaUnread?: number }).__ssWaUnread = n;
        window.dispatchEvent(new CustomEvent(WA_UNREAD_EVENT, { detail: n }));
      }
    };
    window.addEventListener("message", onMsg);
    const ping = () => window.postMessage({ ssWaExtPing: 1 }, window.location.origin);
    ping();
    const a = window.setTimeout(ping, 400);
    const b = window.setTimeout(() => { if (!found) setExt(false); }, 1500);
    setPhone(window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(min-width: 64rem)").matches);
    return () => { window.removeEventListener("message", onMsg); window.clearTimeout(a); window.clearTimeout(b); };
  }, []);

  // Rahmen laden: beim ersten Öffnen von /whatsapp – danach (gemerkt) auch gleich beim Start
  useEffect(() => {
    if (!ext || src) return;
    let remembered = false;
    try { remembered = localStorage.getItem(ON_KEY) === "1"; } catch { /* ohne Speicher: erst beim Öffnen */ }
    if (on || remembered) {
      setSrc(waWebUrl(to));
      if (to) lastTo.current = to;
      try { localStorage.setItem(ON_KEY, "1"); } catch { /* egal */ }
    }
  }, [ext, on, to, src]);

  // ?to=<Nummer> (Knopf beim Kunden): Chat mit dieser Nummer im Rahmen öffnen; auf dem Handy in der App
  useEffect(() => {
    if (!to || to === lastTo.current) return;
    if (ext === false && phone) { lastTo.current = to; window.location.href = waMeUrl(to); return; }
    if (!ext || !src) return;
    lastTo.current = to;
    if (waDigits(to)) { setSrc(waWebUrl(to)); setKey((k) => k + 1); }
  }, [to, ext, phone, src]);

  const visible = on && !!ext && !!src;
  return (
    <>
      {on && ext === null && (
        <div className="card animate-rise flex items-center gap-3 p-6 text-sm text-ink-soft"><span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />{t.checking}</div>
      )}
      {on && ext === false && phone && (
        <div className="card animate-rise flex flex-wrap items-center justify-between gap-4 p-6">
          <div className="flex items-start gap-3">
            <span className="icon-pop grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><Icon name="chat" className="h-6 w-6" /></span>
            <div><h2 className="font-bold">{t.phoneTitle}</h2><p className="text-sm text-ink-soft">{t.phoneHint}</p></div>
          </div>
          <a href={waMeUrl(to)} className="btn-primary group bg-emerald-600 hover:bg-emerald-700"><Icon name="chat" className="h-4 w-4" />{t.openApp}</a>
        </div>
      )}
      {on && ext === false && !phone && (
        <div className="card animate-rise space-y-4 p-6" data-wa-install>
          <div className="flex items-start gap-3">
            <span className="icon-pop grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-600"><Icon name="chat" className="h-6 w-6" /></span>
            <div><h2 className="font-bold">{t.installTitle}</h2><p className="text-sm text-ink-soft">{t.installHint}</p></div>
          </div>
          <ol className="space-y-2 text-sm">
            {[t.step1, t.step2, t.step3, t.step4].map((s, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-600 text-xs font-bold text-white">{i + 1}</span>
                <span className="pt-0.5" dir="auto">{s}</span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <a href="/api/whatsapp/extension" className="btn-primary group bg-emerald-600 hover:bg-emerald-700" download><Icon name="download" className="h-4 w-4" />{t.download}</a>
            <button type="button" className="btn-ghost group" onClick={() => window.location.reload()}><Icon name="refresh" className="h-4 w-4" />{t.reloadPage}</button>
          </div>
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-900">{t.safety} {t.otherBrowser}</p>
        </div>
      )}
      {src && (
        <div className={visible ? "card animate-rise overflow-hidden p-0" : "hidden"} data-wa-dock>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/5 px-4 py-2 text-xs text-ink-soft">
            <span className="min-w-0" dir="auto">{t.linkHint} · {t.stays}</span>
            <button type="button" className="btn-ghost group shrink-0 px-3 py-1.5 text-xs" onClick={() => { setSrc(waWebUrl(null)); setKey((k) => k + 1); }}>
              <Icon name="refresh" className="h-4 w-4" />{t.reload}
            </button>
          </div>
          <iframe key={key} ref={frame} src={src} title={t.frameTitle} referrerPolicy="no-referrer"
            allow="microphone; camera; clipboard-read; clipboard-write; fullscreen; autoplay"
            className="block h-[calc(100dvh-14rem)] min-h-[32rem] w-full border-0 bg-white" />
        </div>
      )}
    </>
  );
}
