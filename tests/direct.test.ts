import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db";
import sharp from "sharp";
import {
  DIRECT_PHOTO_LIMITS, applyProblems, cartProblems, cartTotals, catalogCategories, directLinkUrl, directState, lineDescription, listTotals, looksLikeToken,
  manualPrice, mergeCart, photoLimited, priceRange, productInStock, rateLimited, searchCatalog, type CatalogProduct,
} from "../src/lib/direct-rules";
import { parseDirectOrder, type DirectOrderInput } from "../src/lib/direct-input";

// Direktverkauf über den Bestell-Link (Wunsch Inhaber 19.11.2026)
const prod = (o: Partial<CatalogProduct> & { id: string }): CatalogProduct => ({
  name: "Schere", category: "Werkzeug", sku: "SCH-1", description: "", imageId: null, variants: [], ...o,
});
const v = (id: string, priceCents: number, inStock = true, extra: Partial<CatalogProduct["variants"][number]> = {}) => ({
  id, size: "", color: "", barcode: "", priceCents, grossCents: Math.round(priceCents * 1.19), vatRateBp: 1900, imageId: null, inStock, ...extra,
});

describe("Bestell-Link – Regeln (rein)", () => {
  it("Warenkorb: gleiche Variante zusammen, Unsinn weg, höchstens 999 je Position", () => {
    expect(mergeCart([{ variantId: "a", qty: 2 }, { variantId: "b", qty: 1 }, { variantId: "a", qty: 3 }])).toEqual([{ variantId: "a", qty: 5 }, { variantId: "b", qty: 1 }]);
    expect(mergeCart([{ variantId: "a", qty: 0 }, { variantId: "", qty: 1 }, { variantId: "c", qty: 1.5 }, { variantId: "d", qty: -2 }])).toEqual([]);
    expect(mergeCart([{ variantId: "a", qty: 900 }, { variantId: "a", qty: 900 }])).toEqual([{ variantId: "a", qty: 999 }]);
    expect(mergeCart(Array.from({ length: 150 }, (_, i) => ({ variantId: `v${i}`, qty: 1 })))).toHaveLength(100);
  });

  it("Prüfung gegen den Bestand: nicht verfügbar → 0, zu viel → verfügbare Menge; Liste wird angepasst", () => {
    const avail = new Map([["a", 3], ["b", 0], ["c", 10]]);
    const lines = [{ variantId: "a", qty: 5 }, { variantId: "b", qty: 1 }, { variantId: "c", qty: 2 }, { variantId: "x", qty: 1 }];
    const p = cartProblems(lines, avail);
    expect(p).toEqual([{ variantId: "a", available: 3 }, { variantId: "b", available: 0 }, { variantId: "x", available: 0 }]);
    expect(applyProblems(lines, p)).toEqual([{ variantId: "a", qty: 3 }, { variantId: "c", qty: 2 }]);
    expect(cartProblems([{ variantId: "c", qty: 10 }], avail)).toEqual([]);
    expect(cartProblems([{ variantId: "a", qty: 1 }], new Map([["a", -4]]))).toEqual([{ variantId: "a", available: 0 }]); // Bestand negativ
  });

  it("Summen wie auf der Rechnung: netto je Position, USt je Satz", () => {
    const t = cartTotals([{ qty: 2, priceCents: 10_00, vatRateBp: 1900 }, { qty: 1, priceCents: 5_00, vatRateBp: 700 }]);
    expect(t).toMatchObject({ netCents: 25_00, vatCents: 3_80 + 35, grossCents: 29_15 });
  });

  it("Begrenzung je Netz, E-Mail und insgesamt", () => {
    const ok = { ipHour: 0, ipDay: 0, emailDay: 0, allHour: 0 };
    expect(rateLimited(ok)).toBe(false);
    expect(rateLimited({ ...ok, ipHour: 6 })).toBe(true);
    expect(rateLimited({ ...ok, ipHour: 5, ipDay: 19, emailDay: 9, allHour: 59 })).toBe(false);
    expect(rateLimited({ ...ok, ipDay: 20 })).toBe(true);
    expect(rateLimited({ ...ok, emailDay: 10 })).toBe(true);
    expect(rateLimited({ ...ok, allHour: 60 })).toBe(true);
  });

  it("Stand: Angebot/Entwurf gelöscht = wieder offen", () => {
    expect(directState({ status: "NEW", invoiceId: null, offerId: null })).toBe("new");
    expect(directState({ status: "CONVERTED", invoiceId: "i", offerId: null })).toBe("done");
    expect(directState({ status: "CONVERTED", invoiceId: null, offerId: "o" })).toBe("done");
    expect(directState({ status: "CONVERTED", invoiceId: null, offerId: null })).toBe("new");
    expect(directState({ status: "REJECTED", invoiceId: null, offerId: null })).toBe("rejected");
  });

  it("Katalog: Suche (exakter Barcode zuerst), Kategorien, Preis „ab“, verfügbar", () => {
    const a = prod({ id: "1", name: "Barberstuhl Baron", category: "Barberstühle", sku: "DBC011", variants: [v("a1", 450_00, false, { color: "Schwarz", barcode: "8720" }), v("a2", 420_00, true, { color: "Braun" })] });
    const b = prod({ id: "2", name: "Kamm Set", category: "Werkzeug", sku: "K-8720", variants: [v("b1", 5_00)] });
    const c = prod({ id: "3", name: "Umhang", category: "", sku: "U1", variants: [v("c1", 9_00, false)] });
    expect(searchCatalog([a, b, c], "8720").map((p) => p.id)).toEqual(["1", "2"]);
    expect(searchCatalog([a, b, c], "braun").map((p) => p.id)).toEqual(["1"]);
    expect(searchCatalog([a, b, c], "", "Werkzeug").map((p) => p.id)).toEqual(["2"]);
    expect(catalogCategories([a, b, c])).toEqual([{ name: "Barberstühle", n: 1 }, { name: "Werkzeug", n: 1 }]);
    expect(priceRange(a)).toMatchObject({ min: 420_00, max: 450_00 });
    expect([productInStock(a), productInStock(c)]).toEqual([true, false]);
    expect(lineDescription("Barberstuhl Baron", { size: "", color: "Braun" })).toBe("Barberstuhl Baron (Braun)");
    expect(lineDescription("Kamm", { size: " ", color: "" })).toBe("Kamm");
  });

  it("Token-Form, Link-Adresse", () => {
    expect(looksLikeToken("abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(looksLikeToken("abc")).toBe(false);
    expect(looksLikeToken("abcdefghijklmnopqrstuv/x")).toBe(false);
    expect(directLinkUrl("https://star-style.onrender.com/", "T0k")).toBe("https://star-style.onrender.com/b/T0k");
  });
});

describe("Bestell-Link – Eingaben (rein)", () => {
  const good = { name: " Ali ", email: " Ali@Example.DE ", elapsedMs: 9000, lang: "ar", lines: [{ variantId: "a", qty: 2 }, { variantId: "a", qty: 1 }] };
  it("Pflicht: Name, E-Mail, mindestens eine Position; Rest freiwillig", () => {
    const r = parseDirectOrder(good);
    if (!r.ok) throw new Error(r.field);
    expect(r.data).toMatchObject({ name: "Ali", email: "ali@example.de", company: "", country: "DE", website: "", lang: "ar", lines: [{ variantId: "a", qty: 3 }] });
    expect(parseDirectOrder({ ...good, name: " " })).toEqual({ ok: false, field: "name" });
    expect(parseDirectOrder({ ...good, email: "ali@" })).toEqual({ ok: false, field: "email" });
    expect(parseDirectOrder({ ...good, lines: [] })).toEqual({ ok: false, field: "lines" });
    expect(parseDirectOrder({ ...good, lines: [{ variantId: "a", qty: 0 }] })).toEqual({ ok: false, field: "lines" });
  });
  it("Telefon nur Ziffern und Zeichen, USt-IdNr. bereinigt, Länge begrenzt, Steuerzeichen weg", () => {
    expect(parseDirectOrder({ ...good, phone: "0178 5571725" })).toMatchObject({ ok: true });
    expect(parseDirectOrder({ ...good, phone: "call me" })).toEqual({ ok: false, field: "phone" });
    const r = parseDirectOrder({ ...good, vatId: "de 123.456-789", note: "a\u0000b".padEnd(1500, "x"), company: "Salon\u0007 Nour" });
    if (!r.ok) throw new Error(r.field);
    expect(r.data.vatId).toBe("DE123456789");
    expect(r.data.note.length).toBe(1000);
    expect(r.data.company).toBe("Salon Nour");
    expect(parseDirectOrder({ ...good, vatId: "DE<script>" })).toEqual({ ok: false, field: "vatId" });
    expect(parseDirectOrder({ ...good, note: "x".repeat(3000) })).toEqual({ ok: false, field: "note" }); // viel zu lang = gar nicht erst annehmen
    expect(parseDirectOrder({ ...good, country: "Deutschland" })).toEqual({ ok: false, field: "country" });
    expect(parseDirectOrder({ ...good, lang: "fr" })).toEqual({ ok: false, field: "lang" });
  });
});

describe("Artikel von Hand – Regeln (rein)", () => {
  it("Preis: leer = auf Anfrage, deutsch/englisch, Unsinn und Tippfehler (zu hoch) abgelehnt", () => {
    expect(manualPrice("")).toBeNull();
    expect(manualPrice("  ")).toBeNull();
    expect(manualPrice("12,50")).toBe(12_50);
    expect(manualPrice("12.5")).toBe(12_50);
    expect(manualPrice("1.234,50 €")).toBe(1234_50);
    expect(manualPrice("1,234.50")).toBe(1234_50);
    expect(manualPrice("0")).toBe(0);
    expect(manualPrice("-3")).toBe("bad");
    expect(manualPrice("zwölf")).toBe("bad");
    expect(manualPrice("12,345")).toBe("bad");
    expect(manualPrice("100000,01")).toBe("bad");
  });
  it("Summen: Artikel von Hand mit Preis zählen mit 19 %, ohne Preis nicht", () => {
    const t = listTotals([{ qty: 1, priceCents: 10_00, vatRateBp: 1900 }], [{ qty: 2, priceCents: 5_00 }, { qty: 3, priceCents: null }, { qty: 1, priceCents: 0 }]);
    expect(t).toMatchObject({ netCents: 20_00, vatCents: 3_80, grossCents: 23_80 });
  });
  it("Fotos: Begrenzung je Netz und insgesamt (24 Stunden)", () => {
    expect(photoLimited({ ipDay: 0, allDay: 0 }, 0)).toBe(false);
    expect(photoLimited({ ipDay: DIRECT_PHOTO_LIMITS.perIpDay - 2, allDay: 0 }, 2)).toBe(false);
    expect(photoLimited({ ipDay: DIRECT_PHOTO_LIMITS.perIpDay - 2, allDay: 0 }, 3)).toBe(true);
    expect(photoLimited({ ipDay: 0, allDay: DIRECT_PHOTO_LIMITS.allDay }, 1)).toBe(true);
  });
  it("Eingaben: nur Artikel von Hand reicht; Name Pflicht, höchstens 10, Foto-Feldnamen p0 … eindeutig", () => {
    const base = { name: "Ali", email: "ali@example.de", elapsedMs: 9000 };
    const m = { name: " Stuhl\u0007 ", qty: 2, priceCents: 120_00, size: "XL", color: " Rot ", photo: "p0" };
    const r = parseDirectOrder({ ...base, manual: [m] });
    if (!r.ok) throw new Error(r.field);
    expect(r.data.lines).toEqual([]);
    expect(r.data.manual).toEqual([{ name: "Stuhl", qty: 2, priceCents: 120_00, size: "XL", color: "Rot", photo: "p0" }]);
    expect(parseDirectOrder({ ...base, manual: [{ name: "Kamm", qty: 1 }] })).toMatchObject({ ok: true, data: { manual: [{ priceCents: null, photo: null, size: "", color: "" }] } });
    expect(parseDirectOrder(base)).toEqual({ ok: false, field: "lines" });
    expect(parseDirectOrder({ ...base, manual: [{ ...m, name: "  " }] })).toEqual({ ok: false, field: "manual" });
    expect(parseDirectOrder({ ...base, manual: [{ ...m, qty: 0 }] })).toEqual({ ok: false, field: "manual" });
    expect(parseDirectOrder({ ...base, manual: [{ ...m, priceCents: -1 }] })).toEqual({ ok: false, field: "manual" });
    expect(parseDirectOrder({ ...base, manual: [{ ...m, photo: "../etc" }] })).toEqual({ ok: false, field: "manual" });
    expect(parseDirectOrder({ ...base, manual: [m, { ...m }] })).toEqual({ ok: false, field: "manual" }); // gleiches Foto zweimal
    expect(parseDirectOrder({ ...base, manual: Array.from({ length: 11 }, () => ({ name: "x", qty: 1 })) })).toEqual({ ok: false, field: "manual" });
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Bestell-Link (Datenbank)", () => {
  type Lib = typeof import("../src/lib/direct");
  let L: Lib;
  let admin = "", vIn = "", vOut = "", vHidden = "", pIn = "", photo = "", cust = "", custW = "";
  const ip = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const input = (lines: { variantId: string; qty: number }[], email = `kunde${crypto.randomUUID().slice(0, 6)}@example.de`) => ({
    name: "Nour", email, company: "Salon Nour", phone: "", street: "", zip: "", city: "", country: "DE", vatId: "", note: "Abholung Samstag",
    website: "", elapsedMs: 9000, lang: "ar" as const, lines, manual: [] as DirectOrderInput["manual"],
  });

  beforeAll(async () => {
    L = await import("../src/lib/direct");
    // Begrenzung zählt die letzten 24 Stunden – frühere Testläufe auf derselben Test-DB nicht mitzählen
    await db.execute(sql`update direct_orders set created_at = created_at - interval '2 days'`);
    await db.insert(schema.companySettings).values({ id: "company", name: "Test GmbH" }).onConflictDoNothing();
    admin = (await db.insert(schema.users).values({ email: `direct-${crypto.randomUUID().slice(0, 8)}@example.com`, name: "Direkt", passwordHash: "x", isAdmin: true }).returning())[0].id;
    const tag = crypto.randomUUID().slice(0, 6);
    const [f] = await db.insert(schema.storedFiles).values({ name: "a.webp", mime: "image/webp", size: 1, data: Buffer.from("x"), sha256: crypto.randomUUID() }).returning();
    photo = f.id;
    const [p1] = await db.insert(schema.products).values({ sku: `DIR-${tag}`, nameDe: "Färbepinsel", category: "Zubehör", vatRateBp: 1900, retailPriceCents: 4_00, wholesalePriceCents: 3_00, imageFileId: photo, inGeneralShop: true }).returning();
    pIn = p1.id;
    vIn = (await db.insert(schema.variants).values({ productId: p1.id, color: "Schwarz", barcode: `DI${tag}1` }).returning())[0].id;
    vOut = (await db.insert(schema.variants).values({ productId: p1.id, color: "Weiß", barcode: `DI${tag}2` }).returning())[0].id;
    const [p2] = await db.insert(schema.products).values({ sku: `DIRX-${tag}`, nameDe: "Intern", vatRateBp: 1900, retailPriceCents: 9_00, inGeneralShop: false, inBrandShop: false }).returning();
    vHidden = (await db.insert(schema.variants).values({ productId: p2.id, barcode: `DI${tag}3` }).returning())[0].id;
    const { receiveGoods } = await import("../src/lib/stock");
    await receiveGoods({ date: new Date().toISOString().slice(0, 10), lines: [{ variantId: vIn, qty: 10, unitCostCents: 1_00 }, { variantId: vHidden, qty: 5, unitCostCents: 1_00 }] });
    cust = (await db.insert(schema.customers).values({ name: "Salon Nour " + tag, country: "DE", priceGroup: "RETAIL" }).returning())[0].id;
    custW = (await db.insert(schema.customers).values({ name: "Händler " + tag, country: "DE", priceGroup: "WHOLESALE" }).returning())[0].id;
  });

  it("Links je Preisgruppe: erstellen, ausschalten, erneuern (alter gilt nicht mehr); Token nie im Protokoll", async () => {
    const t1 = await L.newDirectLink("RETAIL", admin);
    expect(await L.linkGroup(t1)).toBe("RETAIL");
    const tw = await L.newDirectLink("WHOLESALE", admin);
    expect(await L.linkGroup(tw)).toBe("WHOLESALE");
    await L.setDirectLinkOn("RETAIL", false, admin);
    expect(await L.linkGroup(t1)).toBeNull();
    await L.setDirectLinkOn("RETAIL", true, admin);
    const t2 = await L.newDirectLink("RETAIL", admin);
    expect(await L.linkGroup(t1)).toBeNull();
    expect(await L.linkGroup(t2)).toBe("RETAIL");
    expect(await L.linkGroup("x".repeat(24))).toBeNull();
    const info = await L.directLinks();
    expect(info.find((l) => l.group === "RETAIL")).toMatchObject({ exists: true, on: true, token: t2 });
    const logged = await db.execute<{ n: string }>(sql`select count(*) as n from audit_log where entity = 'settings' and entity_id like 'direct_link/%' and (before::text like ${"%" + t2 + "%"} or after::text like ${"%" + t2 + "%"})`);
    expect(Number(logged.rows[0].n)).toBe(0);
  });

  it("Katalog: nur aktive, in einem Shop sichtbare Artikel mit Preis; Preis je Link; keine Bestandszahl; nur Katalog-Fotos", async () => {
    const retail = await L.publicCatalog("RETAIL");
    const p = retail.find((x) => x.id === pIn)!;
    expect(p.variants.map((x) => [x.id, x.priceCents, x.inStock])).toEqual([[vIn, 4_00, true], [vOut, 4_00, false]]);
    // nie Bestandszahl, Einkaufspreis oder Großhandelspreis im Browser – nur diese Felder
    expect(Object.keys(p.variants[0]).sort()).toEqual(["barcode", "color", "grossCents", "id", "imageId", "inStock", "priceCents", "size", "vatRateBp"]);
    expect(Object.keys(p).sort()).toEqual(["category", "description", "id", "imageId", "name", "sku", "variants"]);
    expect(retail.some((x) => x.variants.some((y) => y.id === vHidden))).toBe(false);
    expect((await L.publicCatalog("WHOLESALE")).find((x) => x.id === pIn)!.variants[0].priceCents).toBe(3_00);
    expect(await L.isCatalogPhoto(photo)).toBe(true);
    const other = (await db.insert(schema.storedFiles).values({ name: "beleg.pdf", mime: "application/pdf", size: 1, data: Buffer.from("x"), sha256: crypto.randomUUID() }).returning())[0].id;
    expect(await L.isCatalogPhoto(other)).toBe(false);
    expect(await L.catalogPhotoIds(pIn)).toEqual([photo]);
  });

  it("Absenden: zu schnell = Programm, nicht verfügbar → Mengen zurück, sonst Liste mit Preisen des Links", async () => {
    await expect(L.submitDirectOrder({ ...input([{ variantId: vIn, qty: 1 }]), elapsedMs: 500 }, { ip: ip(), group: "RETAIL" })).rejects.toMatchObject({ code: "bot" });
    await expect(L.submitDirectOrder({ ...input([{ variantId: vIn, qty: 1 }]), website: "spam" }, { ip: ip(), group: "RETAIL" })).rejects.toMatchObject({ code: "bot" });
    await expect(L.submitDirectOrder(input([{ variantId: vIn, qty: 12 }, { variantId: vOut, qty: 1 }, { variantId: vHidden, qty: 1 }]), { ip: ip(), group: "RETAIL" }))
      .rejects.toMatchObject({ code: "unavailable", problems: [{ variantId: vIn, available: 10 }, { variantId: vOut, available: 0 }, { variantId: vHidden, available: 0 }] });
    const r = await L.submitDirectOrder(input([{ variantId: vIn, qty: 3 }]), { ip: ip(), group: "WHOLESALE" });
    const o = await db.query.directOrders.findFirst({ where: eq(schema.directOrders.id, r.id), with: { lines: true } });
    expect(o).toMatchObject({ status: "NEW", priceGroup: "WHOLESALE", netCents: 9_00, grossCents: 10_71, customerId: null, invoiceId: null, lang: "ar" });
    expect(o!.lines).toMatchObject([{ variantId: vIn, qty: 3, unitPriceCents: 3_00, description: "Färbepinsel (Schwarz)" }]);
    expect(o!.ipHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("Begrenzung: höchstens 6 Listen je Netz und Stunde", async () => {
    const same = ip();
    for (let i = 0; i < 6; i++) await L.submitDirectOrder(input([{ variantId: vIn, qty: 1 }]), { ip: same, group: "RETAIL" });
    await expect(L.submitDirectOrder(input([{ variantId: vIn, qty: 1 }]), { ip: same, group: "RETAIL" })).rejects.toMatchObject({ code: "rate" });
  });

  it("Rechnung: nur mit gewähltem Kunden, Preise SEINER Preisgruppe; danach erledigt; Entwurf gelöscht = wieder offen", async () => {
    const r = await L.submitDirectOrder(input([{ variantId: vIn, qty: 2 }]), { ip: ip(), group: "RETAIL" });
    const before = await db.execute<{ n: string }>(sql`select count(*) as n from customers`);
    await expect(L.convertDirectOrder(r.id, { customerId: "nope", kind: "invoice" }, admin)).rejects.toMatchObject({ code: "customer" });
    const inv = await L.convertDirectOrder(r.id, { customerId: custW, kind: "invoice" }, admin);
    const draft = await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv), with: { lines: true } });
    expect(draft).toMatchObject({ status: "DRAFT", customerId: custW, channel: "STORE", number: null });
    expect(draft!.lines.map((l) => [l.variantId, l.qty, l.unitPriceCents])).toEqual([[vIn, 2, 3_00]]); // Großhandel: 3 € statt 4 € wie im Link
    expect((await db.execute<{ n: string }>(sql`select count(*) as n from customers`)).rows[0].n).toBe(before.rows[0].n); // legt keinen Kunden an
    expect((await L.directOrderDetail(r.id))!.state).toBe("done");
    await expect(L.convertDirectOrder(r.id, { customerId: cust, kind: "invoice" }, admin)).rejects.toMatchObject({ code: "done" });
    const { deleteDraft } = await import("../src/lib/sales");
    await deleteDraft(inv);
    expect((await L.directOrderDetail(r.id))!.state).toBe("new");
  });

  it("Angebot: reserviert die Ware wie jedes Angebot", async () => {
    const r = await L.submitDirectOrder(input([{ variantId: vIn, qty: 4 }]), { ip: ip(), group: "RETAIL" });
    const off = await L.convertDirectOrder(r.id, { customerId: cust, kind: "offer" }, admin);
    const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, off), with: { lines: true } });
    expect(o).toMatchObject({ customerId: cust, status: "DRAFT" });
    expect(o!.number).toMatch(/^AN-/);
    expect(o!.lines.map((l) => [l.qty, l.unitPriceCents])).toEqual([[4, 4_00]]);
    const res = await db.query.reservations.findMany({ where: eq(schema.reservations.offerId, off) });
    expect(res.map((x) => [x.variantId, x.qty, x.active])).toEqual([[vIn, 4, true]]);
    // reserviert → im Katalog weniger verfügbar (10 − 4 = 6; mehr geht nicht)
    await expect(L.submitDirectOrder(input([{ variantId: vIn, qty: 7 }]), { ip: ip(), group: "RETAIL" })).rejects.toMatchObject({ problems: [{ variantId: vIn, available: 6 }] });
    const row = (await L.listDirectOrders({ state: "done" })).find((x) => x.id === r.id)!;
    expect(row.offer?.number).toBe(o!.number);
    expect(row.customer?.id).toBe(cust);
  });

  // Artikel von Hand (Wunsch Inhaber 20.11.2026): Foto vom Handy (mit GPS in EXIF) → WebP ohne Metadaten, nur Angebot
  const phoneJpeg = () => sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 200, g: 30, b: 40 } } })
    .jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Make: "Testphone", Copyright: "GPS 51.65 N 7.34 E" } } }).toBuffer();

  it("Artikel von Hand: Foto neu gerechnet (gedreht, ≤ 1600 px, WebP, ohne Metadaten), Positionen nach dem Katalog, Summe nur mit Preis", async () => {
    const jpg = await phoneJpeg();
    const r = await L.submitDirectOrder({ ...input([{ variantId: vIn, qty: 1 }]), manual: [
      { name: "Barberstuhl Gold", qty: 2, priceCents: 300_00, size: "XL", color: "Gold", photo: "p0" },
      { name: "Spiegel rund", qty: 1, priceCents: null, size: "", color: "", photo: null },
    ] }, { ip: ip(), group: "RETAIL", photos: new Map([["p0", jpg], ["p7", Buffer.from("nicht gefragt")]]) });
    const o = await db.query.directOrders.findFirst({ where: eq(schema.directOrders.id, r.id), with: { lines: true } });
    expect(o!.netCents).toBe(4_00 + 600_00);
    const ls = [...o!.lines].sort((a, b) => a.position - b.position);
    expect(ls.map((l) => [l.position, l.variantId, l.qty, l.unitPriceCents, l.vatRateBp, l.description, l.manual])).toEqual([
      [1, vIn, 1, 4_00, 1900, "Färbepinsel (Schwarz)", null],
      [2, null, 2, 300_00, 1900, "Barberstuhl Gold (XL · Gold)", { name: "Barberstuhl Gold", size: "XL", color: "Gold" }],
      [3, null, 1, 0, 1900, "Spiegel rund", { name: "Spiegel rund", size: "", color: "" }],
    ]);
    expect(ls[2].photoFileId).toBeNull();
    const f = await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, ls[1].photoFileId!) });
    expect(f).toMatchObject({ mime: "image/webp" });
    const meta = await sharp(Buffer.from(f!.data)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 1200, 1600]); // EXIF-Drehung angewandt (hoch statt quer)
    expect(meta.exif).toBeUndefined();
    expect(Buffer.from(f!.data).includes(Buffer.from("GPS 51.65"))).toBe(false);
    const d = (await L.directOrderDetail(r.id))!;
    expect(d.items.map((i) => [i.manual?.name ?? null, i.imageId === ls[1].photoFileId])).toEqual([[null, false], ["Barberstuhl Gold", true], ["Spiegel rund", false]]);
    const audit = await db.execute<{ after: { manual: number; photos: number } }>(sql`select after from audit_log where entity = 'direct' and entity_id = ${r.id} and action = 'create'`);
    expect(audit.rows[0].after).toMatchObject({ manual: 2, photos: 1 });
    // kein Bild → abgelehnt, nichts gespeichert
    const n = (await db.execute<{ n: string }>(sql`select count(*) as n from direct_orders`)).rows[0].n;
    await expect(L.submitDirectOrder({ ...input([]), manual: [{ name: "X", qty: 1, priceCents: null, size: "", color: "", photo: "p0" }] },
      { ip: ip(), group: "RETAIL", photos: new Map([["p0", Buffer.from("<svg onload=alert(1)>")]]) })).rejects.toMatchObject({ code: "photo" });
    expect((await db.execute<{ n: string }>(sql`select count(*) as n from direct_orders`)).rows[0].n).toBe(n);
  });

  it("Artikel von Hand: nur Angebot (mit Foto); keine Rechnung, bis er als Artikel angelegt und ersetzt ist; Foto-Rechte; Vorbelegung; Löschen", async () => {
    const jpg = await phoneJpeg();
    const r = await L.submitDirectOrder({ ...input([{ variantId: vIn, qty: 1 }]), manual: [{ name: "Waschbecken", qty: 1, priceCents: 250_00, size: "", color: "Weiß", photo: "p0" }] },
      { ip: ip(), group: "WHOLESALE", photos: new Map([["p0", jpg]]) });
    await expect(L.convertDirectOrder(r.id, { customerId: cust, kind: "invoice" }, admin)).rejects.toMatchObject({ code: "manual" });
    const off = await L.convertDirectOrder(r.id, { customerId: cust, kind: "offer" }, admin);
    const o = await db.query.offers.findFirst({ where: eq(schema.offers.id, off), with: { lines: true } });
    const ls = [...o!.lines].sort((a, b) => a.position - b.position);
    const line = (await db.query.directOrderLines.findMany({ where: eq(schema.directOrderLines.orderId, r.id) })).find((l) => l.manual)!;
    expect(ls.map((l) => [l.variantId, l.description, l.unitPriceCents, l.manual, l.photoFileId])).toEqual([
      [vIn, "Färbepinsel (Schwarz)", 4_00, false, null], [null, "Waschbecken (Weiß)", 250_00, true, line.photoFileId],
    ]);
    const { offerToInvoice, saveOffer } = await import("../src/lib/sales");
    await expect(offerToInvoice(off, admin)).rejects.toMatchObject({ code: "manualLines" });
    // Angebots-PDF mit dem Foto (ein Bild mehr als ohne die Zeile von Hand – Logo zählt immer mit)
    const { offerPdf } = await import("../src/lib/pdf");
    const images = async () => Buffer.from(await offerPdf(off)).toString("latin1").split("/Subtype /Image").length - 1;
    const withPhoto = await images();
    // Foto sehen: Direktverkauf bzw. Verkauf ansehen
    const { fileNeed } = await import("../src/lib/file-access");
    expect(await fileNeed(line.photoFileId!)).toEqual(expect.arrayContaining(["direct", "sales.view"]));
    // „Als Artikel anlegen“: Vorbelegung, Foto als eigene Kopie
    expect(await L.manualPrefill(line.id)).toMatchObject({ name: "Waschbecken", color: "Weiß", priceCents: 250_00, priceGroup: "WHOLESALE", photoFileId: line.photoFileId });
    expect(await L.manualPrefill(o!.lines[0].id)).toBeNull();
    const copy = await L.copyManualPhoto(line.photoFileId!);
    expect(copy).not.toBe(line.photoFileId);
    expect(await L.copyManualPhoto(photo)).toBeNull(); // Katalogfoto ist kein Foto von Hand
    // Zeile im Angebot durch einen echten Artikel ersetzt → Rechnung geht
    await saveOffer({ id: off, customerId: cust, date: o!.date, validUntil: o!.validUntil, discountBp: 0, notes: "", lines: [
      { variantId: vIn, description: "Färbepinsel (Schwarz)", qty: 2, unitPriceCents: 4_00, discountBp: 0, vatRateBp: 1900 },
    ] }, admin);
    expect(await images()).toBe(withPhoto - 1);
    const inv = await offerToInvoice(off, admin);
    expect(inv).toBeTruthy();
    // Löschen nach Frist: Foto geht mit, außer es hängt noch woanders (hier: noch am Angebot? nein – ersetzt; Liste erledigt = bleibt)
    const old = await L.submitDirectOrder({ ...input([]), manual: [{ name: "Alt", qty: 1, priceCents: null, size: "", color: "", photo: "p0" }] },
      { ip: ip(), group: "RETAIL", photos: new Map([["p0", jpg]]) });
    const oldPhoto = (await db.query.directOrderLines.findFirst({ where: eq(schema.directOrderLines.orderId, old.id) }))!.photoFileId!;
    await db.update(schema.directOrders).set({ createdAt: new Date(Date.now() - 181 * 86400_000) }).where(eq(schema.directOrders.id, old.id));
    await L.purgeDirectOrders();
    expect(await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, oldPhoto) })).toBeUndefined();
    expect(await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, line.photoFileId!) })).toBeTruthy(); // Liste erledigt → bleibt
  });

  it("Absenden über die Route: multipart mit Foto, fremde Herkunft 403, zu groß 413, kaputtes Formular 400", async () => {
    const { POST } = await import("../src/app/api/b/[token]/order/route");
    const token = await L.newDirectLink("RETAIL", admin);
    const params = Promise.resolve({ token });
    const data = JSON.stringify({ ...input([]), manual: [{ name: "Trolley", qty: 1, priceCents: 99_00, size: "", color: "Schwarz", photo: "p0" }] });
    const form = () => { const fd = new FormData(); fd.append("data", data); fd.append("p0", new Blob([new Uint8Array(jpgSmall)], { type: "image/jpeg" }), "p0.jpg"); return fd; };
    const jpgSmall = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    const req = (body: BodyInit, h: Record<string, string> = { "sec-fetch-site": "same-origin", "x-forwarded-for": ip() }) =>
      new Request(`http://localhost/api/b/${token}/order`, { method: "POST", headers: h, body });
    const ok = await POST(req(form()), { params });
    expect(ok.status).toBe(200);
    const j = await ok.json() as { number: number };
    const o = await db.query.directOrders.findFirst({ where: eq(schema.directOrders.number, j.number), with: { lines: true } });
    expect(o!.lines[0]).toMatchObject({ description: "Trolley (Schwarz)", unitPriceCents: 99_00 });
    expect(o!.lines[0].photoFileId).toBeTruthy();
    expect((await POST(req(form(), { "sec-fetch-site": "cross-site" }), { params })).status).toBe(403);
    const big = new FormData(); big.append("data", data); big.append("p0", new Blob([new Uint8Array(17 * 1024 * 1024)], { type: "image/jpeg" }), "p0.jpg");
    expect((await POST(req(big), { params })).status).toBe(413);
    const broken = new FormData(); broken.append("p0", new Blob([new Uint8Array(jpgSmall)]), "p0.jpg");
    expect((await POST(req(broken), { params })).status).toBe(400);
  });

  it("Vorschlag über die E-Mail, Ablehnen und wieder öffnen, Löschen nach Frist", async () => {
    const email = `nour${crypto.randomUUID().slice(0, 6)}@example.de`;
    await db.update(schema.customers).set({ email: email.toUpperCase() }).where(eq(schema.customers.id, cust));
    const r = await L.submitDirectOrder(input([{ variantId: vIn, qty: 1 }], email), { ip: ip(), group: "RETAIL" });
    expect((await L.directOrderDetail(r.id))!.suggestion?.id).toBe(cust);
    expect(await L.newDirectCount()).toBeGreaterThan(0);
    await L.rejectDirectOrder(r.id, "doppelt", admin);
    expect((await L.directOrderDetail(r.id))).toMatchObject({ state: "rejected", rejectReason: "doppelt" });
    await expect(L.rejectDirectOrder(r.id, "", admin)).rejects.toMatchObject({ code: "done" });
    await L.reopenDirectOrder(r.id, admin);
    expect((await L.directOrderDetail(r.id))!.state).toBe("new");
    await L.rejectDirectOrder(r.id, "", admin);
    await db.update(schema.directOrders).set({ handledAt: new Date(Date.now() - 91 * 86400_000) }).where(eq(schema.directOrders.id, r.id));
    const old = await L.submitDirectOrder(input([{ variantId: vIn, qty: 1 }]), { ip: ip(), group: "RETAIL" });
    await db.update(schema.directOrders).set({ createdAt: new Date(Date.now() - 181 * 86400_000) }).where(eq(schema.directOrders.id, old.id));
    expect(await L.purgeDirectOrders()).toBeGreaterThanOrEqual(2);
    expect(await L.directOrderDetail(r.id)).toBeNull();
    expect(await L.directOrderDetail(old.id)).toBeNull();
  });
});
