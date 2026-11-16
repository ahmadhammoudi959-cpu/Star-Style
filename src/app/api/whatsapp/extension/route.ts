import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { apiDenied } from "@/lib/auth";
import { WA_EXT_FOLDER, waExtensionFiles, waExtensionHostFrom } from "@/lib/wa-extension";

export const dynamic = "force-dynamic";

/** Chrome-Erweiterung „Star Style – WhatsApp im System“ als ZIP (für diese Adresse gebaut); Recht „WhatsApp“ */
export async function GET(req: Request) {
  const denied = await apiDenied("whatsapp");
  if (denied) return denied;
  let host: string;
  // req.url trägt hinter dem Proxy nicht immer den echten Namen → Host-Kopfzeile (nur wenn APP_URL/RENDER_EXTERNAL_URL fehlen)
  const hostHeader = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  try { host = waExtensionHostFrom({ APP_URL: process.env.APP_URL, RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL }, hostHeader ? `https://${hostHeader}/` : req.url); }
  catch { return new Response("host", { status: 500 }); }
  const icons = await extensionIcons();
  const zip = new JSZip();
  const dir = zip.folder(WA_EXT_FOLDER)!;
  for (const [name, text] of Object.entries(waExtensionFiles(host, !!icons))) dir.file(name, text);
  if (icons) for (const [size, png] of Object.entries(icons)) dir.file(`icon${size}.png`, png);
  const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new Response(data as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${WA_EXT_FOLDER}.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}

/** Symbol aus dem App-Symbol (512 px) in 16/48/128 – ohne sharp oder Datei: Chrome nimmt sein Standardsymbol */
async function extensionIcons(): Promise<Record<string, Buffer> | null> {
  try {
    const sharp = (await import("sharp")).default;
    const src = await readFile(path.join(process.cwd(), "src", "app", "icon.png"));
    const out: Record<string, Buffer> = {};
    for (const s of [16, 48, 128]) out[String(s)] = await sharp(src).resize(s, s).png().toBuffer();
    return out;
  } catch {
    return null;
  }
}
