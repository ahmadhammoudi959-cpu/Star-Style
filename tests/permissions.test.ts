import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  ALL_PERMS, IMPLIES, PERMISSION_GROUPS, PRESETS, TEMP_ALPHABET, allowed, canOpen, effectivePerms, isPerm, normalizePerms, routeNeed, tempPassword,
  type Access, type Perm,
} from "../src/lib/permissions";
import de from "../src/i18n/de";

// Rechte je Mitarbeiter (Wunsch Inhaber 12.11.2026: jedes Recht ein Häkchen, der Admin wählt je Person)
const staff = (...p: Perm[]): Access => ({ admin: false, perms: effectivePerms(p, false) });
const admin: Access = { admin: true, perms: effectivePerms([], true) };

describe("Rechte (rein)", () => {
  it("jeder Schlüssel einmal, Gruppen und Texte vollständig", () => {
    expect(new Set(ALL_PERMS).size).toBe(ALL_PERMS.length);
    expect(Object.keys(de.users.groups).sort()).toEqual(Object.keys(PERMISSION_GROUPS).sort());
    expect(Object.keys(de.users.perms).sort()).toEqual([...ALL_PERMS].sort());
    for (const [p, deps] of Object.entries(IMPLIES)) { expect(isPerm(p)).toBe(true); for (const d of deps!) expect(isPerm(d)).toBe(true); }
  });

  it("Admin hat alles; Abhängigkeiten kommen mit; Unbekanntes fällt weg", () => {
    expect(effectivePerms([], true).size).toBe(ALL_PERMS.length);
    const e = effectivePerms(["sales.invoices", "reports.lock", "gibtsnicht", 7, null], false);
    expect([...e].sort()).toEqual(["customers", "products.view", "reports.export", "reports.lock", "reports.view", "sales.invoices", "sales.view"].sort());
    expect(effectivePerms("kaputt", false).size).toBe(0);
    expect(normalizePerms(["sales.view", "sales.view", "customers"])).toEqual(["customers", "sales.view"]);
    // feste Reihenfolge wie im Formular
    expect(normalizePerms(["reports.view", "dashboard.money"])).toEqual(["dashboard.money", "reports.view"]);
  });

  it("Vorlagen: alle außer Steuerbüro dürfen Angebote und Rechnungen; Lager ohne Wareneingang und ohne Geld", () => {
    for (const [k, list] of Object.entries(PRESETS)) {
      for (const p of list) expect(isPerm(p), `${k}: ${p}`).toBe(true);
      const e = effectivePerms(list, false);
      if (k === "accountant") {
        expect([...e].sort()).toEqual(["reports.export", "reports.view"]);
      } else {
        expect(e.has("sales.offers") && e.has("sales.invoices"), k).toBe(true);
        for (const money of ["payments.record", "payments.cancel", "expenses.view", "reports.view", "settings", "dashboard.money", "products.cost"] as Perm[]) {
          expect(e.has(money), `${k} ${money}`).toBe(false);
        }
      }
    }
    expect(effectivePerms(PRESETS.warehouse, false).has("stock.receive")).toBe(false);
  });

  it("Seiten: Scanner und Mein Konto für alle, Mitarbeiter nur Admin, Unbekanntes nur Admin", () => {
    const accountant = staff(...PRESETS.accountant);
    const warehouse = staff(...PRESETS.warehouse);
    for (const p of ["/", "/scan", "/account", "/password"]) expect(canOpen(accountant, p), p).toBe(true);
    expect(routeNeed("/settings/users")).toBe("admin");
    expect(routeNeed("/settings/users/abc")).toBe("admin");
    expect(routeNeed("/irgendwas-neues")).toBe("admin");
    expect(canOpen(admin, "/irgendwas-neues")).toBe(true);
    expect(canOpen(accountant, "/reports")).toBe(true);
    expect(canOpen(accountant, "/reports/export?month=2026-10")).toBe(true);
    expect(canOpen(accountant, "/sales")).toBe(false);
    expect(canOpen(accountant, "/settings")).toBe(false);
    expect(canOpen(warehouse, "/stock/abc")).toBe(true);
    expect(canOpen(warehouse, "/receive")).toBe(false);
    expect(canOpen(warehouse, "/sales/invoices/new")).toBe(true);
    expect(canOpen(warehouse, "/receivables")).toBe(false);
    expect(canOpen(warehouse, "/expenses")).toBe(false);
    // Verkauf ansehen ja, neue Rechnung nur mit Recht „Rechnungen schreiben“
    expect(canOpen(staff("sales.view"), "/sales/invoices/abc")).toBe(true);
    expect(canOpen(staff("sales.view"), "/sales/invoices/new")).toBe(false);
    expect(canOpen(staff("expenses.view"), "/expenses/new")).toBe(false);
    expect(canOpen(staff("expenses.view"), "/expenses/vendors")).toBe(true);
    expect(canOpen(staff("customers"), "/customers/abc/statement")).toBe(false);
    expect(canOpen(staff("customers.statement"), "/customers/abc/statement")).toBe(true);
    expect(canOpen(staff("shops.view"), "/shops/GENERAL_SHOP/mapping")).toBe(false);
    expect(canOpen(staff("products.view"), "/products/new")).toBe(false);
    // Präfix nur an Pfadgrenzen: /salesx ist nicht /sales
    expect(routeNeed("/salesx")).toBe("admin");
    expect(allowed(staff(), "all")).toBe(true);
    expect(allowed(staff(...ALL_PERMS), "admin")).toBe(false);
  });

  it("PDF-APIs: Rechnung mit Verkauf ansehen, Mahnung mit offenen Posten, Wareneingang mit Wareneingang", () => {
    expect(canOpen(staff("sales.view"), "/api/pdf/invoice/abc")).toBe(true);
    expect(canOpen(staff("sales.view"), "/api/pdf/dunning/abc")).toBe(false);
    expect(canOpen(staff("receivables"), "/api/pdf/dunning/abc")).toBe(true);
    expect(canOpen(staff("products.view"), "/api/pdf/goods-receipt/abc")).toBe(false);
    expect(canOpen(staff("design"), "/api/pdf/design-preview")).toBe(true);
    expect(canOpen(staff(), "/api/files/abc")).toBe(true); // die Route prüft selbst (file-access.ts)
  });

  it("Einmal-Passwort: 3 × 4 Zeichen, nur gut lesbare Zeichen, zufällig", () => {
    const rnd = (n: number) => new Uint8Array(Array.from({ length: n }, () => Math.floor(Math.random() * 256)));
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = tempPassword(rnd);
      expect(p).toMatch(/^[^-]{4}-[^-]{4}-[^-]{4}$/);
      for (const c of p.replace(/-/g, "")) expect(TEMP_ALPHABET).toContain(c);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
    expect(TEMP_ALPHABET).not.toMatch(/[0O1lI]/);
    // nur verzerrungsfreie Bytes werden benutzt (≥ 248 werden übersprungen)
    expect(tempPassword((n) => new Uint8Array(n).fill(255))).toMatch(/^.{4}-.{4}-.{4}$/);
  });
});

