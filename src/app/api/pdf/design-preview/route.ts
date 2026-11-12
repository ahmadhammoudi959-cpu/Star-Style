import { getSession } from "@/lib/auth";
import { parseDesign, PREVIEW_KINDS, type PreviewKind } from "@/lib/doc-design";
import { pdfToPng, previewPdf } from "@/lib/doc-preview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Vorschau im Belegdesign: Beispielbeleg mit dem gerade bearbeiteten Design (noch nicht gespeichert).
 * POST { kind, design, format?: "png" | "pdf" } als JSON → Bild der ersten Seite bzw. das PDF. Nur angemeldet.
 * „Als PDF öffnen“ schickt ein normales Formular (target=_blank, Felder kind/format/design) – so blockt kein Popup-Blocker
 * das neue Fenster, auch nicht auf dem iPhone. Ohne Nebenwirkung (nur Anzeige), darum reicht die Sitzung als Schutz.
 */
export async function POST(req: Request) {
  if (!(await getSession())) return new Response("Unauthorized", { status: 401 });
  const raw = await req.text();
  if (raw.length > 64_000) return new Response("Too large", { status: 413 });
  let body: { kind?: unknown; design?: unknown; format?: unknown };
  if ((req.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
    const f = new URLSearchParams(raw);
    let design: unknown = {};
    try { design = JSON.parse(f.get("design") ?? "{}"); } catch { design = {}; }
    body = { kind: f.get("kind"), design, format: f.get("format") };
  } else {
    try { body = JSON.parse(raw); } catch { return new Response("Bad request", { status: 400 }); }
  }
  const kind: PreviewKind = (PREVIEW_KINDS as readonly unknown[]).includes(body.kind) ? (body.kind as PreviewKind) : "invoice";
  try {
    const pdf = await previewPdf(kind, parseDesign(body.design));
    if (body.format === "pdf") {
      return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="Vorschau-${kind}.pdf"`, "Cache-Control": "private, no-store" } });
    }
    const png = await pdfToPng(pdf);
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("design preview", e);
    return new Response("Preview failed", { status: 500 });
  }
}
