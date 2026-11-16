import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMailBodies, parseMailSettings, quoteText, signatureSplit, textToHtml, forwardText } from "../src/lib/mail-rules";
import { effectivePerms, routeNeed, PRESETS } from "../src/lib/permissions";
import { waExtensionFiles, WA_EXT_READONLY_VERSION, WA_EXT_VERSION } from "../src/lib/wa-extension";

// die Signatur aus dem Hostinger-Webmail (16.11.2026 dort gelesen: gleicher Text, gleiches Logo)
const SIG = `<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,Helvetica,sans-serif;color:#0B1222;font-size:13px"><tr>
<td style="padding:0 18px 0 0;vertical-align:middle;"><a href="https://starstyle-shop.de" style="text-decoration:none;"><img src="https://starstyle-shop.de/cdn/shop/files/star-style-email-signatur-logo.png" width="150" height="68" alt="Star Style Friseurbedarf" style="display:block;border:0;width:150px;height:68px;"></a></td>
<td style="border-left:3px solid #1752D6;"><div style="font-size:16px;font-weight:bold;">Star Style Friseurbedarf</div>
<div><span style="color:#1752D6;font-weight:bold;">WhatsApp</span>&nbsp;&nbsp;<a href="https://wa.me/491785571725">+49 178 5571725</a></div>
<div><span>E-Mail</span>&nbsp;&nbsp;<a href="mailto:info@starstyle-shop.de">info@starstyle-shop.de</a></div></td></tr>
<tr><td colspan="2" style="font-size:11px;color:#8A93A3;">Inhaber: Mohammad Haaji &middot; USt-IdNr.: DE458520439</td></tr></table>`;

