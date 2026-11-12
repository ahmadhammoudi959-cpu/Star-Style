import { describe, expect, it } from "vitest";
import { UNDO_LIVE_DAYS, undoLiveState, undoLiveUntil } from "../src/lib/test-reset-sql";

// „Echtbetrieb starten“ aus Versehen gedrückt (Inhaber 12.11.2026) → in den ersten 7 Tagen zurück in den Testbetrieb
describe("Echtbetrieb zurücknehmen (rein)", () => {
  const since = new Date("2026-11-12T17:30:00Z");
  const after = (days: number) => new Date(since.getTime() + days * 86_400_000);
  it("geht in den ersten 7 Tagen, danach nicht mehr", () => {
    expect(undoLiveState(since, after(0), false)).toBe("ok");
    expect(undoLiveState(since, after(UNDO_LIVE_DAYS), false)).toBe("ok");
    expect(undoLiveState(since, new Date(after(UNDO_LIVE_DAYS).getTime() + 1000), false)).toBe("tooLate");
    expect(undoLiveUntil(since).toISOString()).toBe("2026-11-19T17:30:00.000Z");
  });
  it("nie mit abgeschlossenem Monat", () => {
    expect(undoLiveState(since, after(1), true)).toBe("locked");
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Echtbetrieb zurücknehmen (Datenbank)", () => {
  it("setzt nur live_since zurück, mit Protokoll; zu spät / Monat abgeschlossen → gesperrt", async () => {
    const { db, schema } = await import("../src/db");
    const { eq, sql } = await import("drizzle-orm");
    const { undoLive, undoLiveInfo, ResetError } = await import("../src/lib/test-reset");
    await db.insert(schema.companySettings).values({ id: "company", name: "Star Style" }).onConflictDoNothing();
    const before = (await db.query.companySettings.findFirst())!.liveSince;
    const setLive = (d: Date | null) => db.update(schema.companySettings).set({ liveSince: d }).where(eq(schema.companySettings.id, "company"));
    const month = "1999-0" + (1 + Math.floor(Math.random() * 9)); // eigener Monat, stört keine anderen Tests
    try {
      // seit gestern live → geht
      await setLive(new Date(Date.now() - 86_400_000));
      expect((await undoLiveInfo())?.state).toBe("ok");
      await undoLive("test");
      expect((await db.query.companySettings.findFirst())!.liveSince).toBeNull();
      const log = await db.query.auditLog.findMany({ where: eq(schema.auditLog.action, "undo-go-live") });
      expect(log.length).toBeGreaterThan(0);
      await expect(undoLive("test")).rejects.toMatchObject({ code: "undoNotLive" });
      // seit 8 Tagen live → zu spät
      await setLive(new Date(Date.now() - 8 * 86_400_000));
      await expect(undoLive("test")).rejects.toBeInstanceOf(ResetError);
      await expect(undoLive("test")).rejects.toMatchObject({ code: "undoTooLate" });
      // Monat abgeschlossen → gesperrt
      await setLive(new Date());
      await db.insert(schema.periodLocks).values({ month }).onConflictDoNothing();
      await expect(undoLive("test")).rejects.toMatchObject({ code: "undoLocked" });
      expect((await db.query.companySettings.findFirst())!.liveSince).not.toBeNull();
    } finally {
      await db.execute(sql`delete from period_locks where month = ${month}`);
      await setLive(before ?? null);
    }
  });
});
