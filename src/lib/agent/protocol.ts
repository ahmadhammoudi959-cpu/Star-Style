/**
 * Assistent „Star Style“ (Wunsch Inhaber 17.11.2026: „يقول له أي حاجة … يخش على الحاجة المختصة ويعملها قدامه،
 * الشاشات تتقلب قدامه كأن في واحد قاعد شغال بداله“) – gemeinsame, reine Regeln für Server und Browser.
 * Getestet in tests/agent-protocol.test.ts.
 *
 * Ablauf: Der Browser schickt die Bitte + eine Text-Ansicht der Seite (Snapshot) an /api/assistant. Die KI antwortet mit
 * GENAU EINER Anweisung: plan (Plan zur Freigabe), act (sichtbare Schritte in der Oberfläche), ask (Rückfrage) oder
 * finish (fertig). Der Browser führt „act“ sichtbar aus (Zeiger, Markierung, Tippen) und schickt das Ergebnis +
 * neuen Snapshot zurück. Gespeichert/gesendet wird nur über die normalen Knöpfe – mit den Rechten der angemeldeten Person.
 */

export const AGENT_KEYS = ["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp", "Backspace"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];
export const TARGET_ROLES = ["button", "link", "input", "select", "checkbox", "option", "any"] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];
/** Element über die ID aus dem letzten Snapshot ([e12]) oder – für Elemente, die erst noch erscheinen – über den Text */
export type Target = { id?: string; text?: string; role?: TargetRole; nth?: number };

export type AgentAction =
  | { do: "navigate"; path: string }
  | { do: "click"; target: Target; commit?: boolean }
  | { do: "type"; target: Target; text: string; enter?: boolean; clear?: boolean }
  | { do: "select"; target: Target; option: string }
  | { do: "check"; target: Target; checked: boolean }
  | { do: "key"; key: AgentKey }
  | { do: "wait"; ms: number }
  | { do: "wait_for"; text: string; timeoutMs?: number }
  /** eine vom Nutzer im Chat abgelegte Datei in ein Datei-Feld der Seite legen (Beleg, Foto …) */
  | { do: "attach"; target: Target; file: string };

export type PlanStep = { text: string; commit: boolean };
export type Plan = { title: string; steps: PlanStep[]; note: string };

export type Instruction =
  | { type: "plan"; plan: Plan }
  | { type: "act"; step: number | null; say: string; actions: AgentAction[] }
  | { type: "ask"; question: string; choices: string[] }
  | { type: "finish"; summary: string }
  | { type: "error"; code: string };

export type ActionResult = { i: number; ok: boolean; note?: string };
export type ApprovalMode = "auto" | "step";

export type SnapKind = "button" | "link" | "input" | "textarea" | "select" | "checkbox" | "radio" | "option" | "password" | "file" | "other";
export type SnapEl = {
  id: string; kind: SnapKind; name: string; value?: string; checked?: boolean; disabled?: boolean; options?: string[];
  href?: string; submit?: boolean; blocked?: boolean;
};
export type Snapshot = { url: string; title: string; dialog?: string; elements: SnapEl[]; text: string };

/** ID einer abgelegten Datei (siehe src/lib/temp-files.ts) */
export const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LIMITS = { actions: 10, planSteps: 12, choices: 6, text: 2000, elements: 260, snapText: 5000, name: 120, options: 40 } as const;

