"use client";
/**
 * Assistent „Star Style“ – Ausführung im Browser: Text-Ansicht der Seite (Snapshot) für die KI und sichtbares Bedienen
 * (Zeiger fährt hin, Feld leuchtet, Text wird Buchstabe für Buchstabe getippt, Klick-Welle) – „كأن في واحد قاعد شغال بداله“.
 * Alles über die echten Knöpfe/Felder der Seite (React bekommt normale Ereignisse) – nie an der Oberfläche vorbei.
 */
import { isCommitText, matchScore, norm, safePath, LIMITS, type ActionResult, type AgentAction, type SnapEl, type SnapKind, type Snapshot, type Target } from "@/lib/agent/protocol";

const IGNORE = "[data-ai-ignore]";
const BLOCK = "[data-ai-block]";
const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=option],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=radio],[contenteditable="true"]';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const clean = (s: string | null | undefined, max = 120) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// ── Sichtbarkeit / Bereich ──
function shown(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement) || el.closest(IGNORE) || el.closest('[aria-hidden="true"]') || el.closest("[inert]")) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none";
}
/** oberstes offenes Fenster (Dialog) – sonst der Hauptbereich der Seite */
export function scopeRoot(): HTMLElement {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((d) => shown(d));
  if (dialogs.length) return dialogs[dialogs.length - 1];
  return document.querySelector<HTMLElement>("main") ?? document.body;
}

function reactProps(el: Element): Record<string, unknown> | null {
  const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"));
  return k ? ((el as unknown as Record<string, unknown>)[k] as Record<string, unknown>) : null;
}
/** Such-/Filterformular (GET ohne eigene Logik) – Absenden ändert nichts */
function isSearchForm(f: HTMLFormElement): boolean {
  if ((f.getAttribute("method") || "get").toLowerCase() !== "get") return false;
  const p = reactProps(f);
  return !(p && (typeof p.onSubmit === "function" || typeof p.action === "function"));
}

/** Text einer Beschriftung ohne die Felder darin (eine Auswahlliste würde sonst alle ihre Optionen mitliefern) */
function labelText(lab: Element, self: Element): string {
  let out = "";
  const walk = (n: Node) => {
    if (n === self) return;
    if (n instanceof Element && (n.matches("select,option,textarea,input,button,script,style") || n.matches(IGNORE))) return;
    if (n.nodeType === Node.TEXT_NODE) { out += " " + (n.textContent ?? ""); return; }
    n.childNodes.forEach(walk);
  };
  walk(lab);
  return clean(out);
}

export function nameOf(el: HTMLElement): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return clean(aria);
  const by = el.getAttribute("aria-labelledby");
  if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" "); if (clean(t)) return clean(t); }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const lab = el.labels?.[0] ?? el.closest("label");
    const own = lab ? labelText(lab, el) : "";
    if (own) return own;
    // Beschriftung im selben Feld-Block (z. B. <span class="label"> über dem Feld)
    let p: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const lab = p.querySelector<HTMLElement>("label, .label, [data-label]");
      if (lab && !lab.contains(el) && lab.querySelectorAll("input,select,textarea").length === 0 && clean(lab.innerText)) return clean(lab.innerText);
    }
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
  }
  const t = clean(el.innerText) || clean(el.getAttribute("title")) || clean(el.querySelector("img")?.getAttribute("alt"));
  return t;
}

function kindOf(el: HTMLElement): SnapKind {
  if (el instanceof HTMLAnchorElement) return "link";
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    if (t === "password") return "password";
    if (t === "file") return "file";
    if (t === "checkbox" || t === "radio") return t;
    if (t === "submit" || t === "button" || t === "reset" || t === "image") return "button";
    return "input";
  }
  const role = el.getAttribute("role");
  if (role === "option") return "option";
  if (role === "checkbox" || role === "switch") return "checkbox";
  if (el.isContentEditable) return "input";
  if (el instanceof HTMLButtonElement || role === "button" || role === "tab" || role === "menuitem" || el.tagName === "SUMMARY") return "button";
  return "other";
}

