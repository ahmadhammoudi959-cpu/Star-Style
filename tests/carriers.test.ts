import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db";
import {
  DEFAULT_CARRIERS, MAX_CUSTOM_CARRIERS, applyCarrierOp, carrierChoices, carrierStored, checkCustomCarrier, choiceKeyFor, needsNumber,
  parseCarrierSettings, shipmentFields, withNumberPlaceholder, type CarrierOp, type CarrierSettings,
} from "../src/lib/carriers";
import { carrierUrlTemplate, checkNumbers, shopTrackingInput, trackingUrl } from "../src/lib/shipping";
import { routeNeed } from "../src/lib/permissions";

// Versanddienste verwalten (Wunsch Inhaber 13.11.2026: „شركات الشحن دي من وين نعدلها من السيستم او نضيف جديد“)

let n = 0;
const ids = () => `ctest${String(++n).padStart(4, "0")}`;
const apply = (s: CarrierSettings, op: CarrierOp) => {
  const r = applyCarrierOp(s, op, ids);
  if ("problem" in r) throw new Error(r.problem);
  return r.settings;
};
const problem = (s: CarrierSettings, op: CarrierOp) => {
  const r = applyCarrierOp(s, op, ids);
  return "problem" in r ? r.problem : null;
};

describe("Versanddienste: gespeicherter Stand", () => {
  it("{} = wie bisher: DHL, DPD, GLS, Hermes, UPS, Spedition – DHL vorgewählt; Speichern ohne Änderung = {}", () => {
    for (const raw of [{}, null, undefined, "x", 7, [], { order: "DHL", hidden: {}, custom: "x" }]) expect(parseCarrierSettings(raw)).toEqual(DEFAULT_CARRIERS);
    expect(DEFAULT_CARRIERS).toEqual({ order: ["DHL", "DPD", "GLS", "HERMES", "UPS", "OTHER"], hidden: [], default: "DHL", custom: [] });
    expect(carrierStored(parseCarrierSettings({}))).toEqual({});
    expect(carrierChoices(DEFAULT_CARRIERS).map((c) => `${c.key}:${c.kind}:${c.name}`)).toEqual([
      "DHL:builtin:DHL", "DPD:builtin:DPD", "GLS:builtin:GLS", "HERMES:builtin:Hermes", "UPS:builtin:UPS", "OTHER:free:",
    ]);
  });

  it("wirft nie, Unbekanntes/Doppeltes/Ungültiges fällt weg, fehlende Einträge kommen vor die Spedition", () => {
    const s = parseCarrierSettings({
      order: ["UPS", "nope", "UPS", "OTHER", "cfedex01", 3],
      hidden: ["DPD", "DPD", "xx", "cbadid!"],
      default: "unknown",
      custom: [
        { id: "cfedex01", name: "  FedEx\n ", url: "https://www.fedex.com/fedextrack/?trknbr={n}" },
        { id: "cfedex02", name: "fedex", url: "" }, // gleicher Name
        { id: "cdhl0001", name: "dhl", url: "" }, // Name eines eingebauten
        { id: "BAD", name: "Kaputt", url: "" }, // ungültige ID
        { id: "cmueller", name: "Spedition Müller", url: "javascript:alert(1)" }, // Link ungültig → ohne Link
        { id: "clong001", name: "x".repeat(61), url: "" },
        "x", null,
      ],
    });
    expect(s.custom).toEqual([
      { id: "cfedex01", name: "FedEx", url: "https://www.fedex.com/fedextrack/?trknbr={n}" },
      { id: "cmueller", name: "Spedition Müller", url: "" },
    ]);
    expect(s.order).toEqual(["UPS", "DHL", "DPD", "GLS", "HERMES", "cmueller", "OTHER", "cfedex01"]);
    expect(s.hidden).toEqual(["DPD"]);
    expect(s.default).toBe("DHL");
    // höchstens 20 eigene
    const many = parseCarrierSettings({ custom: Array.from({ length: 30 }, (_, i) => ({ id: `cmany${String(i).padStart(3, "0")}`, name: `Firma ${i}`, url: "" })) });
    expect(many.custom).toHaveLength(MAX_CUSTOM_CARRIERS);
  });

  it("immer mindestens einer sichtbar, der vorgewählte ist sichtbar", () => {
    const all = parseCarrierSettings({ hidden: ["DHL", "DPD", "GLS", "HERMES", "UPS", "OTHER"], default: "GLS" });
    expect(all.hidden).toEqual(["DHL", "DPD", "HERMES", "UPS", "OTHER"]);
    expect(all.default).toBe("GLS");
    const hiddenDefault = parseCarrierSettings({ hidden: ["DHL"], default: "DHL" });
    expect(hiddenDefault.default).toBe("DPD");
    expect(parseCarrierSettings({ hidden: ["DHL", "DPD", "GLS", "HERMES", "UPS", "OTHER"] }).hidden).not.toContain("DHL");
  });
});

