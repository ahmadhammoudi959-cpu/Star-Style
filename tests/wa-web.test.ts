import { describe, expect, it } from "vitest";
import { extVersionFromMessage, needsRelink, stateFromMessage, unreadFromMessage, unreadFromTitle, versionAtLeast, waDigits, waMeUrl, waWebUrl } from "../src/lib/wa-web";
import { WA_EXT_STAY_VERSION, WA_EXT_VERSION, waExtensionFiles, waExtensionHost, waExtensionHostFrom } from "../src/lib/wa-extension";

describe("WhatsApp Web im System – Adressen und Zahlen", () => {
  it("Nummern wie beim Kunden eingetragen", () => {
    expect(waDigits("0178 555 1234")).toBe("491785551234");
    expect(waDigits("+49 (178) 555-1234")).toBe("491785551234");
    expect(waDigits("0043 660 1234567")).toBe("436601234567");
    expect(waDigits("12")).toBe("");
    expect(waDigits(null)).toBe("");
  });
  it("Rahmen: Chatliste oder direkt der Chat; Handy: App", () => {
    expect(waWebUrl()).toBe("https://web.whatsapp.com/");
    expect(waWebUrl("0178 555 1234")).toBe("https://web.whatsapp.com/send?phone=491785551234");
    expect(waWebUrl("Unsinn")).toBe("https://web.whatsapp.com/");
    expect(waMeUrl("0178 555 1234")).toBe("https://wa.me/491785551234");
  });
  it("ungelesene Chats aus dem Fenstertitel und aus Nachrichten", () => {
    expect(unreadFromTitle("(3) WhatsApp")).toBe(3);
    expect(unreadFromTitle("(12) WhatsApp Business")).toBe(12);
    expect(unreadFromTitle("WhatsApp")).toBe(0);
    expect(unreadFromMessage({ ssWaUnread: 4 })).toBe(4);
    expect(unreadFromMessage({ ssWaUnread: -1 })).toBeNull();
    expect(unreadFromMessage({ ssWaUnread: "4" })).toBeNull();
    expect(unreadFromMessage("x")).toBeNull();
    expect(extVersionFromMessage({ ssWaExt: "1.0.0" })).toBe("1.0.0");
    expect(extVersionFromMessage({ ssWaExt: "<script>" })).toBeNull();
  });
  it("Zustand aus dem Rahmen (QR-Code oder Chats) und Versionen", () => {
    expect(stateFromMessage({ ssWaUnread: 0, ssWaState: "qr" })).toBe("qr");
    expect(stateFromMessage({ ssWaUnread: 0, ssWaState: "app" })).toBe("app");
    expect(stateFromMessage({ ssWaUnread: 0 })).toBeNull(); // Erweiterung vor 1.1.0
    expect(stateFromMessage({ ssWaState: "<b>" })).toBeNull();
    expect(stateFromMessage(null)).toBeNull();
    expect(versionAtLeast("1.0.10", "1.0.2")).toBe(true);
    expect(versionAtLeast("1.0.2", "1.1.0")).toBe(false);
    expect(versionAtLeast("1.1.0", "1.1.0")).toBe(true);
    expect(versionAtLeast("1.1", "1.1.0")).toBe(true);
    expect(versionAtLeast(WA_EXT_VERSION, WA_EXT_STAY_VERSION)).toBe(true);
  });
  it("Hinweis „neu verknüpfen“ nur, wenn der Rahmen mit dem QR-Code startet und WhatsApp hier schon verknüpft war", () => {
    expect(needsRelink("qr", "qr", "2026-11-20")).toBe(true);
    expect(needsRelink("qr", "app", "2026-11-20")).toBe(false); // gerade gescannt
    expect(needsRelink("app", "qr", "2026-11-20")).toBe(false); // in WhatsApp selbst abgemeldet
    expect(needsRelink("qr", "qr", null)).toBe(false); // erstes Verknüpfen auf diesem Computer
    expect(needsRelink(null, null, "2026-11-20")).toBe(false); // ältere Erweiterung meldet keinen Zustand
  });
});

