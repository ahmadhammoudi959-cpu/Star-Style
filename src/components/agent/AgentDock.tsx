"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import type { Dict } from "@/i18n/de";
import { speechLang, voiceApproval, type ApprovalMode, type Instruction, type Plan, type ActionResult } from "@/lib/agent/protocol";
import { buildSnapshot, hideLayer, removeLayer, runActions, settle } from "./runtime";
import { canListen, listen, LISTEN, speak, stopSpeaking, type ListenCtrl } from "./voice";

type T = Dict["agent"];
type Phase = "idle" | "thinking" | "plan" | "stepConfirm" | "commitConfirm" | "ask" | "running" | "done" | "error";
type Log = { who: "user" | "ai" | "sys"; text: string };
/** im Chat abgelegte Datei: wird sofort hochgeladen (/api/temp-files), geschickt wird nur die ID */
type Pending = { key: string; file: File; status: "uploading" | "ready" | "error"; id?: string; error?: string };
const MAX_FILE = 20 * 1024 * 1024;
type Act = Extract<Instruction, { type: "act" }>;
type Saved = { runId: string; mode: ApprovalMode | null; plan: Plan | null; step: number | null; log: Log[]; phase: Phase; at: number;
  /** Ergebnisse bis zum Neuladen (Filter/Suche lädt die Seite neu) bzw. Hinweis für die KI */
  partial?: ActionResult[]; next?: number; note?: string };
const KEY = "ss-agent"; // Stand für ein Neuladen der Seite mitten im Ablauf (nur dieser Tab)
const VOICE_KEY = "ss-agent-voice";

/**
 * Assistent „Star Style“ (Wunsch Inhaber 17.11.2026): Knopf unten (oder F2) → „أهلين، قلّي شو بدّك أعملّك؟“ → Bitte
 * sprechen oder tippen → Plan zur Freigabe (alles ohne Nachfragen / jede Schritt bestätigen) → das System wird sichtbar
 * bedient (Seiten wechseln, Felder füllen sich, Knöpfe werden gedrückt). Speichern/Senden nur in freigegebenen Schritten.
 */
/**
 * Licht um den Bildschirm in den Logo-Farben, solange der Assistent arbeitet oder zuhört (Wunsch Inhaber 17.11.2026:
 * „يعرف إن في ذكاء اصطناعي دلوقتي ماسك الشاشة“). Wartet er auf eine Antwort → schwächer und langsamer; danach blendet es aus.
 */
function AgentGlow({ state }: { state: "on" | "wait" | null }) {
  const [shown, setShown] = useState(state);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state) { setShown(state); return; }
    const timer = setTimeout(() => setShown(null), 700);
    return () => clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    // Tempo ändern ohne Sprung: die laufende CSS-Animation behält ihre Stelle (andere Dauer würde die Farben springen lassen)
    for (const a of ref.current?.getAnimations() ?? []) {
      if ((a as CSSAnimation).animationName === "ai-spin") a.updatePlaybackRate(shown === "wait" ? 0.35 : 1);
    }
  }, [shown]);
  if (!shown) return null;
  return <div ref={ref} aria-hidden data-agent-glow={state ?? "out"} className={`ai-glow ${!state ? "ai-glow-out" : state === "wait" ? "ai-glow-wait" : ""}`} />;
}