describe("E-Mail-Signatur mit Logo", () => {
  it("bereinigt: Tabelle, Logo (https) und Links bleiben, Gefährliches fällt weg", async () => {
    const { sanitizeSignatureHtml } = await import("../src/lib/mailbox");
    const clean = sanitizeSignatureHtml(SIG);
    expect(clean).toContain('src="https://starstyle-shop.de/cdn/shop/files/star-style-email-signatur-logo.png"');
    expect(clean).toContain('href="mailto:info@starstyle-shop.de"');
    expect(clean).toContain("border-left:3px solid #1752D6");
    expect(clean).toContain("Inhaber: Mohammad Haaji");
    const evil = sanitizeSignatureHtml(`<div onclick="x()" style="background:url(https://t.example/p.gif)">A</div><script>alert(1)</script><img src="http://x.de/a.png"><img src="data:image/png;base64,AAA"><a href="javascript:alert(1)">b</a><style>*{}</style><form><input></form><iframe src="https://x"></iframe>`);
    expect(evil).not.toMatch(/onclick|script|url\(|http:\/\/x\.de|data:|javascript|<style|<form|<input|<iframe/i);
    expect(evil).toContain(">A</div>");
    expect(sanitizeSignatureHtml("x".repeat(50_000))).toBe("");
  });

  it("Text + Signatur: neue Nachricht, Antwort (vor dem Zitat), Weiterleiten", () => {
    const sig = { html: "<b>SIG</b>", text: "Star Style" };
    const fresh = buildMailBodies("Hallo <Kunde> & Co\nZeile 2", sig);
    expect(fresh.text).toBe("Hallo <Kunde> & Co\nZeile 2\n\n-- \nStar Style\n");
    expect(fresh.html).toContain("Hallo &lt;Kunde&gt; &amp; Co<br>Zeile 2<br><br><b>SIG</b>");
    const reply = "Danke!\n" + quoteText("Wann kommt die Ware?", "Kunde <k@x.de>", "16.11.2026, 18:00");
    expect(signatureSplit(reply)).toBe("Danke!".length + 1);
    const r = buildMailBodies(reply, sig);
    expect(r.text.indexOf("-- \nStar Style")).toBeLessThan(r.text.indexOf("Am 16.11.2026"));
    expect(r.html!.indexOf("<b>SIG</b>")).toBeLessThan(r.html!.indexOf("Am 16.11.2026"));
    expect(r.html).toContain("<blockquote");
    expect(r.html).toContain("Wann kommt die Ware?");
    const fwd = buildMailBodies("Siehe unten" + forwardText({ from: "a@b.de", to: "info@x.de", date: "heute", subject: "S", text: "Original" }), sig);
    expect(fwd.html!.indexOf("<b>SIG</b>")).toBeLessThan(fwd.html!.indexOf("Weitergeleitete Nachricht"));
    expect(buildMailBodies("Nur Text", null)).toEqual({ text: "Nur Text" });
    expect(buildMailBodies("Nur Text", { html: " ", text: "x" })).toEqual({ text: "Nur Text" });
    expect(textToHtml('<script>"x"</script>')).toBe("&lt;script&gt;&quot;x&quot;&lt;/script&gt;<br>");
  });

  it("Einstellungen lesen: signatureHtml (ältere Einstellungen ohne Feld = leer)", () => {
    expect(parseMailSettings({ user: "info@x.de" }).signatureHtml).toBe("");
    expect(parseMailSettings({ signatureHtml: "<b>x</b>" }).signatureHtml).toBe("<b>x</b>");
  });
});

describe("Rechte: E-Mail und WhatsApp lesen/schreiben getrennt", () => {
  it("Schreiben bringt Lesen mit, Lesen allein darf nicht schreiben", () => {
    expect([...effectivePerms(["mail.send"], false)].sort()).toEqual(["mail", "mail.send"]);
    expect([...effectivePerms(["mail.delete"], false)].sort()).toEqual(["mail", "mail.delete"]);
    expect([...effectivePerms(["whatsapp.send"], false)].sort()).toEqual(["whatsapp", "whatsapp.send"]);
    expect(effectivePerms(["mail", "whatsapp"], false).has("mail.send")).toBe(false);
    expect(routeNeed("/mail/compose")).toEqual({ any: ["mail.send"] });
    expect(routeNeed("/mail")).toEqual({ any: ["mail"] });
    expect(PRESETS.teamLead).toEqual(expect.arrayContaining(["mail", "mail.send", "whatsapp", "whatsapp.send"]));
  });

  it("Server-Actions prüfen das Schreib-/Löschrecht", () => {
    const src = readFileSync("src/app/(app)/mail/actions.ts", "utf8");
    expect(src).toMatch(/mailTrashAction[\s\S]*?requirePerm\("mail\.delete"\)/);
    expect(src).toMatch(/sendMailAction[\s\S]*?requirePerm\("mail\.send"\)/);
  });

  it("Erweiterung ab 1.0.2 sperrt im Rahmen das Schreiben auf Wunsch des Systems", () => {
    expect(WA_EXT_VERSION >= WA_EXT_READONLY_VERSION).toBe(true);
    const js = waExtensionFiles("star-style.onrender.com")["whatsapp.js"];
    expect(js).toContain("ssWaReadOnly");
    expect(js).toContain('if (e.origin !== target');
    expect(() => new Function(js)).not.toThrow();
  });
});

describe("Text der Beleg-E-Mails (selbst änderbar)", () => {
  it("Standardtext mit Absendername statt Firmenname, Platzhalter gefüllt", async () => {
    const { fillDocText } = await import("../src/lib/mail-rules");
    expect(fillDocText("invoice", "", { doc: "Rechnung", number: "RE-2026-0004", due: "Zahlbar bis 30.11.2026.", sender: "Star Style" }))
      .toBe("Sehr geehrte Damen und Herren,\n\nanbei erhalten Sie unsere Rechnung RE-2026-0004. Zahlbar bis 30.11.2026.\n\nMit freundlichen Grüßen\nStar Style");
    // Storno ohne Fälligkeit: kein Leerzeichen am Zeilenende
    expect(fillDocText("invoice", "", { doc: "Stornorechnung", number: "ST-1", due: "", sender: "S" })).toContain("Stornorechnung ST-1.\n\n");
    expect(fillDocText("offer", "Hallo,\n\nAngebot {number} bis {valid}. {due} {x}\n\n\n\n{sender}", { number: "AN-1", valid: "01.12.2026", sender: "Star Style" }))
      .toBe("Hallo,\n\nAngebot AN-1 bis 01.12.2026. {due} {x}\n\nStar Style");
    expect(parseMailSettings({ invoiceText: "x" }).invoiceText).toBe("x");
    expect(parseMailSettings({}).offerText).toBe("");
  });

  it("Beleg-E-Mails nehmen Text und Absendername aus den E-Mail-Einstellungen", () => {
    const src = readFileSync("src/app/(app)/sales/actions.ts", "utf8");
    expect(src).toContain('fillDocText("invoice", ms?.invoiceText');
    expect(src).toContain('fillDocText("offer", ms?.offerText');
    expect(src).not.toMatch(/Mit freundlichen Grüßen\\n\$\{company/);
  });
});
