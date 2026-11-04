import { describe, expect, it } from "vitest";
import {
  afterChanges, diffGallery, mapCreatedMedia, newMediaIds, parseGalleryInput, planGallery, productFiles, reorderMoves, type GalleryRow,
} from "../src/lib/shopify/gallery-map";
import {
  categoryStoreState, cleanCategoryName, collectionInput, menuDepth, menuGroups, menuHas, menuToInput, menuWithCollection, menuWithout, type MenuItem,
} from "../src/lib/shopify/category-map";

const row = (id: string, fileId: string, position: number, mediaId = "", removed = false, hidden = false): GalleryRow => ({ id, fileId, position, mediaId, removed, hidden });
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const inp = (files: string[], o: { hidden?: string[]; drop?: string[] } = {}) => ({ files, hidden: o.hidden ?? [], drop: o.drop ?? [] });

describe("Shop-Galerie", () => {
  it("Formular → Datenbank: bleiben, neu, entfernt", () => {
    const rows = [row("r1", "a", 0, "m1"), row("r2", "b", 1), row("r3", "c", 2, "m3"), row("rx", "x", 0, "mx", true)];
    const d = diffGallery(rows, inp(["c", "d", "a"]));
    expect(d.keep).toEqual([{ id: "r3", position: 0, hidden: false }, { id: "r1", position: 2, hidden: false }]);
    expect(d.add).toEqual([{ fileId: "d", position: 1, hidden: false }]);
    expect(d.tombstone).toEqual([]);
    expect(d.detach).toEqual([]);
    expect(d.drop).toEqual(["r2"]); // ohne Medium im Shop → einfach weg
    expect(d.changed).toBe(true);
    // unverändert
    expect(diffGallery([row("r1", "a", 0, "m1"), row("r2", "b", 1)], inp(["a", "b"])).changed).toBe(false);
    // nur umsortiert
    expect(diffGallery([row("r1", "a", 0, "m1"), row("r2", "b", 1)], inp(["b", "a"]))).toMatchObject({ changed: true, add: [], drop: [], tombstone: [], detach: [] });
    // gleiche Datei doppelt in der Datenbank → die zweite fliegt raus (mit Medium: im Shop löschen, es ist unser Doppel)
    expect(diffGallery([row("r1", "a", 0), row("r2", "a", 1)], inp(["a"])).drop).toEqual(["r2"]);
    expect(diffGallery([row("r1", "a", 0, "m1"), row("r2", "a", 1, "m2")], inp(["a"])).tombstone).toEqual(["r2"]);
  });

  it("Entfernen eines Fotos, das im Shop ist: im Shop nur gelöscht, wenn so gewählt (Wunsch Inhaber 04.11.2026)", () => {
    const rows = [row("r1", "a", 0, "m1"), row("r2", "b", 1, "m2"), row("r3", "c", 2, "m3")];
    // a „aus System und Shop“, b „nur aus dem System“ (keine Wahl = bleibt im Shop), c „nur aus dem Shop“ (bleibt hier, hidden)
    const d = diffGallery(rows, inp(["c"], { hidden: ["c"], drop: ["a"] }));
    expect(d.tombstone).toEqual(["r1"]);
    expect(d.detach).toEqual(["r2"]);
    expect(d.keep).toEqual([{ id: "r3", position: 0, hidden: true }]);
    expect(d.changed).toBe(true);
    // nur „aus dem Shop“ genommen (sonst nichts) zählt als Änderung; „wieder in den Shop“ auch
    expect(diffGallery(rows, inp(["a", "b", "c"], { hidden: ["b"] }))).toMatchObject({ changed: true, keep: [{ hidden: false }, { hidden: true }, { hidden: false }] });
    expect(diffGallery([row("r1", "a", 0, "", false, true)], inp(["a"])).keep).toEqual([{ id: "r1", position: 0, hidden: false }]);
    // schon „nur aus dem Shop“ genommen und jetzt ganz entfernt → im Shop löschen (falls dort noch da), auch ohne Wahl
    expect(diffGallery([row("r1", "a", 0, "m1", false, true)], inp([])).tombstone).toEqual(["r1"]);
    // frühere Form (nur Liste) und alles, was nicht ausdrücklich gewählt ist: nichts im Shop löschen
    expect(diffGallery(rows, inp([])).detach.sort()).toEqual(["r1", "r2", "r3"]);
    expect(diffGallery(rows, inp([])).tombstone).toEqual([]);
  });

  it("Eingabe aus dem Formular wird streng geprüft", () => {
    // frühere Form: nur die Liste
    expect(parseGalleryInput(JSON.stringify([U(1), U(2), U(1)]))).toEqual({ files: [U(1), U(2)], hidden: [], drop: [] });
    expect(parseGalleryInput(JSON.stringify(Array.from({ length: 14 }, (_, i) => U(i))))!.files).toHaveLength(10);
    expect(parseGalleryInput("[]")).toEqual({ files: [], hidden: [], drop: [] });
    // neue Form: hidden nur aus der Liste, drop nie aus der Liste
    expect(parseGalleryInput(JSON.stringify({ files: [U(1), U(2)], hidden: [U(2), U(9)], drop: [U(3), U(1), U(3)] })))
      .toEqual({ files: [U(1), U(2)], hidden: [U(2)], drop: [U(3)] });
    expect(parseGalleryInput(JSON.stringify({ files: [U(1)] }))).toEqual({ files: [U(1)], hidden: [], drop: [] });
    expect(parseGalleryInput(JSON.stringify({ files: [U(1)], drop: ["../x"] }))).toBeNull();
    expect(parseGalleryInput(JSON.stringify({ hidden: [U(1)] }))).toBeNull();
    expect(parseGalleryInput(JSON.stringify(["../etc/passwd"]))).toBeNull();
    expect(parseGalleryInput(JSON.stringify([1]))).toBeNull();
    expect(parseGalleryInput("{kaputt")).toBeNull();
    expect(parseGalleryInput("null")).toBeNull();
    expect(parseGalleryInput(null)).toBeNull();
  });

  it("Plan für den Shop: löschen, hochladen, im Shop von Hand gelöschte neu hochladen", () => {
    const rows = [row("r1", "a", 0, "m1"), row("r2", "b", 1), row("r3", "c", 2, "m3"), row("t1", "x", 0, "mx", true), row("t2", "y", 0, "gone", true)];
    const p = planGallery(rows, ["m1", "fremd", "mx"]);
    expect(p.remove).toEqual(["mx"]);
    expect(p.unlink).toEqual([]);
    expect(p.dropTombstones).toEqual(["t2"]);
    expect(p.upload.map((r) => r.id)).toEqual(["r2", "r3"]); // r3: Medium m3 gibt es im Shop nicht mehr
    expect(p.lost.map((r) => r.id)).toEqual(["r3"]);
  });

  it("Plan: „nur aus dem Shop“ genommene werden dort gelöscht, bleiben bei uns und werden nie hochgeladen", () => {
    const rows = [row("h1", "a", 0, "m1", false, true), row("h2", "b", 1, "weg", false, true), row("h3", "c", 2, "", false, true), row("r4", "d", 3, "m4")];
    const p = planGallery(rows, ["m1", "m4"]);
    expect(p.remove).toEqual(["m1"]);
    expect(p.unlink.sort()).toEqual(["h1", "h2"]); // h2: im Shop schon weg → nur media_id leeren
    expect(p.upload).toEqual([]);
    expect(p.lost).toEqual([]);
    // „wieder in den Shop“ (hidden false, ohne Medium) → hochladen
    expect(planGallery([row("h3", "c", 0)], []).upload.map((r) => r.id)).toEqual(["h3"]);
  });

  it("Reihenfolge: unsere Galerie vorne, fremde Medien behalten ihre Reihenfolge; nur nötige Verschiebungen", () => {
    expect(reorderMoves(["v1", "a", "b"], ["a", "b"])).toEqual([{ id: "a", newPosition: "0" }, { id: "b", newPosition: "1" }]);
    expect(reorderMoves(["a", "b", "v1"], ["a", "b"])).toEqual([]);
    expect(reorderMoves(["a", "b", "c"], ["c", "a", "b"])).toEqual([{ id: "c", newPosition: "0" }]);
    expect(reorderMoves(["b", "a"], ["a", "x", "b"])).toEqual([{ id: "a", newPosition: "0" }]); // x fehlt im Shop → übersprungen
    // Ergebnis prüfen: Verschiebungen nacheinander anwenden
    const apply = (list: string[], moves: { id: string; newPosition: string }[]) => moves.reduce((l, m) => {
      const x = l.filter((id) => id !== m.id); x.splice(Number(m.newPosition), 0, m.id); return x;
    }, list);
    const cur = ["h1", "c", "h2", "a", "b"];
    expect(apply(cur, reorderMoves(cur, ["a", "b", "c"]))).toEqual(["a", "b", "c", "h1", "h2"]);
  });

  it("neue Medien erkennen und Liste nach Änderungen", () => {
    expect(newMediaIds(["m1", "m2"], ["m1", "m2", "n1", "n2"])).toEqual(["n1", "n2"]);
    expect(afterChanges(["m1", "m2", "m3"], ["m2"], ["n1"])).toEqual(["m1", "m3", "n1"]);
  });

  it("Fotos eines neuen Shop-Produkts: Galerie statt Lagerfoto, Variantenfotos dahinter, ohne Doppelte", () => {
    expect(productFiles(["g1", "g2"], "lager", ["v1", null, "g1"])).toEqual(["g1", "g2", "v1"]);
    expect(productFiles([], "lager", ["v1"])).toEqual(["lager", "v1"]);
    expect(productFiles([], null, [null])).toEqual([]);
  });

  it("nach dem Anlegen: Galerie-Datei → Medium über die Reihenfolge; abweichende Anzahl wird gemeldet", () => {
    const a = mapCreatedMedia(["g1", "g2", "v1"], ["m1", "m2", "m3"], ["g1", "g2"]);
    expect(Object.fromEntries(a.map)).toEqual({ g1: "m1", g2: "m2" });
    expect(a.exact).toBe(true);
    const b = mapCreatedMedia(["g1", "g2", "v1"], ["m1"], ["g1", "g2"]);
    expect(Object.fromEntries(b.map)).toEqual({ g1: "m1" });
    expect(b.exact).toBe(false);
  });
});

