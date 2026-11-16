import { describe, expect, it } from "vitest";
import { extVersionFromMessage, unreadFromMessage, unreadFromTitle, waDigits, waMeUrl, waWebUrl } from "../src/lib/wa-web";
import { waExtensionFiles, waExtensionHost, waExtensionHostFrom } from "../src/lib/wa-extension";

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
    // das Skript im WhatsApp-Rahmen schickt nur an unsere Adresse und nur im Rahmen
    expect(f["whatsapp.js"]).toContain('const target = "https://star-style.onrender.com";');
    expect(f["whatsapp.js"]).toContain("if (window.top === window) return;");
    expect(f["whatsapp.js"]).not.toMatch(/innerHTML|querySelector|fetch\(|XMLHttpRequest/);
    expect(f["system.js"]).not.toMatch(/fetch\(|XMLHttpRequest|document\./);
    // Skripte sind gültiges JavaScript
    expect(() => new Function(f["system.js"].replace("chrome.runtime", "({ getManifest: () => ({ version: '1' }) })"))).not.toThrow();
    expect(() => new Function(f["whatsapp.js"])).not.toThrow();
    expect(waExtensionFiles("star-style.onrender.com")["manifest.json"]).not.toContain("icons");
  });
});