describe("Versanddienste: Änderungen", () => {
  const base = parseCarrierSettings({});
  it("hinzufügen: vor der Spedition, Name und Link geprüft, höchstens 20", () => {
    const s = apply(base, { op: "add", name: " FedEx ", url: " https://www.fedex.com/fedextrack/?trknbr={n} " });
    const id = s.custom[0].id;
    expect(s.custom).toEqual([{ id, name: "FedEx", url: "https://www.fedex.com/fedextrack/?trknbr={n}" }]);
    expect(s.order).toEqual(["DHL", "DPD", "GLS", "HERMES", "UPS", id, "OTHER"]);
    expect(carrierStored(s)).toEqual(s);
    expect(problem(s, { op: "add", name: "fedex", url: "" })).toBe("nameTaken");
    expect(problem(s, { op: "add", name: "Hermes", url: "" })).toBe("nameTaken");
    expect(problem(s, { op: "add", name: "  ", url: "" })).toBe("name");
    expect(problem(s, { op: "add", name: "x".repeat(61), url: "" })).toBe("name");
    expect(problem(s, { op: "add", name: "TNT", url: "http://tnt.example/{n}" })).toBe("url");
    expect(problem(s, { op: "add", name: "TNT", url: "javascript:alert(1)" })).toBe("url");
    expect(problem(s, { op: "add", name: "TNT", url: `https://a.de/${"x".repeat(300)}` })).toBe("url");
    expect(problem(s, { op: "add", name: "Spedition Müller", url: "" })).toBeNull();
    let full = base;
    for (let i = 0; i < MAX_CUSTOM_CARRIERS; i++) full = apply(full, { op: "add", name: `Firma ${i}`, url: "" });
    expect(problem(full, { op: "add", name: "Noch eine", url: "" })).toBe("tooMany");
  });

  it("ändern, entfernen (nur eigene), anzeigen/ausblenden, vorwählen, Reihenfolge", () => {
    let s = apply(base, { op: "add", name: "FedEx", url: "" });
    const id = s.custom[0].id;
    s = apply(s, { op: "edit", key: id, name: "FedEx Express", url: "https://www.fedex.com/fedextrack/?trknbr={n}" });
    expect(s.custom[0]).toEqual({ id, name: "FedEx Express", url: "https://www.fedex.com/fedextrack/?trknbr={n}" });
    expect(problem(s, { op: "edit", key: id, name: "UPS", url: "" })).toBe("nameTaken");
    expect(problem(s, { op: "edit", key: "DHL", name: "DHL Paket", url: "" })).toBe("notFound");
    expect(problem(s, { op: "remove", key: "DHL" })).toBe("notFound");
    expect(problem(s, { op: "hide", key: "cunknown1" })).toBe("notFound");
    // ausblenden + vorwählen
    s = apply(s, { op: "hide", key: "UPS" });
    expect(s.hidden).toEqual(["UPS"]);
    s = apply(s, { op: "default", key: id });
    expect(s.default).toBe(id);
    s = apply(s, { op: "hide", key: id }); // der vorgewählte wird ausgeblendet → nächster sichtbarer
    expect(s.default).toBe("DHL");
    s = apply(s, { op: "default", key: "UPS" }); // vorwählen zeigt ihn auch wieder an
    expect([s.default, s.hidden]).toEqual(["UPS", [id]]);
    s = apply(s, { op: "show", key: id });
    expect(s.hidden).toEqual([]);
    // Reihenfolge (an den Rändern nichts)
    s = apply(s, { op: "up", key: id });
    expect(s.order).toEqual(["DHL", "DPD", "GLS", "HERMES", id, "UPS", "OTHER"]);
    s = apply(s, { op: "up", key: "DHL" });
    s = apply(s, { op: "down", key: "OTHER" });
    expect(s.order).toEqual(["DHL", "DPD", "GLS", "HERMES", id, "UPS", "OTHER"]);
    s = apply(s, { op: "down", key: "DHL" });
    expect(s.order.slice(0, 2)).toEqual(["DPD", "DHL"]);
    // entfernen: weg aus Liste, Reihenfolge und Vorwahl
    s = apply(s, { op: "default", key: id });
    s = apply(s, { op: "remove", key: id });
    expect(s.custom).toEqual([]);
    expect(s.order).toEqual(["DPD", "DHL", "GLS", "HERMES", "UPS", "OTHER"]);
    expect(s.default).toBe("DHL");
  });

  it("der letzte sichtbare lässt sich nicht ausblenden; wird der einzige sichtbare entfernt, kommt der vorgewählte zurück", () => {
    let s = base;
    for (const k of ["DPD", "GLS", "HERMES", "UPS", "OTHER"]) s = apply(s, { op: "hide", key: k });
    expect(problem(s, { op: "hide", key: "DHL" })).toBe("lastVisible");
    s = apply(s, { op: "add", name: "Kurier Nord", url: "" });
    const id = s.custom[0].id;
    s = apply(s, { op: "default", key: id });
    s = apply(s, { op: "hide", key: "DHL" });
    expect(s.order.filter((k) => !s.hidden.includes(k))).toEqual([id]);
    s = apply(s, { op: "remove", key: id });
    expect(s.order.filter((k) => !s.hidden.includes(k))).toEqual(["DHL"]);
    expect(s.default).toBe("DHL");
  });
});