// ── Text-Vergleich (Arabisch/Deutsch, Groß-/Kleinschreibung, Akzente, Hamza-Formen) ──
export function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // lateinische Akzente (ä → a)
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // arabische Vokalzeichen, Hamza/Madda (nach NFKD getrennt: أ → ا + ٔ), Tatweel
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/[«»„“”"'`´’·•|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 3 = gleich, 2 = beginnt damit, 1 = enthält, 0.5 = alle Wörter kommen vor, 0 = passt nicht */
export function matchScore(name: string, query: string): number {
  const n = norm(name), q = norm(query);
  if (!q || !n) return 0;
  if (n === q) return 3;
  if (n.startsWith(q)) return 2;
  if (n.includes(q)) return 1;
  const words = q.split(" ").filter((w) => w.length > 1);
  return words.length > 1 && words.every((w) => n.includes(w)) ? 0.5 : 0;
}

// Knöpfe, die etwas speichern/senden/löschen (für Knöpfe ohne Formular; Formular-Absenden wird im Browser erkannt)
const COMMIT_WORDS = [
  // de
  "speichern", "ausstellen", "senden", "absenden", "verschicken", "buchen", "bestatigen", "loschen", "stornieren", "erstatten",
  "zahlung erfassen", "hochladen", "sperren", "freischalten", "abschliessen", "zurucksetzen", "wiederherstellen", "ubernehmen", "anlegen",
  // en
  "save", "issue", "send", "submit", "confirm", "delete", "record", "refund", "upload", "book", "lock", "reset", "restore", "create",
  // ar (normalisiert: ا statt أ/إ, ه statt ة)
  "حفظ", "احفظ", "اصدار", "اصدر", "ارسال", "ارسل", "ابعت", "تاكيد", "اكد", "حذف", "احذف", "ستورنو", "ارفع", "رفع", "سجل الدفعه",
  "تسجيل", "استرجاع", "قفل", "انشاء", "انشئ",
  // ku
  "tomar", "bisine", "je bibe", "bipejirine", "derxe",
];
export function isCommitText(label: string): boolean {
  const n = norm(label);
  if (!n) return false;
  return COMMIT_WORDS.some((w) => (w.includes(" ") ? n.includes(w) : new RegExp(`(^|[^\\p{L}])${w}`, "u").test(n)));
}

// ── Seiten, die der Assistent nie öffnet (Konto/Passwort, Mitarbeiter-Rechte, Sicherung zurückholen) ──
export const DENIED_PATHS = ["/account", "/password", "/settings/users", "/backup", "/settings/whatsapp", "/login", "/setup"];
export function safePath(raw: unknown): string | null {
  const p = String(raw ?? "").trim();
  if (!p.startsWith("/") || p.startsWith("//") || p.length > 300 || /[\s\\<>"'`]/.test(p) || /^\/(api|_next)(\/|$)/.test(p)) return null;
  const path = p.split(/[?#]/)[0];
  if (DENIED_PATHS.some((d) => path === d || path.startsWith(d + "/"))) return null;
  return p;
}

// ── Prüfen, was die KI liefert (wirft nie; Fehlertext geht zurück an die KI) ──
type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

function parseTarget(raw: unknown): Target | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const t: Target = {};
  if (typeof o.id === "string" && /^e\d{1,4}$/.test(o.id)) t.id = o.id;
  if (typeof o.text === "string" && o.text.trim()) t.text = o.text.trim().slice(0, 200);
  if (typeof o.role === "string" && (TARGET_ROLES as readonly string[]).includes(o.role)) t.role = o.role as TargetRole;
  if (typeof o.nth === "number" && Number.isInteger(o.nth) && o.nth >= 0 && o.nth < 50) t.nth = o.nth;
  return t.id || t.text ? t : null;
}

export function parseActions(raw: unknown): Parsed<AgentAction[]> {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: "actions must be a non-empty array" };
  if (raw.length > LIMITS.actions) return { ok: false, error: `at most ${LIMITS.actions} actions per turn` };
  const out: AgentAction[] = [];
  for (const [i, a] of raw.entries()) {
    const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
    const bad = (why: string): Parsed<AgentAction[]> => ({ ok: false, error: `action ${i}: ${why}` });
    switch (o.do) {
      case "navigate": { const path = safePath(o.path); if (!path) return bad("path not allowed (app page starting with /, not account/users/backup)"); out.push({ do: "navigate", path }); break; }
      case "click": { const target = parseTarget(o.target); if (!target) return bad("target needs id or text"); out.push({ do: "click", target, commit: o.commit === true }); break; }
      case "type": {
        const target = parseTarget(o.target); if (!target) return bad("target needs id or text");
        if (typeof o.text !== "string") return bad("text missing");
        out.push({ do: "type", target, text: o.text.slice(0, LIMITS.text), enter: o.enter === true, clear: o.clear !== false }); break;
      }
      case "select": { const target = parseTarget(o.target); const option = str(o.option, 200); if (!target || !option) return bad("target and option needed"); out.push({ do: "select", target, option }); break; }
      case "check": { const target = parseTarget(o.target); if (!target || typeof o.checked !== "boolean") return bad("target and checked needed"); out.push({ do: "check", target, checked: o.checked }); break; }
      case "key": { if (!(AGENT_KEYS as readonly string[]).includes(String(o.key))) return bad(`key must be one of ${AGENT_KEYS.join(", ")}`); out.push({ do: "key", key: o.key as AgentKey }); break; }
      case "wait": { const ms = Math.round(Number(o.ms)); out.push({ do: "wait", ms: Number.isFinite(ms) ? Math.min(Math.max(ms, 100), 4000) : 500 }); break; }
      case "wait_for": { const text = str(o.text, 200).trim(); if (!text) return bad("text needed"); const t = Math.round(Number(o.timeoutMs)); out.push({ do: "wait_for", text, timeoutMs: Number.isFinite(t) ? Math.min(Math.max(t, 500), 10_000) : 6000 }); break; }
      case "attach": {
        const target = parseTarget(o.target);
        const file = str(o.file, 64).trim();
        if (!target || !FILE_ID.test(file)) return bad("attach needs target (the file field) and file (id of an attached file)");
        out.push({ do: "attach", target, file }); break;
      }
      default: return bad(`unknown action "${String(o.do)}"`);
    }
  }
  return { ok: true, value: out };
}

export function parsePlan(raw: unknown): Parsed<Plan> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = str(o.title, 200).trim();
  const steps = Array.isArray(o.steps) ? o.steps : [];
  if (!title || !steps.length) return { ok: false, error: "plan needs title and steps" };
  if (steps.length > LIMITS.planSteps) return { ok: false, error: `at most ${LIMITS.planSteps} steps` };
  const out: PlanStep[] = [];
  for (const s of steps) {
    const so = (s && typeof s === "object" ? s : { text: s }) as Record<string, unknown>;
    const text = str(so.text, 300).trim();
    if (!text) return { ok: false, error: "every step needs text" };
    out.push({ text, commit: so.commit === true });
  }
  return { ok: true, value: { title, steps: out, note: str(o.note, 500).trim() } };
}

export function parseInstruction(name: string, input: unknown): Parsed<Instruction> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "plan": { const p = parsePlan(o); return p.ok ? { ok: true, value: { type: "plan", plan: p.value } } : p; }
    case "act": {
      const a = parseActions(o.actions);
      if (!a.ok) return a;
      const step = Number.isInteger(o.step) && Number(o.step) > 0 && Number(o.step) <= LIMITS.planSteps ? Number(o.step) : null;
      return { ok: true, value: { type: "act", step, say: str(o.say, 200).trim(), actions: a.value } };
    }
    case "ask": {
      const question = str(o.question, 600).trim();
      if (!question) return { ok: false, error: "question needed" };
      const choices = (Array.isArray(o.choices) ? o.choices : []).map((c) => str(c, 80).trim()).filter(Boolean).slice(0, LIMITS.choices);
      return { ok: true, value: { type: "ask", question, choices } };
    }
    case "finish": return { ok: true, value: { type: "finish", summary: str(o.summary, 1500).trim() } };
    default: return { ok: false, error: `unknown instruction ${name}` };
  }
}

