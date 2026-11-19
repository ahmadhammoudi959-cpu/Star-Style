import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db";
import {
  applyProblems, cartProblems, cartTotals, catalogCategories, directLinkUrl, directState, lineDescription, looksLikeToken, mergeCart,
  priceRange, productInStock, rateLimited, searchCatalog, shareText, type CatalogProduct,
} from "../src/lib/direct-rules";
import { parseDirectOrder } from "../src/lib/direct-input";

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

  it("Token-Form, Link-Adresse, Text zum Teilen", () => {
    expect(looksLikeToken("abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(looksLikeToken("abc")).toBe(false);
    expect(looksLikeToken("abcdefghijklmnopqrstuv/x")).toBe(false);
    expect(directLinkUrl("https://star-style.onrender.com/", "T0k")).toBe("https://star-style.onrender.com/b/T0k");
    expect(shareText("Hier: {url}", "https://x/b/1")).toBe("Hier: https://x/b/1");
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

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Bestell-Link (Datenbank)", () => {
  type Lib = typeof import("../src/lib/direct");
  let L: Lib;
  let admin = "", vIn = "", vOut = "", vHidden = "", pIn = "", photo = "", cust = "", custW = "";
  const ip = () => `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const input = (lines: { variantId: string; qty: number }[], email = `kunde${crypto.randomUUID().slice(0, 6)}@example.de`) => ({
    name: "Nour", email, company: "Salon Nour", phone: "", street: "", zip: "", city: "", country: "DE", vatId: "", note: "Abholung Samstag",
    website: "", elapsedMs: 9000, lang: "ar" as const, lines,
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
