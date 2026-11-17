"use client";
/**
 * Stimme für den Assistenten: Spracherkennung (Chrome/Edge, Web Speech API – der Browser schickt den Ton an seinen
 * eigenen Dienst, nicht an unseren Server) und Vorlesen (speechSynthesis). Mikrofon nur nach Knopfdruck/F2, nie dauernd.
 */
type Rec = {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type RecCtor = new () => Rec;

const ctor = (): RecCtor | null => {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
export const canListen = () => !!ctor();
export const canSpeak = () => typeof window !== "undefined" && "speechSynthesis" in window;

/**
 * Zuhören, bis der Nutzer fertig ist (Wunsch Inhaber 17.11.2026: „يفضل سامعني للآخر، ما ياخدش كلمة ويروح قطع الكلام … زود
 * مدة السماع“): durchgehend (`continuous`), fertig erst nach `silenceMs` Ruhe seit dem letzten gehörten Wort, ohne ein Wort nach
 * `firstWordMs`, spätestens nach `maxMs` – oder sofort mit „Fertig“/F2. Beendet der Browser die Erkennung von selbst (Pause bei
 * Android, Zeitgrenze, „no-speech“), startet sie neu und der Text bleibt. Mikrofon trotzdem nur nach Knopfdruck, nie dauernd.
 */
export const LISTEN = { silenceMs: 3000, firstWordMs: 10_000, maxMs: 90_000, pauseHintMs: 1200 };
export type ListenOptions = typeof LISTEN;

type Results = ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
/** Text aus allen Ergebnissen einer Sitzung: endgültige + noch vorläufige */
export const joinSpeech = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" ");
export function transcriptOf(results: Results) {
  // je Satz ein Ergebnis; nicht jeder Browser setzt das Leerzeichen davor → selbst mit Leerzeichen verbinden
  const final: string[] = [], interim: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    (r.isFinal ? final : interim).push(r[0].transcript);
  }
  return { final: joinSpeech(...final), interim: joinSpeech(...interim) };
}

/** Ist der Nutzer fertig? (rein, getestet) */
export function listenDone(s: { startedAt: number; lastHeardAt: number | null; now: number }, o: ListenOptions = LISTEN): boolean {
  if (s.now - s.startedAt >= o.maxMs) return true;
  if (s.lastHeardAt == null) return s.now - s.startedAt >= o.firstWordMs;
  return s.now - s.lastHeardAt >= o.silenceMs;
}

export type ListenCtrl = { finish: () => void; cancel: () => void };
export type ListenHandlers = {
  partial: (t: string) => void;
  /** fertig: gehörter Text (leer = nichts gehört); cancelled = abgebrochen (nichts abschicken) */
  done: (t: string, cancelled: boolean) => void;
  error: (code: string) => void;
  /** kurz still nach dem Sprechen (Hinweis „schicke gleich ab“) */
  pause?: (quiet: boolean) => void;
};

