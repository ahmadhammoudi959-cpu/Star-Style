import { describe, expect, it } from "vitest";
import { uniquePhotos } from "../src/lib/product-photos";

describe("Fotos eines Artikels für die Kundenansicht", () => {
  it("Reihenfolge bleibt, gleiche Datei/gleicher Inhalt nur einmal, nur Bilder, höchstens max", () => {
    const rows = [
      { fileId: "a", sha256: "s1", mime: "image/jpeg" },
      { fileId: "b", sha256: "s2", mime: "image/webp" },
      { fileId: "a", sha256: "s1", mime: "image/jpeg" }, // gleiche Datei (Lagerfoto auch in der Shop-Galerie)
      { fileId: "c", sha256: "s1", mime: "image/png" }, // gleicher Inhalt, andere Datei
      { fileId: "d", sha256: "s4", mime: "application/pdf" },
      { fileId: "e", sha256: "s5", mime: "image/png" },
    ];
    expect(uniquePhotos(rows)).toEqual(["a", "b", "e"]);
    expect(uniquePhotos(rows, 2)).toEqual(["a", "b"]);
    expect(uniquePhotos([])).toEqual([]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Fotos eines Artikels (Datenbank)", () => {
  it("Lagerfoto, Varianten-Fotos, dann Shop-Fotos – ohne gelöschte/„nur im Shop gelöschte“ und ohne Doppelte", async () => {
    const { db, schema } = await import("../src/db");
    const { productPhotoIds } = await import("../src/lib/product-photos");
    const r = crypto.randomUUID().slice(0, 8);
    const file = async (tag: string, sha = tag) => (await db.insert(schema.storedFiles).values({
      name: `${tag}.png`, mime: "image/png", size: 4, sha256: `${r}-${sha}`, data: Buffer.from(tag),
    }).returning())[0].id;
    const main = await file("main"), red = await file("red"), g1 = await file("g1"), g2 = await file("g2");
    const copyOfMain = await file("copy", "main"), gone = await file("gone"), hid = await file("hid"), brand = await file("brand");
    const [p] = await db.insert(schema.products).values({ sku: `PH-${r}`, nameDe: "Fototest", vatRateBp: 1900, imageFileId: main }).returning();
    await db.insert(schema.variants).values([{ productId: p.id, color: "Rot", imageFileId: red }, { productId: p.id, color: "Blau" }]);
    await db.insert(schema.shopMedia).values([
      { productId: p.id, channel: "BRAND_SHOP", fileId: brand, position: 0 },
      { productId: p.id, channel: "GENERAL_SHOP", fileId: g2, position: 1 },
      { productId: p.id, channel: "GENERAL_SHOP", fileId: g1, position: 0 },
      { productId: p.id, channel: "GENERAL_SHOP", fileId: copyOfMain, position: 2 },
      { productId: p.id, channel: "GENERAL_SHOP", fileId: gone, position: 3, removed: true },
      { productId: p.id, channel: "GENERAL_SHOP", fileId: hid, position: 4, hidden: true },
    ]);
    expect(await productPhotoIds(p.id)).toEqual([main, red, g1, g2, brand]);
    expect(await productPhotoIds("gibt-es-nicht")).toEqual([]);
  });
});