describe("Kategorien im Shop", () => {
  const types = [
    { type: "Barberstuhl", collection: "Barberstühle" },
    { type: "Werkzeug & Zubehör", collection: "Werkzeug & Zubehör" },
    { type: "Pflege & Verbrauch", collection: null },
  ];

  it("Zustand einer Kategorie je Shop: gleicher Name, zugeordnet oder fehlt", () => {
    expect(categoryStoreState("barberstühle", types, {})).toEqual({ state: "same", type: "Barberstuhl", label: "Barberstühle" });
    expect(categoryStoreState("Barberstuhl", types, {})).toEqual({ state: "same", type: "Barberstuhl", label: "Barberstühle" });
    expect(categoryStoreState("Kämme", types, { "Kämme": "Werkzeug & Zubehör" })).toEqual({ state: "mapped", type: "Werkzeug & Zubehör", label: "Werkzeug & Zubehör" });
    expect(categoryStoreState("Kämme", types, {})).toEqual({ state: "missing" });
    expect(categoryStoreState("Kämme", [], {})).toEqual({ state: "missing" });
    expect(cleanCategoryName("  Barber   Zubehör ")).toBe("Barber Zubehör");
    expect(collectionInput("Scheren")).toEqual({ title: "Scheren", ruleSet: { appliedDisjunctively: false, rules: [{ column: "TYPE", relation: "EQUALS", condition: "Scheren" }] } });
  });

  // so sieht das Hauptmenü des allgemeinen Shops aus (gekürzt)
  const menu: MenuItem[] = [
    { id: "g1", title: "Salonmöbel", type: "CATALOG", resourceId: null, url: "/collections/all", tags: [], items: [
      { id: "i1", title: "Barberstühle", type: "COLLECTION", resourceId: "col/1", url: "/collections/barberstuehle", tags: [], items: [] },
    ] },
    { id: "g2", title: "Technik & Licht", type: "CATALOG", resourceId: null, url: "/collections/all", tags: ["x"], items: [
      { id: "i2", title: "Maschinen & Föhne", type: "COLLECTION", resourceId: "col/2", url: "/collections/maschinen-foehne", tags: [], items: [] },
    ] },
    { id: "p1", title: "FAQ", type: "PAGE", resourceId: "page/1", url: "/pages/faq", tags: [], items: [] },
  ];

  it("Gruppen = oberste Punkte mit Unterpunkten", () => {
    expect(menuGroups(menu)).toEqual([{ id: "g1", title: "Salonmöbel" }, { id: "g2", title: "Technik & Licht" }]);
    expect(menuDepth(menu)).toBe(2);
    expect(menuHas(menu, "col/2")).toBe(true);
    expect(menuHas(menu, "col/9")).toBe(false);
  });

  it("neuer Punkt kommt hinten unter die Gruppe; alles andere bleibt genau gleich (IDs, Links, Tags)", () => {
    const out = menuWithCollection(menu, "g2", { title: "Scheren", id: "col/9", handle: "scheren" })!;
    const before = menuToInput(menu);
    expect(out[0]).toEqual(before[0]);
    expect(out[2]).toEqual(before[2]);
    expect(out[1].items).toEqual([...before[1].items, { title: "Scheren", type: "COLLECTION", resourceId: "col/9", url: "/collections/scheren", tags: [], items: [] }]);
    expect(out[1]).toMatchObject({ id: "g2", title: "Technik & Licht", type: "CATALOG", url: "/collections/all", tags: ["x"] });
    expect(out[1]).not.toHaveProperty("resourceId");
    expect(menuWithCollection(menu, "", { title: "Scheren", id: "col/9", handle: "scheren" })!.at(-1)).toMatchObject({ title: "Scheren" });
    expect(menuWithCollection(menu, "gibt-es-nicht", { title: "S", id: "c", handle: "s" })).toBeNull();
    // Original unverändert
    expect(menu[1].items).toHaveLength(1);
  });

  it("Punkt einer Kollektion entfernen – nie, wenn er Unterpunkte hat", () => {
    const r = menuWithout(menu, "col/1");
    expect(r).toMatchObject({ removed: 1, blocked: false });
    expect(r.items[0].items).toEqual([]);
    expect(r.items[1]).toEqual(menuToInput(menu)[1]);
    expect(menuWithout(menu, "col/x").removed).toBe(0);
    const nested: MenuItem[] = [{ ...menu[0], resourceId: "col/g" }];
    expect(menuWithout(nested, "col/g")).toMatchObject({ removed: 0, blocked: true });
  });
});

describe("Ergebnis „Kategorie im Shop anlegen“ in der Adresszeile", () => {
  it("hin und zurück, Unbekanntes wird verworfen", async () => {
    const { encodeStoreResults, decodeStoreResults } = await import("../src/lib/shopify/category-map");
    const r = [{ channel: "GENERAL_SHOP" as const, outcome: "created" as const, menu: "noAccess" as const }, { channel: "BRAND_SHOP" as const, outcome: "failed" as const }];
    expect(decodeStoreResults(encodeStoreResults(r))).toEqual(r);
    expect(decodeStoreResults("EVIL.created.added~GENERAL_SHOP.<script>.x")).toEqual([]);
    expect(decodeStoreResults("GENERAL_SHOP.exists.evil")).toEqual([{ channel: "GENERAL_SHOP", outcome: "exists" }]);
    expect(decodeStoreResults(undefined)).toEqual([]);
  });
});
