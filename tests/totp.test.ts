import { describe, expect, it } from "vitest";
import {
  base32Decode, base32Encode, hashRecovery, hotp, looksLikeRecovery, newRecoveryCodes, newTotpSecret, normalizeRecovery,
  otpauthUri, totpCode, totpStep, verifyTotp, groupSecret,
} from "../src/lib/totp";

// RFC 6238, Anhang B (SHA-1): Schlüssel "12345678901234567890"
const RFC_KEY = Buffer.from("12345678901234567890");
const RFC_SECRET = base32Encode(RFC_KEY);

describe("Zwei-Schritt-Anmeldung (TOTP)", () => {
  it("Base32 wie im Standard, hin und zurück, Klein-/Leerzeichen egal", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).equals(RFC_KEY)).toBe(true);
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").equals(RFC_KEY)).toBe(true);
    for (let i = 0; i < 50; i++) {
      const s = newTotpSecret();
      expect(s).toMatch(/^[A-Z2-7]{32}$/);
      expect(base32Encode(base32Decode(s))).toBe(s);
    }
    expect(() => base32Decode("ABC1")).toThrow();
  });

  it("Testwerte aus RFC 6238 (8 Ziffern) und 6-stellige Codes", () => {
    const cases: [number, string][] = [
      [59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
      [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"],
    ];
    for (const [sec, code] of cases) expect(hotp(RFC_KEY, totpStep(sec * 1000), 8)).toBe(code);
    expect(totpCode(RFC_SECRET, 59_000)).toBe("287082");
    expect(totpCode(RFC_SECRET, 1111111109_000)).toBe("081804");
  });

  it("Code prüfen: ±30 s erlaubt, älter/neuer nicht, derselbe Code kein zweites Mal", () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    const at = (s: number) => hotp(RFC_KEY, s);
    expect(verifyTotp(RFC_SECRET, at(step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, at(step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, at(step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, at(step - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(step + 2), now, null)).toBeNull();
    // schon benutzt → nicht noch einmal (auch nicht der vorige)
    expect(verifyTotp(RFC_SECRET, at(step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(step - 1), now, step - 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(step + 1), now, step)).toBe(step + 1);
    // Leerzeichen in der Mitte ok, sonst nur 6 Ziffern
    const c = at(step);
    expect(verifyTotp(RFC_SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, "12345", now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", now, null)).toBeNull();
  });

  it("Link für die Authenticator-App und Schlüssel zum Abtippen", () => {
    const u = otpauthUri("JBSWY3DPEHPK3PXP", "chef@example.com");
    expect(u).toBe("otpauth://totp/Star%20Style%3Achef%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Star%20Style&algorithm=SHA1&digits=6&period=30");
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });

  it("Ersatz-Codes: 10 verschiedene, gut lesbar, nur als HMAC gespeichert", () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[2-9a-z]{5}-[2-9a-z]{5}$/);
      expect(c).not.toMatch(/[01ilo]/);
      expect(looksLikeRecovery(c)).toBe(true);
    }
    expect(normalizeRecovery(" AB3CD-EF4GH ")).toBe("ab3cdef4gh");
    expect(looksLikeRecovery("123456")).toBe(false);
    const h = hashRecovery("ab3cd-ef4gh", "pepper");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecovery("AB3CD EF4GH", "pepper")).toBe(h);
    expect(hashRecovery("ab3cd-ef4gh", "other")).not.toBe(h);
  });
});
