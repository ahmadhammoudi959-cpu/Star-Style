import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Anmeldeschutz mit echter Datenbank: Zählen der Fehlversuche, Sperren, Zwei-Schritt-Codes nur einmal
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Anmeldung: Sperre und Zwei-Schritt (Datenbank)", async () => {
  const { db, schema } = await import("../src/db");
  const { sql, eq } = await import("drizzle-orm");
  const login = await import("../src/lib/login");
  const { encrypt } = await import("../src/lib/crypto");
  const { base32Decode, hotp, totpStep, hashRecovery } = await import("../src/lib/totp");
  const tag = `guardtest-${Date.now()}`;
  const ip = (n: number) => `${tag}-ip${n}`;
  const ctx = (n: number) => ({ ip: ip(n), ua: "vitest" });
  let userId = "";

  const clean = async () => {
    await db.execute(sql`delete from login_attempts where ip like ${tag + "%"} or email like ${tag + "%"}`);
    await db.execute(sql`delete from users where email like ${tag + "%"}`);
  };
  beforeAll(async () => {
    await clean();
    const [u] = await db.insert(schema.users).values({ name: "Guard Test", email: `${tag}@example.com`, passwordHash: "x" }).returning();
    userId = u.id;
  });
  afterAll(clean);

  const fail = (n: number, device = "", reason = "invalid") =>
    login.recordAttempt({ userId, email: `${tag}@example.com`, ctx: ctx(n), device, step: "password", ok: false, reason });

  it("fremdes Gerät: nach 5 falschen Passwörtern gesperrt, bekanntes Gerät nicht; Erfolg setzt zurück", async () => {
    for (let i = 0; i < 4; i++) await fail(1);
    expect(await login.checkBlock({ email: `${tag}@example.com`, device: "", ip: ip(1) })).toBeNull();
    await fail(2); // andere IP – zählt fürs Konto trotzdem
    const b = await login.checkBlock({ email: `${tag}@example.com`, device: "", ip: ip(3) });
    expect(b?.scope).toBe("account");
    expect(b!.until.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // bekanntes Gerät des Inhabers: nicht ausgesperrt
    expect(await login.checkBlock({ email: `${tag}@example.com`, device: `${tag}-dev`, ip: ip(1) })).toBeNull();
    // gesperrte Versuche zählen nicht als Fehlversuch und werden höchstens einmal pro Minute aufgeschrieben
    await fail(1, "", "locked");
    await fail(1, "", "locked");
    const locked = await db.execute<{ n: number }>(sql`select count(*)::int as n from login_attempts where ip = ${ip(1)} and reason = 'locked'`);
    expect(locked.rows[0].n).toBe(1);
    // erfolgreiche Anmeldung von einem fremden Gerät → Zähler für fremde Geräte beginnt neu
    await login.recordAttempt({ userId, email: `${tag}@example.com`, ctx: ctx(1), device: "", step: "password", ok: true, reason: "success" });
    expect(await login.checkBlock({ email: `${tag}@example.com`, device: "", ip: ip(3) })).toBeNull();
  });

  it("bekanntes Gerät: eigene Fehlversuche (10 in 15 min) sperren nur dieses Gerät", async () => {
    const dev = `${tag}-dev2`;
    for (let i = 0; i < 10; i++) await fail(4, dev);
    expect((await login.checkBlock({ email: `${tag}@example.com`, device: dev, ip: ip(4) }))?.scope).toBe("device");
    expect(await login.checkBlock({ email: `${tag}@example.com`, device: `${tag}-dev3`, ip: ip(4) })).toBeNull();
  });

  it("unbekannte E-Mail wird genauso gesperrt (man erkennt nicht, welche E-Mails es gibt)", async () => {
    for (let i = 0; i < 5; i++) {
      await login.recordAttempt({ userId: null, email: `${tag}-ghost@example.com`, ctx: ctx(8 + i), step: "password", ok: false, reason: "invalid" });
    }
    expect((await login.checkBlock({ email: `${tag}-ghost@example.com`, device: "", ip: ip(20) }))?.scope).toBe("account");
  });

  it("IP-Adresse: 20 Fehlversuche (auch mit unbekannten E-Mails) → gesperrt", async () => {
    for (let i = 0; i < 20; i++) {
      await login.recordAttempt({ userId: null, email: `${tag}-x${i}@example.com`, ctx: ctx(5), step: "password", ok: false, reason: "invalid" });
    }
    expect((await login.checkBlock({ email: `${tag}-new@example.com`, device: "", ip: ip(5) }))?.scope).toBe("ip");
    expect(await login.checkBlock({ email: `${tag}-new@example.com`, device: "", ip: ip(6) })).toBeNull();
  });

  it("Codes: richtiger Code einmal, derselbe nicht noch einmal; Ersatz-Code genau einmal", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const pepper = login.recoveryPepper();
    await db.update(schema.users).set({ totpSecret: encrypt(secret), totpEnabledAt: new Date(), totpLastStep: null,
      recoveryCodes: [hashRecovery("ab3cd-ef4gh", pepper)] }).where(eq(schema.users.id, userId));
    const get = async () => (await db.query.users.findFirst({ where: eq(schema.users.id, userId) }))!;
    const code = hotp(base32Decode(secret), totpStep(Date.now()));
    expect(await login.checkSecondFactor(await get(), "000000" === code ? "111111" : "000000")).toBeNull();
    expect(await login.checkSecondFactor(await get(), code)).toBe("code");
    expect(await login.checkSecondFactor(await get(), code)).toBeNull(); // schon benutzt
    expect(await login.checkSecondFactor(await get(), "AB3CD EF4GH", false)).toBeNull(); // Ersatz-Code hier nicht erlaubt
    expect(await login.checkSecondFactor(await get(), "AB3CD EF4GH")).toBe("recovery");
    expect(await login.checkSecondFactor(await get(), "ab3cd-ef4gh")).toBeNull(); // nur einmal
    expect((await get()).recoveryCodes).toEqual([]);
  });

  it("falsche Codes je Anmeldung zählen", async () => {
    const iat = Math.floor(Date.now() / 1000) - 1;
    expect(await login.codesExhausted(userId, iat)).toBe(false);
    for (let i = 0; i < 5; i++) {
      await login.recordAttempt({ userId, email: `${tag}@example.com`, ctx: ctx(7), device: `${tag}-dev4`, step: "code", ok: false, reason: "code" });
    }
    expect(await login.codesExhausted(userId, iat)).toBe(true);
  });

  it("Datenbank-Verbindung intern? (nur ja/nein)", () => {
    const old = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://u:p@dpg-abc123-a/starstyle";
    expect(login.dbConnectionInternal()).toBe(true);
    process.env.DATABASE_URL = "postgresql://u:p@dpg-abc123-a.frankfurt-postgres.render.com/starstyle";
    expect(login.dbConnectionInternal()).toBe(false);
    process.env.DATABASE_URL = old;
  });
});
