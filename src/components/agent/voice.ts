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

/** Einmal zuhören (bis zur Sprechpause). Gibt eine Stopp-Funktion zurück. */
export function listen(lang: string, h: { partial: (t: string) => void; done: (t: string) => void; error: (code: string) => void }): () => void {
  const C = ctor();
  if (!C) { h.error("unsupported"); return () => {}; }
  const r = new C();
  r.lang = lang; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
  let finalText = "", ended = false;
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
    }
    h.partial((finalText + " " + interim).trim());
  };
  r.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") h.error(e.error); };
  r.onend = () => { if (!ended) { ended = true; h.done(finalText.trim()); } };
  try { r.start(); } catch { h.error("start"); }
  return () => { try { r.stop(); } catch { /* schon aus */ } };
}

/** Vorlesen in der Sprache der Oberfläche; ohne passende Stimme still (der Text steht ja da) */
export function speak(text: string, lang: string): Promise<void> {
  return new Promise((resolve) => {
    if (!canSpeak() || !text.trim()) return resolve();
    const synth = window.speechSynthesis;
    const pick = () => synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
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