/** Ungepaarte UTF-16-Hälften entfernen – ein beim Kürzen halbiertes Emoji würde die Anfrage an die KI ungültig machen */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// ── Snapshot → Text für die KI (Elemente mit [eNN], Werte, Seiten-Text) ──
export function snapshotToText(s: Snapshot): string {
  const q = (v: string) => JSON.stringify(v);
  const lines = [`URL: ${s.url}`, `TITLE: ${s.title}`];
  if (s.dialog) lines.push(`OPEN DIALOG: ${q(s.dialog)} (only its elements are listed)`);
  lines.push("ELEMENTS:");
  for (const e of s.elements.slice(0, LIMITS.elements)) {
    let l = `[${e.id}] ${e.kind} ${q(e.name.slice(0, LIMITS.name))}`;
    if (e.submit) l += " (submits form)";
    if (e.value != null && e.value !== "") l += ` value=${q(e.value)}`;
    if (e.checked != null) l += e.checked ? " checked" : " unchecked";
    if (e.options?.length) l += ` options: ${e.options.slice(0, LIMITS.options).map((o) => o.slice(0, 40)).join(" | ")}`;
    if (e.href) l += ` → ${e.href}`;
    if (e.disabled) l += " [disabled]";
    if (e.blocked) l += " [blocked – never use]";
    lines.push(l);
  }
  if (s.elements.length > LIMITS.elements) lines.push(`… ${s.elements.length - LIMITS.elements} more elements not shown`);
  lines.push("PAGE TEXT:", s.text.slice(0, LIMITS.snapText));
  return wellFormed(lines.join("\n"));
}

