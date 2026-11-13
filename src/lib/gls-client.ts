import "server-only";
/**
 * GLS ShipIT: Einstellungen laden/speichern und die drei Aufrufe (Etikett anlegen, stornieren, prüfen).
 * Reine Regeln in ./gls.ts. Das Passwort steht nur verschlüsselt in company_settings.gls (Schlüssel aus SESSION_SECRET).
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { decrypt, encrypt } from "./crypto";
import { buildGlsShipment, glsCancelOk, glsErrorText, glsReady, normalizeEndpoint, parseGlsCreated, parseGlsSettings, type GlsCreateInput, type GlsCreated, type GlsSettings } from "./gls";

const LOCAL_HTTP = process.env.NODE_ENV !== "production";

export class GlsError extends Error {
  /** code: notConfigured | network | auth | rejected | badResponse */
  constructor(public code: string, message = code) { super(message); }
}

/** Gespeicherte Einstellungen (Passwort NICHT entschlüsselt – nur für die Anzeige „gesetzt“) */
export async function loadGlsSettings(): Promise<GlsSettings> {
  const row = await db.query.companySettings.findFirst({ columns: { gls: true } });
  return parseGlsSettings(row?.gls, LOCAL_HTTP);
}

/** Für die Aufrufe: mit entschlüsseltem Passwort; null = nicht (vollständig) eingerichtet */
async function activeSettings(): Promise<GlsSettings | null> {
  const s = await loadGlsSettings();
  if (!glsReady(s)) return null;
  try { return { ...s, password: decrypt(s.password) }; } catch { return null; }
}

export const glsConfigured = async () => glsReady(await loadGlsSettings());

export type GlsSettingsInput = { endpoint: string; user: string; password: string; contactId: string; flex: boolean };
export type GlsSettingsProblem = "endpoint" | "user" | "contactId" | "password";

/** Speichern; leeres Passwort = altes behalten. Alles leer = GLS-Anbindung aus. */
export async function saveGlsSettings(input: GlsSettingsInput, userId?: string): Promise<{ problem: GlsSettingsProblem } | { ok: true }> {
  const endpoint = normalizeEndpoint(input.endpoint, LOCAL_HTTP);
  const user = input.user.trim().slice(0, 100);
  const contactId = input.contactId.replace(/\s+/g, "").slice(0, 60);
  const clearAll = !input.endpoint.trim() && !user && !contactId && !input.password;
  if (!clearAll) {
    if (!endpoint) return { problem: "endpoint" };
    if (!user) return { problem: "user" };
    if (!contactId) return { problem: "contactId" };
  }
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; gls: unknown }>(sql`select id, gls from company_settings order by id limit 1 for update`);
    const row = rows.rows[0];
    const before = parseGlsSettings(row?.gls, LOCAL_HTTP);
    const password = clearAll ? "" : input.password ? encrypt(input.password.slice(0, 200)) : before.password;
    if (!clearAll && !password) return { problem: "password" as const };
    const next = clearAll ? {} : { endpoint, user, password, contactId, flex: input.flex };
    if (row) await tx.update(schema.companySettings).set({ gls: next }).where(eq(schema.companySettings.id, row.id));
    else await tx.insert(schema.companySettings).values({ id: "company", gls: next });
    // nie das Passwort ins Protokoll
    const show = (s: GlsSettings | Record<string, never>) => ("endpoint" in s ? { endpoint: s.endpoint, user: s.user, contactId: s.contactId, flex: s.flex, password: s.password ? "gesetzt" : "" } : {});
    await tx.insert(schema.auditLog).values({
      entity: "settings", entityId: "gls", action: "update", userId: userId ?? null,
      before: show(before), after: { ...show(clearAll ? {} : { ...next, password } as GlsSettings), passwordChanged: Boolean(input.password) },
    });
    return { ok: true as const };
  });
}

async function call(s: GlsSettings, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${s.endpoint}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${s.user}:${s.password}`).toString("base64")}`,
        Accept: "application/glsVersion1+json, application/json",
        "Content-Type": "application/glsVersion1+json",
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
  } catch (e) {
    throw new GlsError("network", (e as Error).message?.slice(0, 200) || "network");
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new GlsError("auth", glsErrorText(res.status, res.headers, text));
  if (!res.ok) throw new GlsError(res.status >= 500 ? "network" : "rejected", glsErrorText(res.status, res.headers, text));
  try { return text ? JSON.parse(text) : {}; } catch { throw new GlsError("badResponse", text.slice(0, 200)); }
}

/** Etikett(en) anlegen. Wirft GlsError. */
export async function glsCreateParcels(input: Omit<GlsCreateInput, "contactId" | "flex">): Promise<GlsCreated> {
  const s = await activeSettings();
  if (!s) throw new GlsError("notConfigured");
  const json = await call(s, "/shipments", buildGlsShipment({ ...input, contactId: s.contactId, flex: s.flex }));
  try { return parseGlsCreated(json); } catch { throw new GlsError("badResponse", JSON.stringify(json).slice(0, 200)); }
}

/** Paket bei GLS stornieren (geht nur, solange es noch nicht abgeholt/gescannt ist) */
export async function glsCancelParcel(trackId: string): Promise<void> {
  const s = await activeSettings();
  if (!s) throw new GlsError("notConfigured");
  const json = await call(s, `/shipments/cancel/${encodeURIComponent(trackId)}`, null);
  if (!glsCancelOk(json)) throw new GlsError("rejected", JSON.stringify(json).slice(0, 200));
}

/** Verbindung testen: Beispielsendung an die eigene Anschrift nur prüfen lassen (legt nichts an) */
export async function glsTestConnection(): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const s = await activeSettings();
  if (!s) return { ok: false, code: "notConfigured", message: "" };
  const c = await db.query.companySettings.findFirst();
  const body = buildGlsShipment({
    reference: "TEST", shippingDate: new Date().toISOString().slice(0, 10), contactId: s.contactId, flex: false, parcelsKg: [1],
    consignee: { name: c?.name || "Star Style", street: c?.street || "Provinzialstraße 45", zip: c?.zip || "45711", city: c?.city || "Datteln", country: (c?.country || "DE").toUpperCase(), business: true },
  });
  try {
    const json = await call(s, "/shipments/validate", { Shipment: body.Shipment }) as { success?: boolean; validationResult?: { Issues?: { Rule?: string; Location?: string }[] } };
    if (json && json.success === false) {
      const issues = (json.validationResult?.Issues ?? []).map((i) => [i.Rule, i.Location].filter(Boolean).join(" ")).join(" · ").slice(0, 300);
      return { ok: false, code: "rejected", message: issues };
    }
    return { ok: true };
  } catch (e) {
    return e instanceof GlsError ? { ok: false, code: e.code, message: e.message } : { ok: false, code: "network", message: String(e).slice(0, 200) };
  }
}
