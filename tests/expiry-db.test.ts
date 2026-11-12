/**
 * MHD auf der Startseite und in der Lagerliste (Wunsch Inhaber 12.11.2026: „läuft bald ab“ und „abgelaufen“ getrennt).
 * Integrationstest gegen PostgreSQL (DATABASE_URL). Fester Stichtag, damit das Ergebnis nicht vom Kalender abhängt.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "../src/db";
import { addDaysIso } from "../src/lib/dates";
import { bookWriteOff, receiveGoods } from "../src/lib/stock";
import { alerts, dashboardStats, stockRows, type StockRow } from "../src/lib/queries";

const run = process.env.DATABASE_URL ? describe : describe.skip;
const today = "2026-11-12";

run("MHD: Startseite und Lagerliste", () => {
  let variantId = "";
  let before: Awaited<ReturnType<typeof dashboardStats>>;
  const mine = (rows: StockRow[]) => rows.find((r) => r.id === variantId);

  beforeAll(async () => {
    before = await dashboardStats(today);
    const sku = "MHD-" + crypto.randomUUID().slice(0, 8);
    const [p] = await db.insert(schema.products).values({ sku, nameDe: "MHD-Testartikel", tracksExpiry: true }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id }).returning();
    variantId = v.id;
    await receiveGoods({ date: "2026-10-01", lines: [
      { variantId, qty: 5, unitCostCents: 100, batchNo: "A", expiryDate: addDaysIso(today, -1) }, // gestern → abgelaufen
      { variantId, qty: 7, unitCostCents: 100, batchNo: "B", expiryDate: today },                 // heute → läuft bald ab
      { variantId, qty: 3, unitCostCents: 100, batchNo: "C", expiryDate: addDaysIso(today, 60) }, // letzter „bald“-Tag
      { variantId, qty: 20, unitCostCents: 100, batchNo: "D", expiryDate: addDaysIso(today, 61) }, // noch lange gut
    ] });
  });

  it("Startseite zählt abgelaufen und bald getrennt (Größen/Farben und Stück)", async () => {
    const s = await dashboardStats(today);
    expect(s.expired - before.expired).toBe(1);
    expect(s.expiredQty - before.expiredQty).toBe(5);
    expect(s.expiring - before.expiring).toBe(1);
    expect(s.expiringQty - before.expiringQty).toBe(10);
  });

  it("Lagerliste mit Filter zeigt genau so viele Artikel wie die Zahl auf der Startseite", async () => {
    const s = await dashboardStats(today);
    const [ex, so, all] = await Promise.all([stockRows({ expiry: "expired", today }), stockRows({ expiry: "soon", today }), stockRows({ today })]);
    expect(ex.length).toBe(s.expired);
    expect(so.length).toBe(s.expiring);
    expect(ex.every((r) => r.expiredQty > 0) && so.every((r) => r.soonQty > 0)).toBe(true);
    expect(mine(ex)).toMatchObject({ stockQty: 35, expiredQty: 5, soonQty: 10, nextExpiry: addDaysIso(today, -1) });
    expect(mine(so)).toBeTruthy();
    expect(mine(all)).toMatchObject({ expiredQty: 5, soonQty: 10 });
    // mit Filter: dringendstes MHD zuerst
    const dates = ex.map((r) => r.nextExpiry ?? "9999");
    expect([...dates].sort()).toEqual(dates);
  });

  it("Hinweise: abgelaufene Charge vor der bald ablaufenden", async () => {
    const al = await alerts(today);
    const mineAl = al.expiring.filter((x) => x.id === variantId).map((x) => x.qty);
    if (mineAl.length) expect(mineAl[0]).toBe(5);
    expect(al.expiring.map((x) => x.expiry)).toEqual([...al.expiring.map((x) => x.expiry)].sort());
  });

  it("Verlust „abgelaufen“ nimmt nach FEFO zuerst die abgelaufene Charge → Zahl geht zurück", async () => {
    await bookWriteOff({ date: today, reason: "EXPIRED", lines: [{ variantId, qty: 5 }] });
    const s = await dashboardStats(today);
    expect(s.expired).toBe(before.expired);
    expect(s.expiredQty).toBe(before.expiredQty);
    expect(s.expiring - before.expiring).toBe(1);
    expect(mine(await stockRows({ expiry: "expired", today }))).toBeUndefined();
    expect(mine(await stockRows({ expiry: "soon", today }))).toMatchObject({ stockQty: 30, expiredQty: 0, soonQty: 10, nextExpiry: today });
  });
});
