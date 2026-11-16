/**
 * Chrome-Erweiterung „Star Style – WhatsApp im System“ (Wunsch Inhaber 16.11.2026) – rein, getestet in tests/wa-web.test.ts.
 * Download als ZIP: GET /api/whatsapp/extension (Ordner „star-style-whatsapp“, in Chrome „Entpackte Erweiterung laden“).
 *
 * Was sie tut – und nur das:
 *  1. rules.json: Bei Rahmen (sub_frame) von web.whatsapp.com, die UNSERE Seite (oder WhatsApp im Rahmen selbst, z. B. beim
 *     Neuladen nach dem Abmelden) öffnet, entfernt sie die Kopfzeilen X-Frame-Options und Content-Security-Policy und fragt
 *     das Dokument mit Sec-Fetch-Dest „document“ / Sec-Fetch-Site „none“ an (sonst liefert WhatsApp eine Fehlerseite).
 *     Jede andere Seite kann WhatsApp weiterhin nicht einbetten (Initiator ≠ unsere Adresse → Regel greift nicht).
 *  2. system.js (nur auf unserer Adresse, oberstes Fenster): meldet „Erweiterung da“ (Version) per postMessage – liest nichts.
 *  3. whatsapp.js (nur in WhatsApp-Rahmen, nicht im normalen WhatsApp-Tab): liest die Zahl ungelesener Chats aus dem
 *     Fenstertitel „(3) WhatsApp“ und schickt nur diese Zahl an unsere Adresse (postMessage mit festem Ziel).
 * Nachrichten, Kontakte, Sitzung: bleiben in WhatsApp Web im Chrome des Laptops, nichts geht an unseren Server.
 */
export const WA_EXT_VERSION = "1.0.1";
export const WA_EXT_FOLDER = "star-style-whatsapp";