/** Speichert/sendet/löscht dieser Knopf etwas? (Formular absenden, außer Suche/Filter; sonst nach dem Text) */
export function isCommitElement(el: HTMLElement): boolean {
  if (el instanceof HTMLAnchorElement) return false;
  const b = el.closest("button, input[type=submit], input[type=image]") as HTMLButtonElement | HTMLInputElement | null;
  if (b && (b.type === "submit" || b.type === "image") && b.form) return !isSearchForm(b.form);
  return isCommitText(nameOf(el));
}

/** Datei-Feld, das hinter einem Knopf versteckt ist (z. B. „Foto hinzufügen“): zählt, wenn sein Bereich sichtbar ist */
const isFileInput = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === "file";
const hiddenFileOk = (el: Element) => isFileInput(el) && !el.closest(IGNORE) && !!el.parentElement && shown(el.parentElement);

function interactive(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(INTERACTIVE)) {
    if (!(shown(el) || hiddenFileOk(el))) continue;
    if (!out.some((o) => o.contains(el) && o !== el && (o instanceof HTMLButtonElement || o instanceof HTMLAnchorElement))) out.push(el);
  }
  return out;
}

/** Name eines Datei-Felds: Beschriftung, sonst der Knopf daneben („Foto hinzufügen“), dazu was es annimmt */
function fileFieldName(el: HTMLInputElement): string {
  const lab = el.labels?.[0] ?? el.closest("label");
  let n = lab ? labelText(lab, el) : clean(el.getAttribute("aria-label") || el.getAttribute("title"));
  if (!n) {
    const btn = el.parentElement?.querySelector<HTMLElement>("button");
    n = clean(btn?.getAttribute("aria-label") || btn?.getAttribute("title") || btn?.innerText);
  }
  if (!n) {
    let p: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 3 && p && !n; i++, p = p.parentElement) n = clean(p.querySelector<HTMLElement>(".label, label")?.innerText);
  }
  const accept = el.accept ? ` [${el.accept}]` : "";
  return `${n || el.name || "file"}${accept}`;
}
/** sichtbarer Stellvertreter eines versteckten Datei-Felds (für Zeiger und Markierung) */
function visibleProxy(el: HTMLElement): HTMLElement {
  const visible = (e: Element): boolean => shown(e); // ohne Typ-Einengung
  if (visible(el)) return el;
  const lab = (el as HTMLInputElement).labels?.[0] ?? el.closest("label");
  if (lab && shown(lab)) return lab as HTMLElement;
  const btn = el.parentElement?.querySelector<HTMLElement>("button");
  if (btn && shown(btn)) return btn;
  return el.parentElement ?? el;
}
/** Passt die Datei zum accept-Attribut? („image/*,application/pdf“, „.xlsx“) */
function acceptOk(accept: string, file: File): boolean {
  if (!accept.trim()) return true;
  const type = file.type.toLowerCase(), name = file.name.toLowerCase();
  return accept.split(",").map((a) => a.trim().toLowerCase()).some((a) =>
    a.startsWith(".") ? name.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : a === type);
}

/** Seiten-Text ohne Inhalte von Auswahllisten/Skripten (für die KI), Absätze als Zeilen */
function pageText(root: HTMLElement, max: number): string {
  const parts: string[] = [];
  let len = 0, lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p || !n.textContent?.trim() || p.closest("script,style,select,option,noscript," + IGNORE) || !shown(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode(); n && len < max; n = walker.nextNode()) {
    const t = clean(n.textContent, 300);
    const block = n.parentElement!.closest("p,li,tr,h1,h2,h3,h4,div,section,label,td,th,dt,dd") ?? null;
    const sep = block !== lastBlock ? "\n" : " ";
    lastBlock = block;
    parts.push(sep + t); len += t.length + 1;
  }
  return parts.join("").replace(/\n{2,}/g, "\n").trim().slice(0, max);
}

