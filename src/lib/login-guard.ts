/**
 * Schutz der Anmeldung gegen Durchprobieren von Passwörtern – rein und getestet.
 *
 * Idee (OWASP „Device Cookies“): Ein Gerät, auf dem man sich schon einmal erfolgreich angemeldet hat, trägt ein signiertes
 * Geräte-Cookie. Fremde Geräte werden für das Konto nach wenigen Fehlversuchen gesperrt, und zwar stufenweise länger.
 * Bekannte Geräte zählen nur ihre eigenen Fehlversuche – so kann ein Angreifer den Inhaber nicht aussperren.
 * Dazu: Sperre je IP-Adresse und eine Notbremse, wenn sehr viele fremde Versuche auf einmal kommen.
 * Gesperrte Versuche prüfen das Passwort gar nicht erst (spart Rechenzeit, verrät nichts).
 */

export const GUARD = {
  /** fremde Geräte, Fehlversuche je Konto in 24 h (seit der letzten Anmeldung von einem fremden Gerät) */
  account: [
    { fails: 5, lockMin: 15 },
    { fails: 10, lockMin: 60 },
    { fails: 20, lockMin: 6 * 60 },
  ],
  /** bekanntes Gerät: eigene Fehlversuche in 15 min (seit seiner letzten Anmeldung) */
  device: { fails: 10, windowMin: 15, lockMin: 15 },
  /** je IP-Adresse (fremde Geräte, auch unbekannte E-Mails) in 60 min */
  ip: { fails: 20, windowMin: 60, lockMin: 60 },
  /** Notbremse: alle fremden Fehlversuche zusammen in 10 min */
  global: { fails: 100, windowMin: 10, lockMin: 10 },
  /** Codes je Anmeldung (danach Passwort neu eingeben) */
  codesPerLogin: 5,
} as const;

/** Zahl der Fehlversuche im Fenster und Zeitpunkt des letzten */
export type FailCount = { n: number; last: Date | null };
export type GuardInput = {
  now: Date;
  trusted: boolean;
  account: FailCount;
  device: FailCount;
  ip: FailCount;
  global: FailCount;
};
export type Block = { until: Date; scope: "account" | "device" | "ip" | "global" };

const plus = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

export function loginBlock(i: GuardInput): Block | null {
  const blocks: Block[] = [];
  const add = (scope: Block["scope"], c: FailCount, fails: number, lockMin: number) => {
    if (c.n >= fails && c.last) blocks.push({ scope, until: plus(c.last, lockMin) });
  };
  if (i.trusted) {
    add("device", i.device, GUARD.device.fails, GUARD.device.lockMin);
  } else {
    const tier = [...GUARD.account].reverse().find((t) => i.account.n >= t.fails);
    if (tier) add("account", i.account, tier.fails, tier.lockMin);
    add("ip", i.ip, GUARD.ip.fails, GUARD.ip.lockMin);
    add("global", i.global, GUARD.global.fails, GUARD.global.lockMin);
  }
  const active = blocks.filter((b) => b.until > i.now).sort((a, b) => b.until.getTime() - a.until.getTime());
  return active[0] ?? null;
}

/** Minuten bis zum Ende der Sperre, aufgerundet (mindestens 1) */
export const minutesLeft = (b: Block, now: Date) => Math.max(1, Math.ceil((b.until.getTime() - now.getTime()) / 60_000));

/** IP-Adresse des Besuchers: hinter Cloudflare/Render steht sie in den Weiterleitungs-Kopfzeilen */
export function clientIp(h: { get(name: string): string | null }): string {
  const cf = h.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim().slice(0, 64);
  return (h.get("x-real-ip") ?? "").trim().slice(0, 64);
}

/** Kurze Gerätebeschreibung aus dem User-Agent, z. B. „iPhone · Safari“ */
export function deviceLabel(ua: string): string {
  if (!ua) return "";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari"
    : /curl|python|wget|Go-http|node-fetch|axios|okhttp|java/i.test(ua) ? "Script/Bot" : "";
  return [os, browser].filter(Boolean).join(" · ") || ua.slice(0, 40);
}