/** Nur ein schlichter Hostname (keine Muster, kein Port, kein Pfad) – sonst Fehler */
export function waExtensionHost(raw: string): string {
  const h = (raw ?? "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) || h.length > 200) throw new Error("waExtensionHost");
  if (h === "whatsapp.com" || h.endsWith(".whatsapp.com")) throw new Error("waExtensionHost");
  return h;
}

/** Hostname aus APP_URL / RENDER_EXTERNAL_URL, sonst aus der Anfrage */
export function waExtensionHostFrom(env: { APP_URL?: string; RENDER_EXTERNAL_URL?: string }, requestUrl: string): string {
  for (const u of [env.APP_URL, env.RENDER_EXTERNAL_URL, requestUrl]) {
    if (!u) continue;
    try { return waExtensionHost(new URL(u).hostname); } catch { /* nächste Quelle */ }
  }
  throw new Error("waExtensionHost");
}

/** Alle Textdateien der Erweiterung (Symbole kommen in der Route dazu) */
export function waExtensionFiles(rawHost: string, withIcons = false): Record<string, string> {
  const host = waExtensionHost(rawHost);
  const icons = withIcons ? { icons: { "16": "icon16.png", "48": "icon48.png", "128": "icon128.png" } } : {};
  const manifest = {
    manifest_version: 3,
    name: "Star Style – WhatsApp im System",
    short_name: "Star WhatsApp",
    version: WA_EXT_VERSION,
    description: `Zeigt WhatsApp Web in der Seite „WhatsApp“ von ${host} – nur dort. Liest keine Nachrichten.`,
    permissions: ["declarativeNetRequestWithHostAccess"],
    host_permissions: [`https://${host}/*`, "https://web.whatsapp.com/*"],
    declarative_net_request: { rule_resources: [{ id: "whatsapp_frame", enabled: true, path: "rules.json" }] },
    content_scripts: [
      { matches: [`https://${host}/*`], js: ["system.js"], run_at: "document_start" },
      { matches: ["https://web.whatsapp.com/*"], js: ["whatsapp.js"], run_at: "document_idle", all_frames: true },
    ],
    ...icons,
  };
  const rules = [{
    id: 1,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
      ],
      // WhatsApp antwortet auf Rahmen-Anfragen (Sec-Fetch-Dest: iframe) mit „Sorry, something went wrong“ (16.11.2026 live)
      // → das Dokument im Rahmen wie ein normales Öffnen anfragen
      requestHeaders: [
        { header: "sec-fetch-dest", operation: "set", value: "document" },
        { header: "sec-fetch-site", operation: "set", value: "none" },
      ],
    },
    condition: {
      requestDomains: ["web.whatsapp.com"],
      // unsere Seite öffnet den Rahmen; WhatsApp im Rahmen lädt sich selbst neu (z. B. nach dem Abmelden)
      initiatorDomains: [host, "web.whatsapp.com"],
      resourceTypes: ["sub_frame"],
    },
  }];
  const system = [
    "// Star Style – WhatsApp im System: meldet der Seite nur „Erweiterung da“ (Version). Liest und ändert nichts.",
    "(() => {",
    "  const v = chrome.runtime.getManifest().version;",
    "  const say = () => window.postMessage({ ssWaExt: v }, location.origin);",
    "  window.addEventListener(\"message\", (e) => { if (e.source === window && e.data && e.data.ssWaExtPing === 1) say(); });",
    "  say();",
    "})();",
    "",
  ].join("\n");
  const whatsapp = [
    "// Star Style – WhatsApp im System: nur im Rahmen der Seite „WhatsApp“ (nicht im normalen WhatsApp-Tab).",
    "// Schickt nur die Zahl ungelesener Chats aus dem Fenstertitel „(3) WhatsApp“ an das System – sonst nichts.",
    "(() => {",
    "  if (window.top === window) return;",
    `  const target = ${JSON.stringify(`https://${host}`)};`,
    "  const send = () => {",
    "    const m = /^\\s*\\((\\d{1,4})\\)/.exec(document.title || \"\");",
    "    try { window.top.postMessage({ ssWaUnread: m ? Number(m[1]) : 0 }, target); } catch (e) { /* anderes Fenster */ }",
    "  };",
    "  send();",
    "  setInterval(send, 2000);",
    "})();",
    "",
  ].join("\n");
  const readme = [
    "Star Style – WhatsApp im System",
    "================================",
    "",
    "AR – التركيب (مرة وحدة على الكمبيوتر):",
    "1) فك ضغط الملف، بيطلع مجلد اسمه star-style-whatsapp – خليه بمكان ثابت (مثلاً المستندات) وما تحذفه.",
    "2) بكروم افتح العنوان: chrome://extensions",
    "3) شغّل «وضع المطوّر» (Developer mode) فوق على اليمين.",
    "4) اكبس «تحميل إضافة غير مضغوطة» (Load unpacked) واختار المجلد star-style-whatsapp.",
    `5) ارجع للسيستم (${host}) ← واتساب، وامسح الكود من واتساب بزنس عالموبايل: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز.`,
    "",
    "DE – Einrichten (einmal je Computer):",
    "1) ZIP entpacken → Ordner star-style-whatsapp an einen festen Ort legen (z. B. Dokumente), nicht löschen.",
    "2) In Chrome chrome://extensions öffnen.",
    "3) Oben rechts „Entwicklermodus“ einschalten.",
    "4) „Entpackte Erweiterung laden“ → Ordner star-style-whatsapp wählen.",
    `5) Im System (${host}) → WhatsApp öffnen und den Code mit WhatsApp Business am Handy scannen: Einstellungen → Verknüpfte Geräte → Gerät hinzufügen.`,
    "",
    "Sicherheit: Die Erweiterung erlaubt nur dieser Adresse, WhatsApp Web in der Seite zu zeigen. Sie liest keine Nachrichten;",
    "nur die Zahl ungelesener Chats (aus dem Fenstertitel) geht an die Seite für die Zahl im Menü. Alles bleibt im Chrome dieses Computers.",
    "",
  ].join("\n");
  return {
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "rules.json": JSON.stringify(rules, null, 2) + "\n",
    "system.js": system,
    "whatsapp.js": whatsapp,
    "LIESMICH.txt": readme,
  };
}