export function listen(lang: string, h: ListenHandlers, o: ListenOptions = LISTEN): ListenCtrl {
  const C = ctor();
  if (!C) { h.error("unsupported"); return { finish() {}, cancel() {} }; }
  // Chrome auf Android wiederholt im Dauerbetrieb die Ergebnisse → dort je Satz eine Sitzung und neu starten
  const android = /Android/i.test(navigator.userAgent);
  const startedAt = Date.now();
  let committed = "", current = { final: "", interim: "" }, lastHeardAt: number | null = null;
  let want: "listen" | "finish" | "cancel" = "listen";
  let rec: Rec | null = null, ended = false, quiet = false, restarts = 0;
  const text = () => joinSpeech(committed, current.final, current.interim);
  const end = () => {
    if (ended) return;
    ended = true;
    window.clearInterval(tick);
    if (quiet) h.pause?.(false);
    h.done(want === "cancel" ? "" : text(), want === "cancel");
  };
  const stopNow = (how: "finish" | "cancel") => {
    if (ended) return;
    want = how;
    if (!rec) return end();
    try { if (how === "cancel") rec.abort(); else rec.stop(); } catch { end(); }
    window.setTimeout(end, 1500); // falls der Browser kein „Ende“ mehr meldet
  };
  const startOne = () => {
    const r = new C();
    rec = r;
    r.lang = lang; r.interimResults = true; r.continuous = !android; r.maxAlternatives = 1;
    r.onresult = (e) => {
      current = transcriptOf(e.results);
      lastHeardAt = Date.now();
      if (quiet) { quiet = false; h.pause?.(false); }
      h.partial(text());
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return; // Ruhe → „Ende“ entscheidet: neu starten oder fertig
      if (e.error === "network" && restarts < 3) return; // kurz weg → „Ende“ startet neu
      want = "cancel";
      ended = true;
      window.clearInterval(tick);
      h.error(e.error);
    };
    r.onend = () => {
      // Sitzung vorbei: Gehörtes behalten (auch Vorläufiges, falls der Browser es nicht mehr abgeschlossen hat)
      committed = text();
      current = { final: "", interim: "" };
      rec = null;
      if (ended) return;
      if (want !== "listen" || listenDone({ startedAt, lastHeardAt, now: Date.now() }, o) || restarts >= 30) return end();
      restarts++;
      try { startOne(); } catch { end(); }
    };
    r.start();
  };
  const tick = window.setInterval(() => {
    if (ended || want !== "listen") return;
    const now = Date.now();
    if (listenDone({ startedAt, lastHeardAt, now }, o)) return stopNow("finish");
    const q = lastHeardAt != null && now - lastHeardAt >= o.pauseHintMs;
    if (q !== quiet) { quiet = q; h.pause?.(q); }
  }, 200);
  try { startOne(); } catch { ended = true; window.clearInterval(tick); h.error("start"); }
  return { finish: () => stopNow("finish"), cancel: () => stopNow("cancel") };
}

/**
 * Stimme wählen: Arabisch syrisch/levantinisch zuerst (Wunsch Inhaber 17.11.2026: „يتكلم باللهجة السورية الصح“ – eine
 * ägyptische oder Hocharabisch-Stimme spricht den Dialekt falsch aus), natürliche Stimmen (Edge „… Online (Natural)“) vor einfachen.
 */
const PREFER: Record<string, string[]> = { ar: ["ar-sy", "ar-lb", "ar-jo", "ar-ps", "ar-iq"], de: ["de-de", "de-at"], en: ["en-us", "en-gb"] };
export function pickVoice<V extends { lang: string; name: string }>(voices: readonly V[], lang: string): V | undefined {
  const base = lang.slice(0, 2).toLowerCase();
  const pref = PREFER[base] ?? [];
  const score = (v: V) => {
    const l = v.lang.replace("_", "-").toLowerCase();
    if (!l.startsWith(base)) return -1;
    const i = pref.indexOf(l);
    return 1 + (i >= 0 ? 50 - i * 5 : 0) + (/natural|online|neural|premium|enhanced/i.test(v.name) ? 20 : 0);
  };
  let best: V | undefined, top = -1;
  for (const v of voices) { const s = score(v); if (s > top) { top = s; best = v; } }
  return top >= 0 ? best : undefined;
}

/** Vorlesen in der Sprache der Oberfläche; ohne passende Stimme still (der Text steht ja da) */
export function speak(text: string, lang: string): Promise<void> {
  return new Promise((resolve) => {
    if (!canSpeak() || !text.trim()) return resolve();
    const synth = window.speechSynthesis;
    const pick = () => pickVoice(synth.getVoices(), lang);
    const go = () => {
      const voice = pick();
      if (!voice) return resolve();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text.slice(0, 400));
      u.voice = voice; u.lang = voice.lang; u.rate = 1.05;
      u.onend = () => resolve(); u.onerror = () => resolve();
      synth.speak(u);
      window.setTimeout(resolve, 12_000); // nie hängen bleiben
    };
    let started = false;
    const once = () => { if (started) return; started = true; synth.onvoiceschanged = null; go(); };
    if (synth.getVoices().length) once();
    else { synth.onvoiceschanged = once; window.setTimeout(once, 800); }
  });
}
export function stopSpeaking() { if (canSpeak()) window.speechSynthesis.cancel(); }
