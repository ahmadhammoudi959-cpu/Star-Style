"use client";

/**
 * Vorschau der Signatur mit Logo (HTML) – in einem ganz abgeschotteten Rahmen (sandbox ohne Rechte: keine Skripte,
 * keine Formulare, eigener Ursprung). Bilder nur von erlaubten Adressen (CSP img-src).
 */
export function SignaturePreview({ html, title, className = "" }: { html: string; title: string; className?: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:8px;background:#fff">${html}</body></html>`;
  return <iframe sandbox="" srcDoc={doc} title={title} referrerPolicy="no-referrer" className={`block h-52 w-full rounded-xl border-0 bg-white ring-1 ring-black/5 ${className}`} />;
}