/** Text-Ansicht der Seite für die KI; vergibt data-ai-id an alle bedienbaren Elemente */
export function buildSnapshot(): Snapshot {
  for (const old of document.querySelectorAll("[data-ai-id]")) old.removeAttribute("data-ai-id");
  const root = scopeRoot();
  const els = interactive(root).slice(0, LIMITS.elements);
  const elements: SnapEl[] = els.map((el, i) => {
    const id = `e${i + 1}`;
    el.setAttribute("data-ai-id", id);
    const kind = kindOf(el);
    const e: SnapEl = { id, kind, name: (isFileInput(el) ? fileFieldName(el) : nameOf(el)) || `(${el.tagName.toLowerCase()})` };
    if (el instanceof HTMLInputElement && kind !== "password" && kind !== "file") {
      if (kind === "checkbox" || kind === "radio") e.checked = el.checked; else if (el.value) e.value = el.value.slice(0, 200);
    } else if (el instanceof HTMLTextAreaElement && el.value) e.value = el.value.slice(0, 300);
    else if (el instanceof HTMLSelectElement) {
      e.value = clean(el.selectedOptions[0]?.text, 80);
      e.options = [...el.options].slice(0, LIMITS.options).map((o) => clean(o.text, 60));
    } else if (el.getAttribute("role") === "checkbox" || el.getAttribute("role") === "switch") e.checked = el.getAttribute("aria-checked") === "true";
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") e.disabled = true;
    if (el instanceof HTMLAnchorElement) {
      try { const u = new URL(el.href, location.href); e.href = u.origin === location.origin ? u.pathname + u.search : "(external)"; } catch { /* egal */ }
    }
    if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type === "submit" && el.form && !isSearchForm(el.form)) e.submit = true;
    if (el.closest(BLOCK)) e.blocked = true;
    return e;
  });
  const dialog = root.getAttribute("role") === "dialog" ? clean(root.getAttribute("aria-label") || root.querySelector("h1,h2,h3")?.textContent, 120) || "dialog" : undefined;
  return { url: location.pathname + location.search, title: clean(document.title, 120), dialog, elements, text: pageText(root, LIMITS.snapText) };
}