/** whatsapp.js der Erweiterung mit einer kleinen Nachbildung von Seite und Browser ausführen */
function runWhatsappScript(dom: { app?: boolean; qr?: boolean; inputs?: boolean[]; roles?: string[] }) {
  const f = waExtensionFiles("star-style.onrender.com");
  const posted: Array<{ m: Record<string, unknown>; origin: string }> = [];
  const clicks: string[] = [];
  class FakeInput { constructor(public checked: boolean) {} click() { clicks.push("input"); this.checked = !this.checked; } }
  const inputs = (dom.inputs ?? []).map((c) => new FakeInput(c));
  const roles = (dom.roles ?? []).map((aria) => ({ getAttribute: () => aria, click: () => clicks.push("role") }));
  const win = { top: { postMessage: (m: Record<string, unknown>, origin: string) => posted.push({ m, origin }) }, addEventListener: () => {} };
  const doc = {
    title: "(2) WhatsApp",
    querySelector: (sel: string) => (sel === "#side, #pane-side" ? (dom.app ? {} : null) : sel.startsWith("div[data-ref]") ? (dom.qr ? {} : null) : null),
    querySelectorAll: (sel: string) => (sel === "input[type='checkbox']" ? inputs : sel === "[role='checkbox']" ? roles : []),
    createElement: () => ({ isConnected: false, remove() {} }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  let persisted = 0;
  const nav = { storage: { persist: () => { persisted++; return Promise.resolve(true); } } };
  const timers: Array<() => void> = [];
  new Function("window", "document", "navigator", "setInterval", "HTMLInputElement", f["whatsapp.js"])(
    win, doc, nav, (fn: () => void) => { timers.push(fn); return 1; }, FakeInput);
  return { posted, clicks, inputs, persisted: () => persisted, tick: () => timers.forEach((fn) => fn()) };
}

describe("Erweiterung im WhatsApp-Rahmen – angemeldet bleiben (1.1.0)", () => {
  it("Anmeldeseite: das eine Häkchen „Angemeldet bleiben“ wird einmal eingeschaltet, Zustand „qr“ geht ans System", () => {
    const r = runWhatsappScript({ qr: true, inputs: [false] });
    expect(r.clicks).toEqual(["input"]);
    expect(r.inputs[0].checked).toBe(true);
    expect(r.posted[0]).toEqual({ m: { ssWaUnread: 2, ssWaState: "qr" }, origin: "https://star-style.onrender.com" });
    expect(r.persisted()).toBe(1);
    r.tick(); r.tick();
    expect(r.clicks).toEqual(["input"]); // nur einmal – wer es danach selbst ausschaltet, bleibt dabei
  });
  it("schon angehakt, mehrere Häkchen oder Chats offen: nichts anklicken", () => {
    expect(runWhatsappScript({ qr: true, inputs: [true] }).clicks).toEqual([]);
    expect(runWhatsappScript({ qr: true, inputs: [false, false] }).clicks).toEqual([]);
    const app = runWhatsappScript({ app: true, qr: true, inputs: [false] });
    expect(app.clicks).toEqual([]);
    expect(app.posted[0].m).toEqual({ ssWaUnread: 2, ssWaState: "app" });
  });
  it("Häkchen als role=checkbox ohne Eingabefeld; unbekannte Seite: kein Zustand", () => {
    expect(runWhatsappScript({ qr: true, roles: ["false"] }).clicks).toEqual(["role"]);
    expect(runWhatsappScript({ qr: true, roles: ["true"] }).clicks).toEqual([]);
    const unknown = runWhatsappScript({ inputs: [false] });
    expect(unknown.clicks).toEqual([]);
    expect(unknown.posted[0].m).toEqual({ ssWaUnread: 2 });
  });
});

describe("Chrome-Erweiterung – nur für unsere Adresse", () => {
  it("Hostname streng geprüft", () => {
    expect(waExtensionHost("Star-Style.onrender.com")).toBe("star-style.onrender.com");
    for (const bad of ["*.onrender.com", "star-style.onrender.com:443", "https://x.de", "localhost", "web.whatsapp.com", "a..b", ""]) {
      expect(() => waExtensionHost(bad)).toThrow();
    }
    expect(waExtensionHostFrom({ RENDER_EXTERNAL_URL: "https://star-style.onrender.com" }, "http://localhost:3100/api")).toBe("star-style.onrender.com");
    expect(waExtensionHostFrom({ APP_URL: "https://system.example.de/" }, "https://star-style.onrender.com/x")).toBe("system.example.de");
    expect(waExtensionHostFrom({}, "https://star-style.onrender.com/api/whatsapp/extension")).toBe("star-style.onrender.com");
  });

  it("Regel hebt den Einbettungsschutz nur für WhatsApp-Rahmen auf unserer Adresse auf", () => {
    const f = waExtensionFiles("star-style.onrender.com", true);
    const manifest = JSON.parse(f["manifest.json"]);
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["declarativeNetRequestWithHostAccess"]);
    expect(manifest.host_permissions).toEqual(["https://star-style.onrender.com/*", "https://web.whatsapp.com/*"]);
    expect(manifest.icons["128"]).toBe("icon128.png");
    expect(manifest.content_scripts[0]).toMatchObject({ matches: ["https://star-style.onrender.com/*"], js: ["system.js"] });
    expect(manifest.content_scripts[0].all_frames).toBeUndefined(); // nur oberstes Fenster unserer Seite
    expect(manifest.content_scripts[1]).toMatchObject({ matches: ["https://web.whatsapp.com/*"], all_frames: true });
    const rules = JSON.parse(f["rules.json"]);
    expect(rules).toHaveLength(1);
    expect(rules[0].condition).toEqual({
      requestDomains: ["web.whatsapp.com"],
      initiatorDomains: ["star-style.onrender.com", "web.whatsapp.com"],
      resourceTypes: ["sub_frame"],
    });
    expect(rules[0].action.responseHeaders.map((h: { header: string; operation: string }) => `${h.operation}:${h.header}`))
      .toEqual(["remove:x-frame-options", "remove:content-security-policy"]);
    expect(rules[0].action.requestHeaders).toEqual([
      { header: "sec-fetch-dest", operation: "set", value: "document" },
      { header: "sec-fetch-site", operation: "set", value: "none" },
    ]);
    // das Skript im WhatsApp-Rahmen schickt nur an unsere Adresse und nur im Rahmen
    expect(f["whatsapp.js"]).toContain('const target = "https://star-style.onrender.com";');
    expect(f["whatsapp.js"]).toContain("if (window.top === window) return;");
    // liest keine Inhalte (nur ob es Elemente gibt) und schickt nichts ins Netz
    expect(f["whatsapp.js"]).not.toMatch(/innerHTML|innerText|textContent\b(?!\s*=)|\.value\b|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
    expect(manifest.version).toBe(WA_EXT_VERSION);
    expect(f["LIESMICH.txt"]).toContain("Aktualisieren");
    expect(f["system.js"]).not.toMatch(/fetch\(|XMLHttpRequest|document\./);
    // Skripte sind gültiges JavaScript
    expect(() => new Function(f["system.js"].replace("chrome.runtime", "({ getManifest: () => ({ version: '1' }) })"))).not.toThrow();
    expect(() => new Function(f["whatsapp.js"])).not.toThrow();
    expect(waExtensionFiles("star-style.onrender.com")["manifest.json"]).not.toContain("icons");
  });
});
