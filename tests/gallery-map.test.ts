import { describe, expect, it } from "vitest";
import {
  afterChanges, diffGallery, mapCreatedMedia, newMediaIds, parseGalleryInput, planGallery, productFiles, reorderMoves, type GalleryRow,
} from "../src/lib/shopify/gallery-map";
import {
  categoryStoreState, cleanCategoryName, collectionInput, menuDepth, menuGroups, menuHas, menuToInput, menuWithCollection, menuWithout, type MenuItem,
} from "../src/lib/shopify/category-map";

const row = (id: string, fileId: string, position: number, mediaId = "", removed = false): GalleryRow => ({ id, fileId, position, mediaId, removed });
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("Shop-Galerie", () => {
  it("Formular → Datenbank: bleiben, neu, entfernt (mit Medium → Löschmarke, ohne → weg)", () => {
    const rows = [row("r1", "a", 0, "m1"), row("r2", "b", 1), row("r3", "c", 2, "m3"), row("rx", "x", 0, "mx", true)];
    const d = diffGallery(rows, ["c", "d", "a"]);
    expect(d.keep).toEqual([{ id: "r3", position: 0 }, { id: "r1", position: 2 }]);
    expect(d.add).toEqual([{ fileId: "d", position: 1 }]);
    expect(d.tombstone).toEqual([]);
    expect(d.drop).toEqual(["r2"]);
    expect(d.changed).toBe(true);
    expect(diffGallery(rows, ["d"]).tombstone.sort()).toEqual(["r1", "r3"]);
    // unverändert
    expect(diffGallery([row("r1", "a", 0, "m1"), row("r2", "b", 1)], ["a", "b"]).changed).toBe(false);
    // nur umsortiert
    expect(diffGallery([row("r1", "a", 0, "m1"), row("r2", "b", 1)], ["b", "a"])).toMatchObject({ changed: true, add: [], drop: [], tombstone: [] });
    // gleiche Datei doppelt in der Datenbank → die zweite fliegt raus
    expect(diffGallery([row("r1", "a", 0), row("r2", "a", 1)], ["a"]).drop).toEqual(["r2"]);
  });

  it("Eingabe aus dem Formular wird streng geprüft", () => {
    expect(parseGalleryInput(JSON.stringify([U(1), U(2), U(1)]))).toEqual([U(1), U(2)]);
    expect(parseGalleryInput(JSON.stringify(Array.from({ length: 14 }, (_, i) => U(i))))).toHaveLength(10);
    expect(parseGalleryInput("[]")).toEqual([]);
    expect(parseGalleryInput(JSON.stringify(["../etc/passwd"]))).toBeNull();
    expect(parseGalleryInput(JSON.stringify([1]))).toBeNull();
    expect(parseGalleryInput("{kaputt")).toBeNull();
    expect(parseGalleryInput(null)).toBeNull();
  });

  it("Plan für den Shop: löschen, hochladen, im Shop von Hand gelöschte neu hochladen", () => {
    const rows = [row("r1", "a", 0, "m1"), row("r2", "b", 1), row("r3", "c", 2, "m3"), row("t1", "x", 0, "mx", true), row("t2", "y", 0, "gone", true)];
    const p = planGallery(rows, ["m1", "fremd", "mx"]);
    expect(p.remove).toEqual(["mx"]);
    expect(p.dropTombstones).toEqual(["t2"]);
    expect(p.upload.map((r) => r.id)).toEqual(["r2", "r3"]); // r3: Medium m3 gibt es im Shop nicht mehr
    expect(p.lost.map((r) => r.id)).toEqual(["r3"]);
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
