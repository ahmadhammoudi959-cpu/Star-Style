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
 *  3. whatsapp.js (nur in WhatsApp-Rahmen, nicht im normalen WhatsApp-Tab): sperrt auf Wunsch des Systems das Schreiben
 *     („nur lesen“ für Mitarbeiter ohne Recht „WhatsApp schreiben“, ab 1.0.2) und liest die Zahl ungelesener Chats aus dem
 *     Fenstertitel „(3) WhatsApp“ und schickt nur diese Zahl an unsere Adresse (postMessage mit festem Ziel).
 *     Ab 1.1.0 (24.11.2026: nach dem Schließen des Browsers fragte WhatsApp im System wieder nach dem QR-Code): schickt dazu,
 *     ob die Anmeldeseite (QR-Code) oder die Chats zu sehen sind (nur ob es die Elemente gibt – kein Inhalt), hakt auf der
 *     Anmeldeseite das eine Häkchen „Angemeldet bleiben“ an, falls es aus ist, und bittet Chrome, den Speicher von WhatsApp
 *     dauerhaft zu halten (navigator.storage.persist, ohne Rückfrage).
 * Nachrichten, Kontakte, Sitzung: bleiben in WhatsApp Web im Chrome des Laptops, nichts geht an unseren Server.
 */
export const WA_EXT_VERSION = "1.1.0";
/** ab dieser Version kann die Erweiterung „nur lesen“ (Mitarbeiter ohne Recht „WhatsApp schreiben“) */
export const WA_EXT_READONLY_VERSION = "1.0.2";
/** ab dieser Version hält die Erweiterung WhatsApp angemeldet („Angemeldet bleiben“) und meldet QR-Code/Chats */
export const WA_EXT_STAY_VERSION = "1.1.0";
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
    "// Schickt an das System nur die Zahl ungelesener Chats aus dem Fenstertitel „(3) WhatsApp“ und ob die Anmeldeseite",
    "// (QR-Code) oder die Chats zu sehen sind – keine Namen, keine Nachrichten.",
    "(() => {",
    "  if (window.top === window) return;",
    `  const target = ${JSON.stringify(`https://${host}`)};`,
    "  const started = Date.now();",
    "  // Chats oder Anmeldeseite? Prüft nur, ob es die Elemente gibt – liest keinen Inhalt.",
    "  const isApp = () => !!document.querySelector(\"#side, #pane-side\");",
    "  const isQr = () => !isApp() && !!document.querySelector(\"div[data-ref], canvas[aria-label*='QR'], canvas[aria-label*='qr']\");",
    "  // Angemeldet bleiben: nach dem Schließen des Browsers fragte WhatsApp im System wieder nach dem QR-Code. Auf der",
    "  // Anmeldeseite gibt es genau ein Häkchen („Angemeldet bleiben“) – ist es aus, einmal einschalten. Nur in den ersten",
    "  // zwei Minuten und nur auf der Anmeldeseite, damit nie ein anderes Häkchen in WhatsApp angefasst wird.",
    "  let kept = false;",
    "  const keep = () => {",
    "    if (kept || Date.now() - started > 120000 || !isQr()) return;",
    "    const inputs = document.querySelectorAll(\"input[type='checkbox']\");",
    "    const roles = document.querySelectorAll(\"[role='checkbox']\");",
    "    const box = inputs.length === 1 ? inputs[0] : (inputs.length === 0 && roles.length === 1 ? roles[0] : null);",
    "    if (!box) return;",
    "    kept = true;",
    "    const on = box instanceof HTMLInputElement ? box.checked : box.getAttribute(\"aria-checked\") === \"true\";",
    "    if (!on) box.click();",
    "  };",
    "  const send = () => {",
    "    keep();",
    "    const m = /^\\s*\\((\\d{1,4})\\)/.exec(document.title || \"\");",
    "    const msg = { ssWaUnread: m ? Number(m[1]) : 0 };",
    "    if (isApp()) msg.ssWaState = \"app\"; else if (isQr()) msg.ssWaState = \"qr\";",
    "    try { window.top.postMessage(msg, target); } catch (e) { /* anderes Fenster */ }",
    "  };",
    "  // Speicher von WhatsApp möglichst dauerhaft halten (Chrome entscheidet selbst, ohne Rückfrage)",
    "  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* egal */ }",
    "  send();",
    "  setInterval(send, 2000);",
    "  // Nur lesen (Wunsch Inhaber 16.11.2026: Rechte lesen/schreiben getrennt): das System meldet { ssWaReadOnly: true }",
    "  // → Eingabefeld, Senden, Weiterleiten, Reaktionen, Anhängen und Sprachnachricht im Rahmen gesperrt.",
    "  let ro = false;",
    "  const css = document.createElement(\"style\");",
    "  css.textContent = \"footer, footer *, [data-icon='send'], [data-icon='forward'], [data-icon='forward-chat'], [data-icon='react'], [data-icon='emoji-input'], [data-icon='plus'], [data-icon='plus-rounded'], [data-icon='attach-menu-plus'], [data-icon='ptt'], [data-icon='mic-outlined'] { pointer-events: none !important; } footer { opacity: .35 !important; } [data-icon='send'], [data-icon='forward'], [data-icon='react'] { opacity: .3 !important; }\";",
    "  const inFooter = (e) => e.target instanceof Element && !!e.target.closest(\"footer\");",
    "  const stop = (e) => { if (ro && (e.type === \"drop\" || inFooter(e))) { e.stopImmediatePropagation(); e.preventDefault(); } };",
    "  for (const ev of [\"keydown\", \"keypress\", \"beforeinput\", \"paste\", \"drop\", \"click\"]) window.addEventListener(ev, stop, true);",
    "  window.addEventListener(\"message\", (e) => {",
    "    if (e.origin !== target || !e.data || typeof e.data.ssWaReadOnly !== \"boolean\") return;",
    "    ro = e.data.ssWaReadOnly;",
    "    if (ro && !css.isConnected) (document.head || document.documentElement).appendChild(css);",
    "    if (!ro && css.isConnected) css.remove();",
    "  });",
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
    "   Unter dem Code muss „Angemeldet bleiben“ angehakt sein (die Erweiterung hakt es selbst an) – dann bleibt WhatsApp auch nach dem Schließen von Chrome verknüpft.",
    "",
    "AR – التحديث: فك ضغط الملف الجديد، بدّل المجلد القديم star-style-whatsapp فيه، وبـ chrome://extensions اكبس ↻ عند الإضافة.",
    "DE – Aktualisieren: neue ZIP entpacken, den alten Ordner star-style-whatsapp damit ersetzen und in chrome://extensions bei der Erweiterung auf ↻ drücken.",
    "",
    "Sicherheit: Die Erweiterung erlaubt nur dieser Adresse, WhatsApp Web in der Seite zu zeigen. Sie liest keine Nachrichten;",
    "nur die Zahl ungelesener Chats (aus dem Fenstertitel) und ob der QR-Code oder die Chats zu sehen sind gehen an die Seite.",
    "Alles bleibt im Chrome dieses Computers.",
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