// ── Element finden (ID aus dem Snapshot, sonst Text; wartet kurz, bis es erscheint) ──
function candidates(role?: Target["role"]): HTMLElement[] {
  const all = interactive(scopeRoot());
  if (!role || role === "any") return all;
  return all.filter((el) => {
    const k = kindOf(el);
    if (role === "input") return k === "input" || k === "textarea";
    if (role === "button") return k === "button";
    return k === role;
  });
}
export async function resolveTarget(t: Target, waitMs = 4000): Promise<{ el: HTMLElement } | { error: string }> {
  const end = performance.now() + waitMs;
  let last = "";
  for (;;) {
    if (t.id) {
      const el = document.querySelector<HTMLElement>(`[data-ai-id="${t.id}"]`);
      if (el && el.isConnected && (shown(el) || hiddenFileOk(el))) return { el };
    }
    if (t.text) {
      const scored = candidates(t.role).map((el) => ({ el, s: Math.max(matchScore(nameOf(el), t.text!), el instanceof HTMLInputElement ? matchScore(el.placeholder, t.text!) : 0) }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      if (scored.length) {
        const best = scored.filter((x) => x.s === scored[0].s);
        const pick = best[Math.min(t.nth ?? 0, best.length - 1)];
        if (best.length === 1 || t.nth != null || scored[0].s >= 2) return { el: pick.el };
        last = `ambiguous: ${best.slice(0, 5).map((x) => JSON.stringify(nameOf(x.el))).join(", ")}`;
      } else last = "no element with this text";
    } else last = "element no longer on the page";
    if (performance.now() > end) return { error: `${t.id ?? ""} ${t.text ? JSON.stringify(t.text) : ""}: ${last}`.trim() };
    await sleep(150);
  }
}

// ── Sichtbar machen: Zeiger, Markierung, Klick-Welle (eigene Elemente, data-ai-ignore) ──
let cursor: HTMLDivElement | null = null;
let ring: HTMLDivElement | null = null;
function layer() {
  if (!cursor || !cursor.isConnected) {
    cursor = document.createElement("div");
    cursor.setAttribute("data-ai-ignore", ""); cursor.setAttribute("aria-hidden", "true");
    Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483600", pointerEvents: "none", transform: `translate(${innerWidth / 2}px, ${innerHeight / 2}px)`, transition: "transform 420ms cubic-bezier(.2,.8,.2,1), opacity 200ms", opacity: "0" });
    cursor.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24" style="filter:drop-shadow(0 3px 6px rgba(11,18,34,.45))"><path d="M4 2.5 19.5 13l-7 1.4 4 7.1-3 1.6-4-7.2-5.1 4.9z" fill="#fff" stroke="#1752D6" stroke-width="1.6" stroke-linejoin="round"/></svg>'
      + '<span style="position:absolute;left:22px;top:20px;white-space:nowrap;border-radius:999px;background:#1752D6;color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 8px;box-shadow:0 2px 8px rgba(23,82,214,.4)">Star Style</span>';
    document.body.appendChild(cursor);
  }
  if (!ring || !ring.isConnected) {
    ring = document.createElement("div");
    ring.setAttribute("data-ai-ignore", ""); ring.setAttribute("aria-hidden", "true");
    Object.assign(ring.style, { position: "fixed", zIndex: "2147483590", pointerEvents: "none", borderRadius: "12px", border: "3px solid #1752D6", boxShadow: "0 0 0 6px rgba(23,82,214,.18), 0 0 24px rgba(23,82,214,.45)", opacity: "0", transition: "all 260ms ease" });
    document.body.appendChild(ring);
  }
  return { cursor, ring };
}
export function hideLayer() {
  if (cursor) cursor.style.opacity = "0";
  if (ring) ring.style.opacity = "0";
}
export function removeLayer() { cursor?.remove(); ring?.remove(); cursor = null; ring = null; }

/** Stelle, auf die der Zeiger zeigt: am Textanfang des Elements (Arabisch rechts) */
function aimX(el: HTMLElement, b: DOMRect) {
  const inset = Math.min(b.width / 2, 40);
  return getComputedStyle(el).direction === "rtl" ? b.right - inset : b.left + inset;
}
async function pointAt(el: HTMLElement) {
  const { cursor: c, ring: r } = layer();
  el.scrollIntoView({ block: "center", inline: "nearest", behavior: reduced() ? "auto" : "smooth" });
  await sleep(reduced() ? 60 : 320);
  const b = el.getBoundingClientRect();
  Object.assign(r.style, { left: `${b.left - 5}px`, top: `${b.top - 5}px`, width: `${b.width + 10}px`, height: `${b.height + 10}px`, opacity: "1" });
  c.style.opacity = "1";
  c.style.transform = `translate(${Math.round(aimX(el, b))}px, ${Math.round(b.top + b.height / 2)}px)`;
  await sleep(reduced() ? 80 : 440);
}
function ripple(el: HTMLElement) {
  const b = el.getBoundingClientRect();
  const d = document.createElement("div");
  d.setAttribute("data-ai-ignore", ""); d.setAttribute("aria-hidden", "true");
  Object.assign(d.style, { position: "fixed", left: `${aimX(el, b) - 20}px`, top: `${b.top + b.height / 2 - 20}px`, width: "40px", height: "40px", borderRadius: "999px", background: "rgba(23,82,214,.35)", zIndex: "2147483595", pointerEvents: "none" });
  document.body.appendChild(d);
  const anim = d.animate([{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1.6)", opacity: 0 }], { duration: 450, easing: "ease-out" });
  anim.onfinish = () => d.remove();
}

// ── Echte Ereignisse (React hört auf input/change/click/keydown) ──
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
}
function fireClick(el: HTMLElement) {
  const b = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2, view: window, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerdown", { ...o, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mousedown", o));
  el.focus?.({ preventScroll: true });
  el.dispatchEvent(new PointerEvent("pointerup", { ...o, pointerType: "mouse", isPrimary: true }));
  el.dispatchEvent(new MouseEvent("mouseup", o));
  el.click();
}
function fireKey(el: Element, key: string) {
  const code = key === "Enter" ? 13 : key === "Escape" ? 27 : key === "Tab" ? 9 : key === "Backspace" ? 8 : key === "ArrowDown" ? 40 : key === "ArrowUp" ? 38 : 0;
  const o = { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true };
  const free = el.dispatchEvent(new KeyboardEvent("keydown", o));
  // Enter in einem Textfeld schickt das Formular ab (wie der Browser) – außer die Seite fängt Enter selbst ab.
  // Speichert das Formular etwas, fragt der Netz-Wächter (unten) vorher nach.
  if (key === "Enter" && free && el instanceof HTMLInputElement && el.form && !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(el.type)) el.form.requestSubmit();
  el.dispatchEvent(new KeyboardEvent("keyup", o));
}

// ── warten, bis die Seite ruhig ist (Laden fertig, keine Änderungen mehr) ──
let lastChange = 0;
let observer: MutationObserver | null = null;
function watch() {
  if (observer) return;
  observer = new MutationObserver((list) => { if (list.some((m) => !(m.target instanceof Element && m.target.closest(IGNORE)))) lastChange = performance.now(); });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
export async function settle(maxMs = 10_000) {
  watch();
  const start = performance.now();
  await sleep(140);
  while (performance.now() - start < maxMs) {
    const busy = document.querySelector("[data-ai-loading], [aria-busy='true']");
    if (!busy && performance.now() - lastChange > 380) return;
    await sleep(100);
  }
}

export type ExecCtx = {
  aborted: () => boolean;
  /** darf dieser Klick (speichert/sendet/…) ohne Rückfrage? „ask“ = Nutzer fragen */
  commitPolicy: (aiFlagged: boolean) => "yes" | "ask";
  confirmCommit: (label: string) => Promise<boolean>;
  navigate: (path: string) => Promise<void>;
  /** vor jedem Schritt: bisherige Ergebnisse (falls die Seite gleich neu lädt, z. B. ein Filter) */
  progress?: (results: ActionResult[], next: number) => void;
  /** Speichern wurde abgelehnt, nachdem es schon angestoßen war: Seite neu laden (nichts gespeichert) */
  blockedWrite?: () => void;
  /** vom Nutzer im Chat abgelegte Datei (für „attach“) */
  fileById?: (id: string) => File | null;
};

/*
 * Netz-Wächter (zweite Sicherung, Wunsch Inhaber: „لازم ياخد الكونفرميشن الأول“): Jede Änderung im System läuft über
 * eine Server-Action (POST mit Kopfzeile Next-Action). Solange der Assistent Schritte ausführt, geht keine davon ohne
 * Freigabe raus – auch wenn ein Knopf nicht als „Speichern“ erkannt wurde: freigegebener Speicher-Schritt oder Rückfrage.
 * Abgelehnt → die Anfrage geht nie raus, die Seite lädt neu (Next würde sonst auf die Antwort warten).
 */
type Guard = { ctx: ExecCtx; allow: boolean; label: string; pending: number; declined: boolean };
let guard: Guard | null = null;
let realFetch: typeof fetch | null = null;
/** Seiten, deren Server-Actions nur lesen (Scanner nachschlagen, Fragen, KI-Monatsbericht) */
const READ_ONLY_ACTION_PAGES = new Set(["/scan", "/ask", "/reports"]);
function isActionRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD") return false;
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).has("next-action");
}
function installGuard() {
  if (realFetch || typeof window === "undefined") return;
  const orig = (realFetch = window.fetch);
  window.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const g = guard;
    if (!g || !isActionRequest(input, init) || g.allow || READ_ONLY_ACTION_PAGES.has(location.pathname) || g.ctx.commitPolicy(false) === "yes") return orig.call(window, input, init);
    g.pending++;
    return g.ctx.confirmCommit(g.label).then((ok) => {
      g.pending--;
      if (ok) { g.allow = true; return orig.call(window, input, init); }
      g.declined = true;
      g.ctx.blockedWrite?.();
      return new Promise<Response>(() => {});
    });
  } as typeof fetch;
}
/** wartet, solange der Nutzer über ein Speichern entscheidet */
async function guardIdle(g: Guard, aborted: () => boolean) {
  if (!g.pending) return;
  while (g.pending > 0 && !aborted()) await sleep(120);
  await settle();
}