/** Jede Seite und API-Route braucht eine eigene Zeile in ROUTES – sonst wäre sie nur für den Admin offen (Absicht nur bei /settings/users) */
describe("jede Seite hat eine Rechte-Zeile", () => {
  const root = join(__dirname, "..", "src", "app");
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f === "page.tsx" || f === "route.ts") files.push(p); } };
  walk(root);
  const urlOf = (f: string) => "/" + relative(root, f).split(sep).slice(0, -1)
    .filter((s) => !/^\(.*\)$/.test(s))
    .map((s) => (s === "[channel]" ? "GENERAL_SHOP" : s.startsWith("[") ? "x" : s)).join("/");
  const PUBLIC = ["/login", "/setup", "/api/shopify/webhook"]; // in der Middleware ohne Sitzung (Webhook per HMAC)
  // /api/backup/upload läuft an der Middleware vorbei, steht aber trotzdem als „nur Admin“ in ROUTES (und prüft selbst)
  const ADMIN_ONLY = ["/settings/users", "/backup", "/api/backup"];

  it("findet die Seiten", () => expect(files.length).toBeGreaterThan(40));
  for (const f of files) {
    const url = urlOf(f).replace(/\/$/, "") || "/";
    if (PUBLIC.some((p) => url === p || url.startsWith(p + "/"))) continue;
    it(url, () => {
      const need = routeNeed(url);
      if (ADMIN_ONLY.some((p) => url === p || url.startsWith(p + "/"))) expect(need).toBe("admin");
      else expect(need, `${url} fehlt in ROUTES (src/lib/permissions.ts)`).not.toBe("admin");
    });
  }
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Rechte aus der Datenbank", () => {
  it("gesperrt, Rechte, Admin und Sitzungs-Version kommen aus users", async () => {
    const { db, schema } = await import("../src/db");
    const { loadAccess, forgetSession, sessionCurrent } = await import("../src/lib/session-check");
    const email = `perm-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const [u] = await db.insert(schema.users).values({ email, name: "Lager Test", passwordHash: "x", permissions: ["stock.count", "unbekannt"] }).returning();
    try {
      const a = await loadAccess(u.id, u.sessionVersion);
      expect(a?.admin).toBe(false);
      expect(a && [...a.perms].sort()).toEqual(["products.view", "stock.count"]);
      expect(await sessionCurrent(u.id, u.sessionVersion)).toBe(true);
      expect(await sessionCurrent(u.id, u.sessionVersion + 1)).toBe(false);
      // gesperrt → Sitzung ungültig, sobald der Zwischenspeicher vergessen ist
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, u.id));
      forgetSession(u.id);
      expect(await sessionCurrent(u.id, u.sessionVersion)).toBe(false);
      // neue Sitzungs-Version: ein frisches Cookie liest sofort neu (Zwischenspeicher gilt nur für die passende Version)
      await db.update(schema.users).set({ active: true, isAdmin: true, sessionVersion: sql`${schema.users.sessionVersion} + 1` }).where(eq(schema.users.id, u.id));
      const b = await loadAccess(u.id, u.sessionVersion + 1);
      expect(b?.admin).toBe(true);
      expect(b?.perms.size).toBe(ALL_PERMS.length);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, u.id));
      forgetSession(u.id);
    }
  });
});
