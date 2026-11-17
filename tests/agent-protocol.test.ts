import { describe, expect, it } from "vitest";
import {
  isCommitText, matchScore, norm, parseActions, parseInstruction, parsePlan, safePath, snapshotToText, speechLang, voiceApproval, LIMITS,
} from "../src/lib/agent/protocol";
import { pageMapText } from "../src/lib/agent/pages";
import type { Access, Perm } from "../src/lib/permissions";

describe("Assistent: Text vergleichen", () => {
  it("Arabisch: Hamza, Ta marbuta, Vokalzeichen, Tatweel", () => {
    expect(norm("أيوه")).toBe("ايوه");
    expect(norm("إصدار الفاتورة")).toBe("اصدار الفاتوره");
    expect(norm("آلة")).toBe("اله");
    expect(norm("مُؤسَّسة")).toBe("موسسه");
    expect(norm("فاتـــورة")).toBe("فاتوره");
    expect(norm("  Größe   Ä ")).toBe("grosse a");
  });
  it("matchScore: gleich > Anfang > enthält > alle Wörter", () => {
    expect(matchScore("Speichern", "speichern")).toBe(3);
    expect(matchScore("Rechnung ausstellen", "rechnung")).toBe(2);
    expect(matchScore("Neue Rechnung", "rechnung")).toBe(1);
    expect(matchScore("Barberstuhl Baron schwarz", "baron schwarz")).toBe(1);
    expect(matchScore("Barberstuhl Baron in schwarz", "baron schwarz")).toBe(0.5);
    expect(matchScore("حفظ كمسودة", "حفظ")).toBe(2);
    expect(matchScore("Kunde", "")).toBe(0);
  });
});

describe("Assistent: Knöpfe, die etwas speichern", () => {
  it("erkennt Speichern/Ausstellen/Senden in allen Sprachen", () => {
    for (const s of ["Speichern", "Als Entwurf speichern", "Rechnung ausstellen", "E-Mail senden", "Zahlung erfassen", "Löschen", "Stornieren",
      "Save", "Issue invoice", "Send", "Delete", "حفظ", "احفظ التعديلات", "إصدار الفاتورة", "ابعت الإيميل", "حذف", "Tomar bike"]) expect([s, isCommitText(s)]).toEqual([s, true]);
  });
  it("Navigation/Suche sind keine Speicher-Knöpfe", () => {
    for (const s of ["Öffnen", "Alle Artikel", "Suchen", "Weitere 60 anzeigen", "Neue Rechnung", "عرض", "كل المنتجات", "فتح", "Kunde wählen", "Abbrechen", "Zurück"])
      expect([s, isCommitText(s)]).toEqual([s, false]);
  });
  it("Wortanfang: „Ausstellung“ im Satz ist kein Ausstellen-Knopf, aber das Wort selbst schon", () => {
    expect(isCommitText("Unsaved")).toBe(false); // „save“ nur am Wortanfang
    expect(isCommitText("speichern & weiter")).toBe(true);
  });
});

describe("Assistent: Seiten", () => {
  it("nur App-Seiten, nie Konto/Passwort/Mitarbeiter/Sicherung/API", () => {
    expect(safePath("/sales/invoices/new")).toBe("/sales/invoices/new");
    expect(safePath("/stock?exp=soon")).toBe("/stock?exp=soon");
    for (const p of ["/account", "/account/x", "/password", "/settings/users", "/settings/users/1", "/backup", "/settings/whatsapp", "/login", "/setup",
      "/api/backup/download", "/_next/static", "https://evil.example", "//evil.example", "sales", "/sales\\x", "/a b", "/x\"y", "/account?x=1"])
      expect([p, safePath(p)]).toEqual([p, null]);
    expect(safePath("/accounts-list")).toBe("/accounts-list"); // nur genau /account bzw. darunter
  });
  it("Seitenliste je Rechte", () => {
    const acc = (...p: Perm[]): Access => ({ admin: false, perms: new Set(p) });
    const lager = pageMapText(acc("stock.count", "products.view"));
    expect(lager).toContain("/stock –");
    expect(lager).not.toContain("/sales/invoices/new");
    expect(lager).not.toContain("/settings –");
    const admin = pageMapText({ admin: true, perms: new Set() });
    expect(admin).toContain("/sales/invoices/new");
    expect(admin).not.toContain("/settings/users");
    expect(admin).not.toContain("/backup");
  });
});

