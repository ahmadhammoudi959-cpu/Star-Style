import { describe, expect, it } from "vitest";
import { clientIp, deviceLabel, loginBlock, minutesLeft, type GuardInput } from "../src/lib/login-guard";

const now = new Date("2026-11-04T10:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const none = { n: 0, last: null };
const base = (o: Partial<GuardInput>): GuardInput => ({ now, trusted: false, account: none, device: none, ip: none, global: none, ...o });

describe("Sperre nach Fehlversuchen", () => {
  it("fremdes Gerät: ab 5 Fehlversuchen 15 min, ab 10 eine Stunde, ab 20 sechs Stunden", () => {
    expect(loginBlock(base({ account: { n: 4, last: ago(1) } }))).toBeNull();
    const b5 = loginBlock(base({ account: { n: 5, last: ago(1) } }));
    expect(b5?.scope).toBe("account");
    expect(b5?.until).toEqual(new Date(ago(1).getTime() + 15 * 60_000));
    expect(minutesLeft(b5!, now)).toBe(14);
    expect(loginBlock(base({ account: { n: 5, last: ago(16) } }))).toBeNull(); // abgelaufen
    expect(loginBlock(base({ account: { n: 10, last: ago(30) } }))?.until).toEqual(new Date(ago(30).getTime() + 60 * 60_000));
    expect(loginBlock(base({ account: { n: 20, last: ago(120) } }))?.until).toEqual(new Date(ago(120).getTime() + 360 * 60_000));
  });

  it("bekanntes Gerät: Angriffe von außen sperren den Inhaber nicht aus – nur eigene Fehlversuche zählen", () => {
    const attacked = { account: { n: 50, last: ago(1) }, ip: { n: 80, last: ago(1) }, global: { n: 500, last: ago(1) } };
    expect(loginBlock(base({ ...attacked }))?.scope).toBeDefined();
    expect(loginBlock(base({ ...attacked, trusted: true }))).toBeNull();
    expect(loginBlock(base({ trusted: true, device: { n: 9, last: ago(1) } }))).toBeNull();
    expect(loginBlock(base({ trusted: true, device: { n: 10, last: ago(1) } }))?.scope).toBe("device");
  });

  it("IP-Adresse und Notbremse; die längste Sperre gewinnt", () => {
    expect(loginBlock(base({ ip: { n: 19, last: ago(1) } }))).toBeNull();
    expect(loginBlock(base({ ip: { n: 20, last: ago(1) } }))?.scope).toBe("ip");
    expect(loginBlock(base({ global: { n: 100, last: ago(1) } }))?.scope).toBe("global");
    expect(loginBlock(base({ global: { n: 100, last: ago(11) } }))).toBeNull();
    const b = loginBlock(base({ account: { n: 5, last: ago(1) }, ip: { n: 20, last: ago(1) } }));
    expect(b?.scope).toBe("ip"); // 60 min > 15 min
    expect(minutesLeft(b!, now)).toBe(59);
  });

  it("IP-Adresse hinter Cloudflare/Render, Gerät aus dem User-Agent", () => {
    const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
    expect(clientIp(h({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.1.1.1" }))).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }))).toBe("198.51.100.4");
    expect(clientIp(h({ "x-real-ip": "192.0.2.9" }))).toBe("192.0.2.9");
    expect(clientIp(h({}))).toBe("");
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("iPhone · Safari");
    expect(deviceLabel("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")).toBe("Android · Chrome");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("Windows · Edge");
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("Mac · Safari");
    expect(deviceLabel("curl/8.5.0")).toBe("Script/Bot");
    expect(deviceLabel("")).toBe("");
  });
});
