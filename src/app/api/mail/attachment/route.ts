import { apiDenied } from "@/lib/auth";
import { MailboxError, readAttachment } from "@/lib/mailbox";
import { inlineSafe, safeFilename } from "@/lib/mail-rules";

export const dynamic = "force-dynamic";

/**
 * Anhang einer E-Mail herunterladen (Recht „E-Mail“). Nur echte Bilder dürfen mit ?view=1 im Browser erscheinen –
 * alles andere (HTML, SVG, PDF …) immer als Download, damit nichts Fremdes auf unserer Adresse ausgeführt wird.
 */
export async function GET(req: Request) {
  const denied = await apiDenied("mail");
  if (denied) return denied;
  const url = new URL(req.url);
  const f = url.searchParams.get("f") ?? "";
  const u = Number(url.searchParams.get("u"));
  const i = Number(url.searchParams.get("i"));
  if (!f || !Number.isInteger(u) || u <= 0 || !Number.isInteger(i) || i < 0) return new Response("Bad Request", { status: 400 });
  try {
    const a = await readAttachment(f, u, i);
    const name = safeFilename(a.filename);
    const inline = url.searchParams.get("view") === "1" && inlineSafe(a.contentType);
    return new Response(new Uint8Array(a.content), {
      headers: {
        "Content-Type": inline ? a.contentType : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof MailboxError && e.code === "notFound") return new Response("Not Found", { status: 404 });
    console.error("mail attachment", e);
    return new Response("Bad Gateway", { status: 502 });
  }
}