describe("Assistent: Antworten der KI prüfen", () => {
  it("Schritte: erlaubte Aktionen, Grenzen, Standardwerte", () => {
    const ok = parseActions([
      { do: "navigate", path: "/customers" },
      { do: "type", target: { id: "e3" }, text: "Salon Amal", enter: true },
      { do: "click", target: { text: "Salon Amal", role: "option" } },
      { do: "select", target: { id: "e5" }, option: "Bar" },
      { do: "check", target: { id: "e6" }, checked: true },
      { do: "key", key: "Escape" },
      { do: "wait", ms: 99999 },
      { do: "wait_for", text: "gespeichert" },
      { do: "click", target: { id: "e9" }, commit: true },
    ]);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value[1]).toEqual({ do: "type", target: { id: "e3" }, text: "Salon Amal", enter: true, clear: true });
    expect(ok.value[6]).toEqual({ do: "wait", ms: 4000 });
    expect(ok.value[7]).toEqual({ do: "wait_for", text: "gespeichert", timeoutMs: 6000 });
    expect(ok.value[8]).toEqual({ do: "click", target: { id: "e9" }, commit: true });
    expect(ok.value[2]).toEqual({ do: "click", target: { text: "Salon Amal", role: "option" }, commit: false });
  });
  it("lehnt Unsinn ab (mit Grund für die KI)", () => {
    expect(parseActions([])).toMatchObject({ ok: false });
    expect(parseActions(Array.from({ length: LIMITS.actions + 1 }, () => ({ do: "wait", ms: 100 })))).toMatchObject({ ok: false });
    expect(parseActions([{ do: "navigate", path: "/account" }])).toMatchObject({ ok: false, error: expect.stringContaining("path not allowed") });
    expect(parseActions([{ do: "click", target: { id: "x1" } }])).toMatchObject({ ok: false }); // ID-Form
    expect(parseActions([{ do: "click" }])).toMatchObject({ ok: false });
    expect(parseActions([{ do: "eval", code: "alert(1)" }])).toMatchObject({ ok: false, error: expect.stringContaining("unknown action") });
    expect(parseActions([{ do: "key", key: "F5" }])).toMatchObject({ ok: false });
    expect(parseActions([{ do: "type", target: { id: "e1" } }])).toMatchObject({ ok: false });
  });
  it("Plan und Anweisungen", () => {
    expect(parsePlan({ title: "Rechnung", steps: [{ text: "Kunde wählen" }, { text: "Speichern", commit: true }, "Fertig"] }))
      .toEqual({ ok: true, value: { title: "Rechnung", steps: [{ text: "Kunde wählen", commit: false }, { text: "Speichern", commit: true }, { text: "Fertig", commit: false }], note: "" } });
    expect(parsePlan({ title: "x", steps: [] })).toMatchObject({ ok: false });
    expect(parsePlan({ title: "x", steps: Array.from({ length: LIMITS.planSteps + 1 }, () => "s") })).toMatchObject({ ok: false });
    expect(parseInstruction("ask", { question: "Welcher Kunde?", choices: ["A", "B", "", 3] })).toEqual({ ok: true, value: { type: "ask", question: "Welcher Kunde?", choices: ["A", "B"] } });
    expect(parseInstruction("act", { step: 2, say: "Kunde", actions: [{ do: "wait", ms: 200 }] })).toEqual({ ok: true, value: { type: "act", step: 2, say: "Kunde", actions: [{ do: "wait", ms: 200 }] } });
    expect(parseInstruction("act", { step: 99, actions: [{ do: "wait" }] })).toMatchObject({ ok: true, value: { step: null } });
    expect(parseInstruction("finish", {})).toEqual({ ok: true, value: { type: "finish", summary: "" } });
    expect(parseInstruction("hack", {})).toMatchObject({ ok: false });
  });
});