export function AgentDock({ t, locale }: { t: T; locale: string }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<Log[]>([]);
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [mode, setMode] = useState<ApprovalMode | null>(null);
  const [ask, setAsk] = useState<{ question: string; choices: string[] } | null>(null);
  const [status, setStatus] = useState("");
  const [step, setStep] = useState<number | null>(null);
  const [commitLabel, setCommitLabel] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const [micOk, setMicOk] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const pendingRef = useRef<Pending[]>([]);
  pendingRef.current = pending;
  /** hochgeladene Dateien dieses Tabs (ID → Datei) – für „attach“ in ein Datei-Feld der Seite */
  const filesRef = useRef(new Map<string, File>());
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // Zuhören ist kein eigener Schritt: der Plan / die Rückfrage bleibt sichtbar und die Antwort gilt dafür
  const [listening, setListening] = useState(false);
  const listeningRef = useRef(false);
  listeningRef.current = listening;

  const runId = useRef<string | null>(null);
  const modeRef = useRef<ApprovalMode | null>(null);
  const planRef = useRef<Plan | null>(null);
  const confirmedStep = useRef<number | null>(null);
  const pendingAct = useRef<Act | null>(null);
  const aborted = useRef(false);
  const commitResolve = useRef<((ok: boolean) => void) | null>(null);
  const stopListening = useRef<ListenCtrl | null>(null);
  const [pausing, setPausing] = useState(false);
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  const voiceRef = useRef(true);
  voiceRef.current = voiceOn;
  const logBox = useRef<HTMLDivElement>(null);
  const logRef = useRef<Log[]>([]);
  logRef.current = log;
  /** letzte Anfrage an den Server – „Nochmal versuchen“ nach einem Fehler der KI (überlastet, Zeit um, Netz) */
  const lastPayload = useRef<Record<string, unknown> | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  /** erst nach dem Wiederherstellen speichern (sonst löscht das erste Speichern den Stand vor dem Lesen) */
  const restored = useRef(false);
  /** Hinweis für die KI nach einer Bestätigungs-Antwort mit eigenem Text („لا، خلي الكمية 5“) */
  const noteRef = useRef("");
  const lang = speechLang(locale, typeof navigator !== "undefined" ? navigator.languages : []);

  const say = useCallback((text: string) => { if (voiceRef.current && lang) void speak(text, lang); }, [lang]);
  const add = useCallback((who: Log["who"], text: string) => { if (text.trim()) setLog((l) => [...l.slice(-40), { who, text }]); }, []);

  // ── Ablauf merken (Neuladen mitten im Ablauf) ──
  useEffect(() => {
    setMounted(true);
    setMicOk(canListen() && !!lang);
    try { if (localStorage.getItem(VOICE_KEY) === "0") setVoiceOn(false); } catch { /* egal */ }
  }, [lang]);
  const saveState = useCallback((extra: Partial<Saved> = {}) => {
    if (!restored.current) return;
    try {
      if (!runId.current || phaseRef.current === "idle") { sessionStorage.removeItem(KEY); return; }
      const prev = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Saved | null;
      const phaseNow = extra.phase ?? phaseRef.current;
      // Ergebnisse der laufenden Schritte behalten, auch während der Rückfrage vor dem Speichern
      const keep = prev && prev.runId === runId.current && (phaseNow === "running" || phaseNow === "commitConfirm") ? { partial: prev.partial, next: prev.next, note: prev.note } : {};
      const st: Saved = { runId: runId.current, mode: modeRef.current, plan: planRef.current, step: confirmedStep.current, log: logRef.current.slice(-20), phase: phaseNow, at: Date.now(), ...keep, ...extra };
      sessionStorage.setItem(KEY, JSON.stringify(st));
    } catch { /* ohne Speicher */ }
  }, []);
  useEffect(() => { if (mounted) saveState(); }, [mounted, phase, log, saveState]);

  useEffect(() => { logBox.current?.scrollTo({ top: logBox.current.scrollHeight, behavior: "smooth" }); }, [log, phase, ask, plan]);

  // ── Server ──
  const errorText = useCallback((code: string) => (t.errors as Record<string, string>)[code] ?? t.errors.error, [t]);
  const navigate = useCallback(async (path: string) => {
    const before = location.pathname + location.search;
    router.push(path);
    const end = performance.now() + 12_000;
    while (performance.now() < end && location.pathname + location.search === before && before !== path) await new Promise((r) => setTimeout(r, 100));
    await settle(12_000);
  }, [router]);

  const handleRef = useRef<(ins: Instruction) => void>(() => {});
  const call = useCallback(async (payload: Record<string, unknown>) => {
    lastPayload.current = payload; setCanRetry(false);
    setPhase("thinking"); setStatus(t.thinking);
    try {
      const snapshot = buildSnapshot();
      const res = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, snapshot }) });
      if (aborted.current) return;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = res.status === 403 ? "forbidden" : res.status === 503 ? "notConfigured" : String(j.error ?? "error");
        handleRef.current({ type: "error", code });
        setCanRetry(res.status === 502 && ["timeout", "rateLimit", "overloaded", "network", "error", "noAnswer"].includes(code));
        return;
      }
      runId.current = j.runId ?? runId.current;
      handleRef.current(j.instruction as Instruction);
    } catch {
      if (!aborted.current) { handleRef.current({ type: "error", code: "network" }); setCanRetry(true); }
    }
  }, [t]);

  const stepIsCommit = (n: number | null) => !!(n && planRef.current?.steps[n - 1]?.commit);

  const execute = useCallback(async (ins: Act) => {
    setPhase("running"); setOpen(false);
    setStep(ins.step); setStatus(ins.say || t.running);
    if (ins.say) add("ai", ins.say);
    const out = await runActions(ins.actions, {
      aborted: () => aborted.current,
      commitPolicy: () => (planRef.current && modeRef.current && stepIsCommit(ins.step) ? "yes" : "ask"),
      confirmCommit: (label) => new Promise<boolean>((resolve) => {
        const l = label || t.saveGeneric;
        commitResolve.current = resolve; setCommitLabel(l); setPhase("commitConfirm"); setOpen(false);
        say(t.commitAsk.replace("{label}", l));
      }),
      navigate,
      fileById: (id) => filesRef.current.get(id) ?? null,
      progress: (results, next) => saveState({ phase: "running", partial: results, next }),
      blockedWrite: () => {
        add("sys", t.declined);
        saveState({ phase: "running", note: "The user declined saving. The page was reloaded – nothing was saved, inputs that were not saved are gone. Check the page." });
        window.setTimeout(() => location.reload(), 250);
      },
    });
    if (aborted.current || out.stopped === "aborted" || out.stopped === "reload") return;
    if (out.stopped === "declined") add("sys", t.declined);
    setPhase("thinking"); setStatus(t.thinking);
    const note = noteRef.current; noteRef.current = "";
    await call({ kind: "continue", runId: runId.current, results: out.results satisfies ActionResult[], ...(note ? { note } : {}) });
  }, [add, call, navigate, say, t]);

  const handle = useCallback((ins: Instruction) => {
    if (aborted.current) return;
    switch (ins.type) {
      case "plan":
        planRef.current = ins.plan; setPlan(ins.plan); setPhase("plan"); setOpen(true);
        say(`${ins.plan.title}. ${t.planQuestion}`);
        break;
      case "act":
        if (modeRef.current === "step" && ins.step && ins.step !== confirmedStep.current) {
          pendingAct.current = ins; setStep(ins.step); setPhase("stepConfirm"); setOpen(true);
          say(`${t.stepN.replace("{n}", String(ins.step))}: ${planRef.current?.steps[ins.step - 1]?.text ?? ins.say}`);
          break;
        }
        void execute(ins);
        break;
      case "ask":
        setAsk({ question: ins.question, choices: ins.choices }); add("ai", ins.question); setPhase("ask"); setOpen(true); hideLayer();
        say(ins.question);
        break;
      case "finish":
        hideLayer(); setPhase("done"); setOpen(true); setStatus("");
        if (ins.summary) { add("ai", ins.summary); say(ins.summary); }
        break;
      case "error":
        hideLayer(); setPhase("error"); setOpen(true); add("sys", errorText(ins.code));
        if (ins.code === "expired" || ins.code === "tooLong") runId.current = null;
        break;
    }
  }, [add, errorText, execute, say, t]);
  handleRef.current = handle;

  // ── Dateien (Excel, CSV, PDF, Fotos) ──
  const addFiles = useCallback((list: FileList | File[]) => {
    const arr = [...list];
    if (!arr.length) return;
    setOpen(true);
    const room = 10 - pendingRef.current.length;
    if (arr.length > room) { add("sys", t.errors.tooManyFiles); arr.length = Math.max(0, room); }
    for (const file of arr) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const fail = (error: string) => setPending((p) => [...p, { key, file, status: "error", error }]);
      if (file.size > MAX_FILE) { fail(t.errors.fileTooLarge); continue; }
      if (/\.xls$/i.test(file.name)) { fail(t.errors.fileXls); continue; }
      setPending((p) => [...p, { key, file, status: "uploading" }]);
      void (async () => {
        try {
          const res = await fetch("/api/temp-files", { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: file });
          const j = await res.json().catch(() => ({})) as { id?: string; error?: string };
          if (!res.ok || !j.id) throw new Error(j.error ?? "fileUpload");
          filesRef.current.set(j.id, file);
          setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "ready", id: j.id } : x)));
        } catch (e) {
          const code = e instanceof Error ? e.message : "fileUpload";
          setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "error", error: (t.errors as Record<string, string>)[code] ?? t.errors.fileUpload } : x)));
        }
      })();
    }
  }, [add, t]);
  const dragHasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes("Files");

  // ── Nutzer ──
  const resetRun = () => { runId.current = null; modeRef.current = null; planRef.current = null; confirmedStep.current = null; setPlan(null); setMode(null); setAsk(null); setStep(null); };
  const submit = useCallback((text: string) => {
    const p = phaseRef.current;
    if (pendingRef.current.some((x) => x.status === "uploading")) return; // erst fertig hochladen
    const ready = p === "stepConfirm" || p === "commitConfirm" ? [] : pendingRef.current.filter((x) => x.status === "ready" && x.id);
    const named = ready.map((x) => `📎 ${x.file.name}`).join("\n");
    let goal = text.trim();
    if (!goal && ready.length) goal = named;
    if (!goal) return;
    const files = ready.length ? ready.map((x) => x.id!) : undefined;
    const shown = text.trim() && ready.length ? `${goal}\n${named}` : goal;
    if (ready.length) setPending([]);
    setInput(""); stopSpeaking();
    // Antwort auf „Weiter?“ / „Jetzt speichern?“: ja/nein – eigener Text = nein + Text an die KI
    if (p === "stepConfirm") {
      const v = voiceApproval(goal);
      add("user", goal);
      if (v === "auto" || v === "step") { confirmStep("go"); return; }
      if (v === "no") { confirmStep("stop"); return; }
      pendingAct.current = null;
      if (runId.current) void call({ kind: "answer", runId: runId.current, answer: goal });
      return;
    }
    if (p === "commitConfirm") {
      const v = voiceApproval(goal);
      add("user", goal);
      if (v !== "auto" && v !== "step" && v !== "no") noteRef.current = goal;
      answerCommit(v === "auto" || v === "step");
      return;
    }
    aborted.current = false; add("user", shown);
    if (p === "plan" && runId.current) {
      const v = files ? null : voiceApproval(goal);
      if (v === "auto" || v === "step") { approve(v, true); return; }
      void call({ kind: "answer", runId: runId.current, answer: v === "no" ? "" : goal, approve: "no", files }); setPlan(null); return;
    }
    if ((p === "ask" || p === "done") && runId.current) {
      setAsk(null);
      if (p === "done") { modeRef.current = null; planRef.current = null; confirmedStep.current = null; setPlan(null); setMode(null); }
      void call({ kind: "answer", runId: runId.current, answer: goal, files }); return;
    }
    resetRun();
    void call({ kind: "start", goal, files });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [add, call]);

  const approve = (m: ApprovalMode, spoken = false) => {
    if (!runId.current) return;
    modeRef.current = m; setMode(m); confirmedStep.current = null; aborted.current = false;
    if (!spoken) add("user", m === "auto" ? t.runAll : t.stepByStep);
    setPlan(null);
    void call({ kind: "answer", runId: runId.current, answer: "", approve: m });
  };
  const rejectPlan = () => {
    if (!runId.current) return;
    add("user", t.cancel); setPlan(null);
    void call({ kind: "answer", runId: runId.current, answer: "", approve: "no" });
  };
  const confirmStep = (choice: "go" | "all" | "stop") => {
    const act = pendingAct.current; pendingAct.current = null;
    if (choice === "stop" || !act) { stop(); return; }
    if (choice === "all") { modeRef.current = "auto"; setMode("auto"); }
    confirmedStep.current = act.step;
    void execute(act);
  };
  const answerCommit = (ok: boolean) => { const r = commitResolve.current; commitResolve.current = null; setPhase("running"); setOpen(false); r?.(ok); };
  const stop = useCallback(() => {
    aborted.current = true; stopSpeaking(); stopListening.current?.cancel(); setListening(false); hideLayer();
    commitResolve.current?.(false); commitResolve.current = null;
    if (runId.current) void fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "cancel", runId: runId.current }) }).catch(() => {});
    resetRun(); setPhase("idle"); setStatus(""); add("sys", t.stopped);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [add, t]);

  const mic = useCallback(async () => {
    if (listeningRef.current) { stopListening.current?.finish(); return; } // nochmal Knopf/F2 = fertig, jetzt abschicken
    const p = phaseRef.current;
    if (p === "thinking" || p === "running") return; // währenddessen nur „Stopp“
    if (!lang || !canListen()) { setOpen(true); add("sys", t.errors.mic); return; }
    setOpen(true);
    stopSpeaking();
    // „أيوه، قول لي أعمل لك إيه؟“ nur bei einer neuen Bitte
    if (voiceRef.current && (p === "idle" || p === "done" || p === "error")) await speak(t.greet, lang);
    setListening(true);
    setPausing(false);
    // Freigabe-Antworten („إي“ / „لا“) sind kurz → kürzere Pause; Bitten und Änderungen: bis zu 3 s Pause zum Nachdenken
    const short = p === "stepConfirm" || p === "commitConfirm";
    stopListening.current = listen(lang, {
      partial: (txt) => setInput(txt),
      pause: (q) => setPausing(q),
      done: (txt, cancelled) => {
        stopListening.current = null; setListening(false); setPausing(false);
        if (txt) submit(txt); else if (!cancelled) add("sys", t.heardNothing);
      },
      error: (code) => { stopListening.current = null; setListening(false); setPausing(false); add("sys", code === "not-allowed" || code === "service-not-allowed" ? t.errors.mic : t.errors.micStopped); },
    }, short ? { ...LISTEN, silenceMs: 1800 } : LISTEN);
  }, [add, lang, submit, t]);

  // F2 = sprechen (öffnet das Fenster); Ctrl+K = Fenster zum Tippen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); void mic(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen(true); window.setTimeout(() => document.getElementById("ss-agent-input")?.focus(), 50); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mic]);

  // Neuladen mitten im Ablauf: weitermachen (die KI prüft die Seite)
  useEffect(() => {
    if (!mounted || restored.current) return;
    try {
      const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Saved | null;
      if (!s || Date.now() - s.at > 3 * 60_000) { sessionStorage.removeItem(KEY); return; }
      runId.current = s.runId; modeRef.current = s.mode; planRef.current = s.plan; confirmedStep.current = s.step; setMode(s.mode); setLog(s.log ?? []);
      if (s.phase === "running" || s.phase === "thinking") {
        aborted.current = false;
        phaseRef.current = "thinking"; setPhase("thinking"); setStatus(t.thinking);
        // Filter/Suche lädt die Seite neu: die Schritte davor sind gelaufen, der letzte hat die Seite neu geladen
        const results: ActionResult[] = s.partial?.length || s.next != null
          ? [...(s.partial ?? []), { i: s.next ?? -1, ok: !s.note, note: s.note ?? "done – the page reloaded (form/filter submitted); later actions of that batch were not run" }]
          : [{ i: -1, ok: false, note: s.note ?? "the page was reloaded during the last steps – check the page" }];
        void settle(8000).then(() => call({ kind: "continue", runId: s.runId, results }));
      } else if (s.phase === "done") { phaseRef.current = "done"; setPhase("done"); }
    } catch { /* egal */ } finally { restored.current = true; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  useEffect(() => () => removeLayer(), []);

  if (!mounted) return null;
  const busy = phase === "thinking" || phase === "running";
  const total = planRef.current?.steps.length ?? 0;
  const stepLine = step && total ? t.stepOf.replace("{n}", String(step)).replace("{m}", String(total)) : "";
  const statusText = listening ? t.listening : phase === "thinking" ? t.thinking : phase === "running" ? status || t.running : phase === "plan" ? t.planWaiting : phase === "ask" || phase === "stepConfirm" || phase === "commitConfirm" ? t.waitingYou : t.ready;

  const glow = busy || listening ? "on" : phase === "plan" || phase === "ask" || phase === "stepConfirm" || phase === "commitConfirm" ? "wait" : null;

  return createPortal(
    <div data-ai-ignore className="print:hidden">
      <AgentGlow state={glow} />
      {/* Rückfrage vor dem Speichern: oben, damit der markierte Knopf sichtbar bleibt (das Fenster unten könnte ihn verdecken) */}
      {phase === "commitConfirm" && !open && (
        <div className="pointer-events-none fixed inset-x-3 top-3 z-[66] flex justify-center">
        <div className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl bg-amber-50 px-4 py-2.5 text-sm text-amber-950 shadow-lift ring-2 ring-amber-300 animate-rise" role="alertdialog" aria-live="assertive" data-agent-commit-bar>
          <span className="min-w-0 font-bold" dir="auto">{t.commitAsk.replace("{label}", commitLabel)}</span>
          <span className="flex shrink-0 gap-2">
            <button type="button" onClick={() => answerCommit(true)} className="btn-primary px-4 py-1.5 text-sm" data-agent-commit-yes><Icon name="check" className="h-4 w-4" />{t.yes}</button>
            <button type="button" onClick={() => answerCommit(false)} className="btn-ghost px-4 py-1.5 text-sm" data-agent-commit-no>{t.no}</button>
            <button type="button" onClick={() => setOpen(true)} className="rounded-full px-2 py-1 text-xs font-semibold text-amber-900 underline-offset-2 hover:underline">{t.show}</button>
          </span>
        </div>
        </div>
      )}
      {/* Läuft: schmale Leiste oben – die Seite bleibt frei sichtbar */}
      {busy && !open && (
        <div className="pointer-events-none fixed inset-x-3 top-3 z-[66] flex justify-center">
        <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full bg-navy-900/95 py-2 pe-2 ps-4 text-sm text-white shadow-lift ring-1 ring-white/10 animate-rise" role="status" aria-live="polite" data-agent-bar>
          <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <span className="min-w-0 truncate font-semibold" dir="auto">{statusText}</span>
          {stepLine && <span className="num shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-xs">{stepLine}</span>}
          <button type="button" onClick={() => setOpen(true)} className="shrink-0 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold hover:bg-white/20">{t.show}</button>
          <button type="button" onClick={stop} className="shrink-0 rounded-full bg-red-500 px-3 py-1 text-xs font-bold hover:bg-red-600" data-agent-stop>{t.stop}</button>
        </div>
        </div>
      )}

      {/* Knopf unten – nicht während der Arbeit (er läge sonst z. B. auf dem „Speichern“-Knopf, den der Assistent gerade zeigt; oben ist dann die Leiste) */}
      {!open && !busy && phase !== "commitConfirm" && (
        <button type="button" onClick={() => setOpen(true)} title={t.open} aria-label={t.open} data-agent-open
          className="group fixed bottom-24 end-4 z-[66] flex h-14 items-center gap-2 rounded-full bg-gradient-to-br from-brand-600 to-navy-900 pe-2 ps-2 text-white shadow-lift ring-4 ring-white/80 transition hover:-translate-y-0.5 sm:pe-5 lg:bottom-6 lg:end-6">
          <span className={`relative grid h-10 w-10 place-items-center rounded-full bg-white/15 ${busy ? "animate-pulse" : ""}`}>
            <Icon name="spark" className="h-5 w-5" />
          </span>
          <span className="hidden text-start leading-tight sm:block">
            <span className="block text-sm font-bold">{t.name}</span>
            <span className="block text-[0.6875rem] text-white/70">{t.hotkey}</span>
          </span>
        </button>
      )}

      {/* Fenster */}
      {open && (
        <section aria-label={t.name} data-agent-panel
          onDragOver={(e) => { if (dragHasFiles(e)) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); } }}
          className="fixed bottom-24 end-3 z-[66] flex max-h-[min(44rem,calc(100dvh-7.5rem))] w-[min(27rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-3xl bg-white shadow-lift ring-1 ring-black/10 animate-rise lg:bottom-6 lg:end-6">
          {dragging && (
            <div className="pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50/95 text-center text-sm font-bold text-brand-700" data-agent-drop>
              <span className="flex flex-col items-center gap-2"><Icon name="clip" className="h-8 w-8" />{t.dropHere}</span>
            </div>
          )}
          <header className="flex items-center gap-3 bg-gradient-to-br from-navy-800 to-navy-900 px-4 py-3 text-white">
            <span className={`relative grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 shadow-card ${busy || listening ? "animate-pulse" : ""}`}>
              <Icon name="spark" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-bold">{t.name}</div>
              <div className="truncate text-xs text-white/70" dir="auto">{statusText}{stepLine ? ` · ${stepLine}` : ""}</div>
            </div>
            <button type="button" onClick={() => { const v = !voiceOn; setVoiceOn(v); if (!v) stopSpeaking(); try { localStorage.setItem(VOICE_KEY, v ? "1" : "0"); } catch { /* egal */ } }}
              title={voiceOn ? t.voiceOn : t.voiceOff} aria-label={voiceOn ? t.voiceOn : t.voiceOff} aria-pressed={voiceOn}
              className="group grid h-9 w-9 place-items-center rounded-full hover:bg-white/10"><Icon name={voiceOn ? "volume" : "volumeOff"} className="h-5 w-5" /></button>
            <button type="button" onClick={() => setOpen(false)} title={t.minimize} aria-label={t.minimize} className="group grid h-9 w-9 place-items-center rounded-full hover:bg-white/10"><Icon name="minus" className="h-5 w-5" /></button>
          </header>

          <div ref={logBox} className="flex-1 space-y-2.5 overflow-y-auto bg-slate-50 px-4 py-3" data-agent-log>
            {log.length === 0 && phase === "idle" && (
              <div className="space-y-2 py-2 text-sm text-ink-soft">
                <p className="font-semibold text-ink">{t.welcome}</p>
                <ul className="space-y-1">{t.examples.map((x) => (
                  <li key={x}><button type="button" onClick={() => submit(x)} className="text-start text-brand-700 hover:underline" dir="auto">„{x}“</button></li>
                ))}</ul>
                <p className="text-xs">{t.hint}</p>
              </div>
            )}
            {log.map((m, i) => (
              <div key={i} className={`flex ${m.who === "user" ? "justify-end" : "justify-start"}`}>
                <div dir="auto" className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${m.who === "user" ? "bg-brand-600 text-white" : m.who === "ai" ? "bg-white text-ink shadow-card ring-1 ring-black/5" : "bg-amber-50 text-amber-900 ring-1 ring-amber-200"}`}>{m.text}</div>
              </div>
            ))}

            {phase === "plan" && plan && (
              <div className="rounded-2xl bg-white p-3 shadow-card ring-1 ring-brand-200" data-agent-plan>
                <div className="mb-2 text-sm font-bold text-ink" dir="auto">{plan.title}</div>
                <ol className="space-y-1.5 text-sm">
                  {plan.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2" dir="auto">
                      <span className="num grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-50 text-[0.6875rem] font-bold text-brand-700">{i + 1}</span>
                      <span className="min-w-0 flex-1">{s.text}{s.commit && <span className="ms-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[0.625rem] font-semibold text-amber-900">{t.commitBadge}</span>}</span>
                    </li>
                  ))}
                </ol>
                {plan.note && <p className="mt-2 text-xs text-ink-soft" dir="auto">{plan.note}</p>}
                <p className="mt-3 text-xs font-semibold text-ink">{t.planQuestion}</p>
                <div className="mt-2 grid gap-2">
                  <button type="button" onClick={() => approve("auto")} className="btn-primary justify-center" data-agent-approve="auto"><Icon name="check" className="h-4 w-4" />{t.runAll}</button>
                  <button type="button" onClick={() => approve("step")} className="btn-ghost justify-center" data-agent-approve="step"><Icon name="list" className="h-4 w-4" />{t.stepByStep}</button>
                  <button type="button" onClick={rejectPlan} className="text-xs font-semibold text-ink-soft hover:text-red-600" data-agent-approve="no">{t.cancel}</button>
                </div>
              </div>
            )}

            {phase === "stepConfirm" && step && (
              <div className="rounded-2xl bg-white p-3 shadow-card ring-1 ring-brand-200" data-agent-step>
                <div className="text-sm font-bold" dir="auto">{t.stepN.replace("{n}", String(step))}: {planRef.current?.steps[step - 1]?.text ?? pendingAct.current?.say}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => confirmStep("go")} className="btn-primary px-4" data-agent-step-go><Icon name="check" className="h-4 w-4" />{t.continue}</button>
                  <button type="button" onClick={() => confirmStep("all")} className="btn-ghost px-4">{t.runRest}</button>
                  <button type="button" onClick={() => confirmStep("stop")} className="btn-danger px-4">{t.stop}</button>
                </div>
              </div>
            )}

            {phase === "commitConfirm" && (
              <div className="rounded-2xl bg-amber-50 p-3 ring-1 ring-amber-300" data-agent-commit>
                <div className="text-sm font-bold text-amber-950" dir="auto">{t.commitAsk.replace("{label}", commitLabel)}</div>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => answerCommit(true)} className="btn-primary px-5" data-agent-panel-yes><Icon name="check" className="h-4 w-4" />{t.yes}</button>
                  <button type="button" onClick={() => answerCommit(false)} className="btn-ghost px-5">{t.no}</button>
                </div>
              </div>
            )}

            {phase === "ask" && ask && ask.choices.length > 0 && (
              <div className="flex flex-wrap gap-2" data-agent-choices>
                {ask.choices.map((c) => <button key={c} type="button" onClick={() => submit(c)} className="rounded-full bg-white px-3 py-1.5 text-sm font-semibold text-brand-700 shadow-card ring-1 ring-brand-200 hover:bg-brand-50" dir="auto">{c}</button>)}
              </div>
            )}
            {busy && (
              <div className="flex items-center gap-2 text-xs text-ink-soft"><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />{statusText}</div>
            )}
          </div>

          <footer className="space-y-2 border-t border-black/5 bg-white p-3">
            {busy ? (
              <button type="button" onClick={stop} className="btn-danger w-full justify-center" data-agent-stop><Icon name="stop" className="h-4 w-4" />{t.stop}</button>
            ) : (
              <>
              {pending.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" data-agent-files>
                  {pending.map((x) => (
                    <li key={x.key} className={`flex max-w-full items-center gap-1.5 rounded-full py-1 pe-1 ps-2.5 text-xs font-semibold ring-1 ${x.status === "error" ? "bg-red-50 text-red-700 ring-red-200" : "bg-slate-50 text-ink ring-black/10"}`} title={x.error ?? x.file.name} data-agent-file={x.status}>
                      {x.status === "uploading" ? <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-200 border-t-brand-600" />
                        : <Icon name={x.status === "error" ? "alert" : /\.(xlsx|xlsm|csv)$/i.test(x.file.name) ? "sheet" : /\.pdf$/i.test(x.file.name) ? "file" : "camera"} className="h-3.5 w-3.5 shrink-0" />}
                      <span className="min-w-0 truncate" dir="auto">{x.status === "error" ? `${x.file.name}: ${x.error}` : x.file.name}</span>
                      <button type="button" onClick={() => setPending((p) => p.filter((y) => y.key !== x.key))} aria-label={t.removeFile} title={t.removeFile} className="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-black/10"><Icon name="x" className="h-3 w-3" /></button>
                    </li>
                  ))}
                </ul>
              )}
              {listening && (
                <div className="flex items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-red-200" data-agent-listening={pausing ? "pause" : "on"} aria-live="polite">
                  <span className="relative flex h-2.5 w-2.5 shrink-0"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" /></span>
                  <span className="min-w-0 flex-1" dir="auto">{pausing ? t.listenPause : t.listenHint}</span>
                  <button type="button" onClick={() => stopListening.current?.finish()} className="btn-primary shrink-0 px-3 py-1.5 text-xs" data-agent-listen-done>
                    <Icon name="check" className="h-3.5 w-3.5" />{t.listenDone}
                  </button>
                </div>
              )}
              <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); submit(input); }}>
                <input ref={fileInput} type="file" multiple hidden accept=".xlsx,.xlsm,.csv,.pdf,image/*" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} data-agent-file-input />
                <button type="button" onClick={() => fileInput.current?.click()} title={t.attach} aria-label={t.attach}
                  className="group grid h-12 w-9 shrink-0 place-items-center rounded-full text-ink-soft transition hover:bg-slate-100 hover:text-brand-700" data-agent-attach>
                  <Icon name="clip" className="h-5 w-5" />
                </button>
                {micOk && (
                  <button type="button" onClick={() => void mic()} title={t.mic} aria-label={t.mic} aria-pressed={listening}
                    className={`group grid h-12 w-12 shrink-0 place-items-center rounded-full text-white shadow-card transition ${listening ? "animate-pulse bg-red-500" : "bg-brand-600 hover:bg-brand-700"}`} data-agent-mic>
                    <Icon name="mic" className="h-5 w-5" />
                  </button>
                )}
                <textarea id="ss-agent-input" value={input} onChange={(e) => setInput(e.target.value)} rows={1} dir="auto" maxLength={2000}
                  onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(input); } if (e.key === "Escape") e.stopPropagation(); }}
                  placeholder={phase === "plan" ? t.planPlaceholder : phase === "ask" || phase === "stepConfirm" || phase === "commitConfirm" ? t.answerPlaceholder : t.placeholder}
                  className="input max-h-28 min-h-[3rem] flex-1 resize-none py-3" data-agent-input />
                <button type="submit" disabled={(!input.trim() && !pending.some((x) => x.status === "ready")) || pending.some((x) => x.status === "uploading")} title={pending.some((x) => x.status === "uploading") ? t.uploading : t.send} aria-label={t.send} className="btn-primary h-12 w-12 shrink-0 justify-center p-0 disabled:opacity-40"><Icon name="send" className="h-5 w-5" /></button>
              </form>
              </>
            )}
            {phase === "error" && canRetry && lastPayload.current && (runId.current || lastPayload.current.kind === "start") && (
              <button type="button" onClick={() => { aborted.current = false; void call(lastPayload.current!); }} className="btn-ghost w-full justify-center" data-agent-retry><Icon name="undo" className="h-4 w-4" />{t.retry}</button>
            )}
            {(phase === "done" || phase === "error") && (
              <button type="button" onClick={() => { resetRun(); setLog([]); setPhase("idle"); }} className="w-full text-center text-xs font-semibold text-brand-700 hover:underline">{t.newTask}</button>
            )}
          </footer>
        </section>
      )}
    </div>,
    document.body,
  );
}