describe("Versanddienste in der Karte „Versand“", () => {
  const s = parseCarrierSettings({
    order: ["DHL", "cfedex01", "cmueller", "OTHER", "DPD", "GLS", "HERMES", "UPS"], hidden: ["UPS"], default: "cfedex01",
    custom: [
      { id: "cfedex01", name: "FedEx", url: "https://www.fedex.com/fedextrack/?trknbr={n}" },
      { id: "cmueller", name: "Spedition Müller", url: "https://mueller.example/sendungen" },
    ],
  });
  const choices = carrierChoices(s);
  const byKey = (k: string) => choices.find((c) => c.key === k)!;

  it("eigener Versanddienst = Spedition mit festem Namen + Link; eingebaut ohne; Spedition frei", () => {
    expect(shipmentFields(byKey("cfedex01"), { name: "egal", url: "egal" })).toEqual({ carrier: "OTHER", carrierName: "FedEx", trackingUrl: "https://www.fedex.com/fedextrack/?trknbr={n}" });
    expect(shipmentFields(byKey("DHL"), { name: "egal", url: "egal" })).toEqual({ carrier: "DHL", carrierName: "", trackingUrl: "" });
    expect(shipmentFields(byKey("OTHER"), { name: "Möbel Kurier", url: "https://k.example/{n}" })).toEqual({ carrier: "OTHER", carrierName: "Möbel Kurier", trackingUrl: "https://k.example/{n}" });
    expect(byKey("UPS").hidden).toBe(true);
    // Nummer: eingebaut immer, eigener nur mit {n} im Link, Spedition nie
    expect(choices.map((c) => [c.key, needsNumber(c)])).toEqual([
      ["DHL", true], ["cfedex01", true], ["cmueller", false], ["OTHER", false], ["DPD", true], ["GLS", true], ["HERMES", true], ["UPS", true],
    ]);
    expect(checkNumbers("OTHER", [""], true).problem).toBe("missing");
    expect(checkNumbers("OTHER", [""]).problem).toBeNull(); // Server: Spedition darf ohne Nummer
  });

  it("Shopify bekommt Name + Links wie bei jeder Spedition", () => {
    const f = shipmentFields(byKey("cfedex01"), { name: "", url: "" });
    expect(shopTrackingInput({ ...f, trackingNumbers: ["123456789012"] })).toEqual({
      company: "FedEx", numbers: ["123456789012"], urls: ["https://www.fedex.com/fedextrack/?trknbr=123456789012"],
    });
    // ohne Nummer und mit {n} im Link: kein kaputter Link
    expect(shopTrackingInput({ ...f, trackingNumbers: [] })).toEqual({ company: "FedEx" });
    expect(trackingUrl("OTHER", "", "https://www.fedex.com/fedextrack/?trknbr={n}")).toBeNull();
    expect(trackingUrl("OTHER", "", "https://mueller.example/sendungen")).toBe("https://mueller.example/sendungen");
  });

  it("gespeicherte Sendung → Knopf (Name gleich und Link gleich oder leer), sonst Spedition frei", () => {
    expect(choiceKeyFor(choices, { carrier: "UPS", carrierName: "", trackingUrl: "" })).toBe("UPS"); // auch ausgeblendet
    expect(choiceKeyFor(choices, { carrier: "OTHER", carrierName: " fedex ", trackingUrl: "https://www.fedex.com/fedextrack/?trknbr={n}" })).toBe("cfedex01");
    expect(choiceKeyFor(choices, { carrier: "OTHER", carrierName: "FedEx", trackingUrl: "" })).toBe("cfedex01"); // z. B. im Shopify-Admin eingetragen
    expect(choiceKeyFor(choices, { carrier: "OTHER", carrierName: "FedEx", trackingUrl: "https://alt.example/{n}" })).toBe("OTHER"); // älterer Link bleibt
    expect(choiceKeyFor(choices, { carrier: "OTHER", carrierName: "Möbel Kurier", trackingUrl: "" })).toBe("OTHER");
  });

  it("Link aus der Adresszeile: Nummer wird {n} (Groß-/Kleinschreibung egal), Leerzeichen weg", () => {
    expect(withNumberPlaceholder(" https://www.fedex.com/fedextrack/?trknbr=123456789012 ", "1234 5678 9012")).toBe("https://www.fedex.com/fedextrack/?trknbr={n}");
    expect(withNumberPlaceholder("https://t.example/track/ab12cd?id=AB12CD", "AB12CD")).toBe("https://t.example/track/{n}?id={n}");
    expect(withNumberPlaceholder("https://t.example/x?id=1", "999")).toBe("https://t.example/x?id=1");
    expect(withNumberPlaceholder("https://t.example/{n}", "1")).toBe("https://t.example/{n}");
    expect(withNumberPlaceholder("", "1")).toBe("");
    expect(checkCustomCarrier(DEFAULT_CARRIERS, "TNT", withNumberPlaceholder("https://www.tnt.com/track?cons=GE123", "GE123"))).toBeNull();
  });

  it("eingebaute Links als Vorlage; Seite gehört zu „Einstellungen“", () => {
    expect(carrierUrlTemplate("DHL")).toBe("https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={n}");
    expect(carrierUrlTemplate("OTHER")).toBeNull();
    expect(routeNeed("/settings/carriers")).toEqual({ any: ["settings"] });
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Versanddienste (Datenbank)", () => {
  let before: unknown = null;
  beforeAll(async () => {
    const row = await db.query.companySettings.findFirst();
    if (!row) await db.insert(schema.companySettings).values({ id: "company" });
    before = row?.carriers ?? {};
    await db.update(schema.companySettings).set({ carriers: {} });
  });
  afterAll(async () => {
    await db.update(schema.companySettings).set({ carriers: (before ?? {}) as Record<string, unknown> });
  });

  it("jede Änderung gespeichert + Protokoll; Fehler ändern nichts", async () => {
    const { changeCarriers, loadCarrierSettings } = await import("../src/lib/carrier-settings");
    expect(await loadCarrierSettings()).toEqual(DEFAULT_CARRIERS);
    const t0 = new Date(Date.now() - 1000);
    const r = await changeCarriers({ op: "add", name: "FedEx", url: "https://www.fedex.com/fedextrack/?trknbr={n}" });
    expect("settings" in r).toBe(true);
    const s = await loadCarrierSettings();
    expect(s.custom).toEqual([{ id: expect.stringMatching(/^c[0-9a-f]{12}$/), name: "FedEx", url: "https://www.fedex.com/fedextrack/?trknbr={n}" }]);
    expect(await changeCarriers({ op: "add", name: "fedex", url: "" })).toEqual({ problem: "nameTaken" });
    await changeCarriers({ op: "hide", key: "UPS" });
    // gleichzeitig: beide Änderungen kommen an (Zeilensperre)
    await Promise.all([changeCarriers({ op: "add", name: "Kurier A", url: "" }), changeCarriers({ op: "add", name: "Kurier B", url: "" })]);
    const s2 = await loadCarrierSettings();
    expect(s2.custom.map((c) => c.name).sort()).toEqual(["FedEx", "Kurier A", "Kurier B"]);
    expect(s2.hidden).toEqual(["UPS"]);
    const log = (await db.execute<{ action: string }>(sql`select action from audit_log where entity = 'settings' and entity_id = 'carriers' and created_at >= ${t0} order by created_at`)).rows.map((x) => x.action);
    expect(log).toEqual(["add", "hide", "add", "add"]);
    // alles zurück auf Standard → {} gespeichert
    for (const c of s2.custom) await changeCarriers({ op: "remove", key: c.id });
    await changeCarriers({ op: "show", key: "UPS" });
    const row = await db.query.companySettings.findFirst({ where: eq(schema.companySettings.id, "company") });
    expect(row?.carriers).toEqual({});
  });
});