describe("Assistent: Seite als Text", () => {
  it("Elemente mit ID, Wert, Zustand, Sperre und Seitentext", () => {
    const t = snapshotToText({
      url: "/sales/invoices/new", title: "Neue Rechnung", dialog: "Alle Artikel",
      elements: [
        { id: "e1", kind: "input", name: "Kunde", value: "Salon Amal" },
        { id: "e2", kind: "checkbox", name: "Bezahlt", checked: false },
        { id: "e3", kind: "select", name: "Zahlungsart", value: "Bar", options: ["Bar", "Überweisung"] },
        { id: "e4", kind: "button", name: "Ausstellen", submit: true, disabled: true },
        { id: "e5", kind: "link", name: "Konto", href: "/account", blocked: true },
      ],
      text: "Positionen\nSumme 0,00 €",
    });
    expect(t).toContain('OPEN DIALOG: "Alle Artikel"');
    expect(t).toContain('[e1] input "Kunde" value="Salon Amal"');
    expect(t).toContain('[e2] checkbox "Bezahlt" unchecked');
    expect(t).toContain("options: Bar | Überweisung");
    expect(t).toContain('[e4] button "Ausstellen" (submits form) [disabled]');
    expect(t).toContain("→ /account [blocked – never use]");
    expect(t.endsWith("Positionen\nSumme 0,00 €")).toBe(true);
  });
  it("kürzt lange Seiten", () => {
    const t = snapshotToText({ url: "/", title: "", elements: Array.from({ length: LIMITS.elements + 5 }, (_, i) => ({ id: `e${i + 1}`, kind: "button" as const, name: "x".repeat(500) })), text: "y".repeat(LIMITS.snapText * 2) });
    expect(t).toContain("… 5 more elements not shown");
    expect(t).not.toContain("x".repeat(LIMITS.name + 1));
    expect(t.length).toBeLessThan(LIMITS.elements * (LIMITS.name + 30) + LIMITS.snapText + 500);
  });
});

describe("Assistent: Stimme", () => {
  it("Erkennungssprache", () => {
    expect(speechLang("ar", ["de-DE", "ar-SY"])).toBe("ar-SY");
    expect(speechLang("ar", ["de-DE"])).toBe("ar-EG");
    expect(speechLang("de")).toBe("de-DE");
    expect(speechLang("en")).toBe("en-US");
    expect(speechLang("ku")).toBeNull(); // Chrome kann kein Kurmancî – nur Tippen
  });
  it("kurze Antworten auf den Plan: alles / Schritt für Schritt / nein", () => {
    const cases: [string, ReturnType<typeof voiceApproval>][] = [
      ["كله", "auto"], ["ايوه كمل", "auto"], ["أيوه يا ستار ستايل", "auto"], ["تمام يلا", "auto"], ["نفذ", "auto"], ["ok", "auto"], ["Ja, mach", "auto"], ["yes go ahead", "auto"], ["Erê", "auto"],
      ["خطوة خطوة", "step"], ["أكّد كل خطوة", "step"], ["اسألني", "step"], ["Schritt für Schritt", "step"], ["step by step", "step"], ["gav bi gav", "step"],
      ["لا", "no"], ["لأ خلاص", "no"], ["nein", "no"], ["stop", "no"], ["no thanks", "no"],
    ];
    for (const [s, e] of cases) expect([s, voiceApproval(s)]).toEqual([s, e]);
  });
  it("Änderungen und andere Sätze sind keine Freigabe (gehen als Text an die KI)", () => {
    for (const s of ["لا، خلي الكمية 5", "ايوه بس خلي الزبون احمد", "Ja, aber Kunde Jahn", "nimm Jahn", "اهلا", "احمد", "okay but change the price to 20", "", "   "])
      expect([s, voiceApproval(s)]).toEqual([s, null]);
  });
});
