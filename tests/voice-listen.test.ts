import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinSpeech, listen, listenDone, LISTEN, transcriptOf } from "../src/components/agent/voice";

// Zuhören bis der Nutzer fertig ist (Wunsch Inhaber 17.11.2026: „يفضل سامعني للآخر، ما ياخدش كلمة ويروح قطع الكلام“)
describe("Zuhören – Regeln (rein)", () => {
  it("fertig erst nach 3 s Ruhe seit dem letzten Wort, ohne Wort nach 10 s, spätestens nach 90 s", () => {
    expect(listenDone({ startedAt: 0, lastHeardAt: 1000, now: 3900 })).toBe(false); // 2,9 s Pause: weiter zuhören
    expect(listenDone({ startedAt: 0, lastHeardAt: 1000, now: 4000 })).toBe(true);
    expect(listenDone({ startedAt: 0, lastHeardAt: null, now: 9000 })).toBe(false);
    expect(listenDone({ startedAt: 0, lastHeardAt: null, now: 10_000 })).toBe(true);
    expect(listenDone({ startedAt: 0, lastHeardAt: 89_999, now: 90_000 })).toBe(true);
    expect(listenDone({ startedAt: 0, lastHeardAt: 1000, now: 2900 }, { ...LISTEN, silenceMs: 1800 })).toBe(true); // Freigabe-Antworten
  });
  it("Text aus endgültigen und vorläufigen Ergebnissen", () => {
    const r = [{ isFinal: true, 0: { transcript: "اعمل زبون جديد" } }, { isFinal: false, 0: { transcript: " اسمه" } }];
    expect(transcriptOf(r)).toEqual({ final: "اعمل زبون جديد", interim: "اسمه" });
    expect(joinSpeech(" a ", "", "b")).toBe("a b");
  });
});

type Res = { isFinal: boolean; 0: { transcript: string } };
class FakeRec {
  static all: FakeRec[] = [];
  lang = ""; interimResults = false; continuous = false; maxAlternatives = 1;
  onresult: ((e: { resultIndex: number; results: Res[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  results: Res[] = []; stopped = false; aborted = false;
  constructor() { FakeRec.all.push(this); }
  start() { /* läuft */ }
  stop() { this.stopped = true; setTimeout(() => this.onend?.(), 10); }
  abort() { this.aborted = true; setTimeout(() => this.onend?.(), 10); }
  /** wie Chrome: vorläufiges Ergebnis wird ersetzt, endgültiges bleibt */
  say(text: string, final = true) {
    const last = this.results[this.results.length - 1];
    const r = { isFinal: final, 0: { transcript: text } };
    if (last && !last.isFinal) this.results[this.results.length - 1] = r; else this.results.push(r);
    this.onresult?.({ resultIndex: this.results.length - 1, results: [...this.results] });
  }
}

describe("Zuhören – Ablauf mit simulierter Spracherkennung", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    FakeRec.all = [];
    g.window = globalThis;
    g.webkitSpeechRecognition = FakeRec;
  });
  afterEach(() => { vi.useRealTimers(); delete g.webkitSpeechRecognition; delete g.window; });
  const handlers = () => {
    const out = { done: [] as [string, boolean][], partial: [] as string[], errors: [] as string[], pause: [] as boolean[] };
    return { out, h: { done: (t: string, c: boolean) => out.done.push([t, c]), partial: (t: string) => out.partial.push(t), error: (c: string) => out.errors.push(c), pause: (q: boolean) => out.pause.push(q) } };
  };

  it("bleibt über eine Denkpause von 2 s dran und schickt alles nach 3 s Ruhe", () => {
    const { out, h } = handlers();
    listen("ar-SY", h);
    const r = FakeRec.all[0];
    expect(r.continuous).toBe(true);
    vi.advanceTimersByTime(500); r.say("اعمل زبون", false);
    vi.advanceTimersByTime(300); r.say("اعمل زبون جديد");
    vi.advanceTimersByTime(2000);
    expect(out.done).toEqual([]);
    expect(out.pause).toEqual([true]); // Hinweis „schicke gleich ab“
    r.say("اسمه سامر");
    expect(out.pause).toEqual([true, false]);
    expect(out.partial.at(-1)).toBe("اعمل زبون جديد اسمه سامر");
    vi.advanceTimersByTime(2800);
    expect(out.done).toEqual([]);
    vi.advanceTimersByTime(400); // > 3 s still → fertig
    expect(r.stopped).toBe(true);
    vi.advanceTimersByTime(20);
    expect(out.done).toEqual([["اعمل زبون جديد اسمه سامر", false]]);
  });

  it("beendet der Browser von selbst, wird neu gestartet und der Text bleibt", () => {
    const { out, h } = handlers();
    listen("ar-SY", h);
    FakeRec.all[0].say("أول جملة");
    vi.advanceTimersByTime(500);
    FakeRec.all[0].onend?.(); // z. B. Android nach jeder Pause, oder Zeitgrenze des Browsers
    expect(FakeRec.all).toHaveLength(2);
    vi.advanceTimersByTime(500);
    FakeRec.all[1].say("وتاني جملة");
    vi.advanceTimersByTime(3300);
    expect(out.done).toEqual([["أول جملة وتاني جملة", false]]);
  });

  it("nichts gehört → nach 10 s leer fertig (Hinweis), „Fertig“ schickt sofort, Abbrechen schickt nichts", () => {
    const a = handlers();
    listen("ar-SY", a.h);
    vi.advanceTimersByTime(9800);
    expect(a.out.done).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(a.out.done).toEqual([["", false]]);

    const b = handlers();
    const ctrl = listen("de-DE", b.h);
    FakeRec.all.at(-1)!.say("Neuer Kunde Müller", false);
    ctrl.finish();
    vi.advanceTimersByTime(20);
    expect(b.out.done).toEqual([["Neuer Kunde Müller", false]]);

    const c = handlers();
    const ctrl2 = listen("de-DE", c.h);
    FakeRec.all.at(-1)!.say("doch nicht");
    ctrl2.cancel();
    vi.advanceTimersByTime(20);
    expect(FakeRec.all.at(-1)!.aborted).toBe(true);
    expect(c.out.done).toEqual([["", true]]);
  });

  it("Mikrofon verboten → Fehler, kein Neustart", () => {
    const { out, h } = handlers();
    listen("ar-SY", h);
    FakeRec.all[0].onerror?.({ error: "not-allowed" });
    FakeRec.all[0].onend?.();
    vi.advanceTimersByTime(15_000);
    expect(out.errors).toEqual(["not-allowed"]);
    expect(out.done).toEqual([]);
    expect(FakeRec.all).toHaveLength(1);
  });
});