/** Sprache → Erkennung im Browser (Kurdisch kann Chrome nicht: nur Tippen) */
export function speechLang(locale: string, browserLangs: readonly string[] = []): string | null {
  if (locale === "ku") return null;
  // Arabisch: syrisch (Wunsch Inhaber 17.11.2026), außer der Browser nennt selbst eine arabische Region
  if (locale === "ar") return browserLangs.find((l) => /^ar-[A-Z]{2}$/i.test(l)) ?? "ar-SY";
  if (locale === "de") return "de-DE";
  return "en-US";
}

/**
 * Kurze Antwort (gesprochen oder getippt) auf den Plan / eine Rückfrage: alles / Schritt für Schritt / nein – sonst null
 * (dann geht der Text als freie Antwort an die KI, z. B. „لا، خلي الكمية 5“). Nur ganze Wörter und nur kurze Antworten,
 * damit eine Änderung („ja, aber Kunde Jahn“) nie als Freigabe gilt.
 */
/** Wortlisten so normalisiert wie die Eingabe (ى → ي, ة → ه, Hamza weg) */
function normList(words: string[]): string[] { return words.map(norm); }
function normSet(words: string[]): Set<string> { return new Set(normList(words)); }
const YES = normSet(["كله", "كلو", "كلها", "نفذ", "نفذه", "نفذو", "نفذها", "كمل", "تمام", "ماشي", "ايوه", "ايوا", "اه", "اي", "ايه", "اوكي", "موافق", "يلا", "اكيد", "طيب", "منيح", "ابدا", "ابدء", "اعمل", "اعملها", "اعمله", "اعملو",
  "alles", "ja", "jawohl", "ok", "okay", "yes", "yeah", "yep", "go", "los", "mach", "machen", "weiter", "sure", "do", "it", "all",
  "ere", "bike", "temam", "bila", "her"]);
const FILL = normSet(["و", "يا", "بس", "خلاص", "ستار", "ستايل", "star", "style", "bitte", "please", "gerne", "it", "it's", "ahead", "einfach", "kerem"]);
const STEP = normList(["خطوه خطوه", "خطوه بخطوه", "كل خطوه", "خطوات", "اسالني", "وحده وحده", "step by step", "each step", "schritt fur schritt", "jeden schritt", "einzeln", "gav bi gav", "her gav"]);
const NO = normSet(["لا", "لاء", "لأ", "مش", "مو", "بلاش", "بلاها", "وقف", "وقّف", "استنى", "لحظه", "الغي", "الغاء", "ارجع", "cancel", "stop", "no", "nope", "nein", "abbrechen", "stopp", "na", "ne", "naxer"]);
export function voiceApproval(text: string): ApprovalMode | "no" | null {
  const n = norm(text).replace(/[.,!?؟،؛;:()\-–—…]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  const words = n.split(" ");
  if (words.length > 6) return null;
  if (STEP.some((s) => ` ${n} `.includes(` ${s} `))) return "step";
  const core = words.filter((w) => !FILL.has(w));
  if (!core.length) return null;
  if (NO.has(core[0])) return core.length <= 2 ? "no" : null; // „لا، خلي الكمية 5“ = Änderung → an die KI
  return core.every((w) => YES.has(w)) ? "auto" : null;
}