/** Eine Reihe von Schritten sichtbar ausführen; hält beim ersten Fehler an */
export type RunOutcome = { results: ActionResult[]; stopped: "error" | "declined" | "aborted" | "reload" | null };
export async function runActions(actions: AgentAction[], ctx: ExecCtx): Promise<RunOutcome> {
  installGuard();
  const g: Guard = { ctx, allow: false, label: "", pending: 0, declined: false };
  guard = g;
  try { return await runAll(actions, ctx, g); } finally {
    if (guard === g) guard = null;
    if (ring) ring.style.opacity = "0"; // Rahmen weg (die Seite hat sich evtl. geändert); der Zeiger bleibt bis zum nächsten Schritt
  }
}
async function runAll(actions: AgentAction[], ctx: ExecCtx, g: Guard): Promise<RunOutcome> {
  const results: ActionResult[] = [];
  for (const [i, a] of actions.entries()) {
    if (ctx.aborted()) return { results, stopped: "aborted" };
    ctx.progress?.(results, i);
    g.allow = false; g.label = "";
    const fail = (note: string, stopped: "error" | "declined" = "error") => { results.push({ i, ok: false, note: note.slice(0, 300) }); return { results, stopped }; };
    /** nach jedem Schritt: hat der Wächter ein Speichern zurückgehalten? */
    const afterStep = async (): Promise<RunOutcome | null> => {
      await guardIdle(g, ctx.aborted);
      if (g.declined) { results.push({ i, ok: false, note: "the user declined saving – nothing was saved, the page reloads" }); return { results, stopped: "reload" }; }
      return null;
    };
    try {
      if (a.do === "navigate") {
        const path = safePath(a.path);
        if (!path) return fail("page not allowed");
        hideLayer();
        await ctx.navigate(path);
        results.push({ i, ok: true, note: `now at ${location.pathname}${location.search}` });
        continue;
      }
      if (a.do === "wait") { await sleep(a.ms); results.push({ i, ok: true }); continue; }
      if (a.do === "wait_for") {
        const end = performance.now() + (a.timeoutMs ?? 6000);
        let found = false;
        while (performance.now() < end && !ctx.aborted()) { if (norm(scopeRoot().innerText).includes(norm(a.text))) { found = true; break; } await sleep(150); }
        if (!found) return fail(`text ${JSON.stringify(a.text)} did not appear`);
        results.push({ i, ok: true }); continue;
      }
      if (a.do === "key") {
        const el = (document.activeElement as HTMLElement | null) ?? document.body;
        if (el.closest(BLOCK)) return fail("blocked element");
        g.label = nameOf(el);
        fireKey(el, a.key); await settle(4000);
        const stop = await afterStep(); if (stop) return stop;
        results.push({ i, ok: true }); continue;
      }
      const r = await resolveTarget(a.target);
      if ("error" in r) return fail(r.error);
      const el = r.el;
      if (el.closest(BLOCK)) return fail("this element is blocked for the assistant – the user must do it");
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return fail("element is disabled");
      if (a.do === "attach") {
        const input = isFileInput(el) ? el : (el.querySelector<HTMLInputElement>("input[type=file]") ?? (el instanceof HTMLLabelElement ? (el.control as HTMLInputElement | null) : null));
        if (!input || !isFileInput(input)) return fail("this is not a file field – use the element listed with kind \"file\"");
        if (input.closest(BLOCK)) return fail("this element is blocked for the assistant – the user must do it");
        const file = ctx.fileById?.(a.file);
        if (!file) return fail("this file is not available in the browser any more – ask the user to attach it again");
        if (!acceptOk(input.accept, file)) return fail(`this field only takes ${input.accept}`);
        const proxy = visibleProxy(input);
        await pointAt(proxy);
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        ripple(proxy);
        await settle(6000);
        const stop = await afterStep(); if (stop) return stop;
        results.push({ i, ok: true, note: `attached ${file.name}` });
        continue;
      }
      if (a.do === "click") {
        const commit = isCommitElement(el) || !!a.commit;
        g.label = nameOf(el);
        if (commit && ctx.commitPolicy(!!a.commit) === "ask") {
          await pointAt(el);
          const ok = await ctx.confirmCommit(g.label);
          if (!ok) { hideLayer(); return fail("user declined this click", "declined"); }
        } else await pointAt(el);
        // schon gefragt bzw. freigegeben – oder ein nur lesender Knopf (data-ai-readonly, z. B. „Beleg lesen“): der Wächter fragt nicht
        g.allow = commit || !!el.closest("[data-ai-readonly]");
        ripple(el);
        fireClick(el);
        await settle();
        const stop = await afterStep(); if (stop) return stop;
        results.push({ i, ok: true, note: commit ? "pressed (saves/sends)" : undefined });
        continue;
      }
      if (a.do === "type") {
        if (el instanceof HTMLInputElement && (el.type === "password" || el.type === "file")) return fail("cannot type into password/file fields");
        const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
        if (!isField && !el.isContentEditable) return fail("element is not a text field");
        await pointAt(el);
        fireClick(el);
        const text = a.text;
        if (isField) {
          const f = el as HTMLInputElement | HTMLTextAreaElement;
          if (a.clear !== false && f.value) { setNativeValue(f, ""); f.dispatchEvent(new Event("input", { bubbles: true })); }
          const base = a.clear !== false ? "" : f.value;
          const delay = reduced() ? 0 : Math.max(6, Math.min(32, Math.floor(1100 / Math.max(text.length, 1))));
          // Buchstabe für Buchstabe (sichtbar); lange Texte in Stücken
          const step = text.length > 120 ? Math.ceil(text.length / 60) : 1;
          for (let k = step; k < text.length + step; k += step) {
            if (ctx.aborted()) return { results, stopped: "aborted" };
            setNativeValue(f, base + text.slice(0, Math.min(k, text.length)));
            f.dispatchEvent(new Event("input", { bubbles: true }));
            if (delay) await sleep(delay);
          }
          f.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.focus();
          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, text);
        }
        g.label = nameOf(el);
        if (a.enter) fireKey(el, "Enter");
        await settle(6000);
        const stop = await afterStep(); if (stop) return stop;
        results.push({ i, ok: true });
        continue;
      }
      if (a.do === "select") {
        if (!(el instanceof HTMLSelectElement)) return fail("element is not a select box – click it and choose the option instead");
        const opts = [...el.options];
        const best = opts.map((o) => ({ o, s: Math.max(matchScore(o.text, a.option), o.value === a.option ? 3 : 0) })).sort((x, y) => y.s - x.s)[0];
        if (!best || best.s === 0) return fail(`option ${JSON.stringify(a.option)} not found; options: ${opts.slice(0, 15).map((o) => o.text.trim()).join(" | ")}`);
        await pointAt(el);
        el.focus();
        setNativeValue(el, best.o.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        ripple(el);
        await settle();
        const stop = await afterStep(); if (stop) return stop;
        results.push({ i, ok: true, note: `selected ${JSON.stringify(best.o.text.trim())}` });
        continue;
      }
      if (a.do === "check") {
        const isBox = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
        const now = isBox ? (el as HTMLInputElement).checked : el.getAttribute("aria-checked") === "true";
        await pointAt(el);
        g.label = nameOf(el);
        if (now !== a.checked) { ripple(el); fireClick(el); await settle(4000); }
        const stop = await afterStep(); if (stop) return stop;
        results.push({ i, ok: true });
        continue;
      }
    } catch (e) {
      return fail(`error: ${(e as Error).message}`);
    }
  }
  return { results, stopped: null };
}
