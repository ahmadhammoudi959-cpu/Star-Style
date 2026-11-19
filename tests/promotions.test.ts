/**
 * Aktionen (Wunsch Inhaber 19.11.2026: „قسم العروض“): reine Regeln, Streichpreis im Shop, Wiederverkäuferpreise, Texte fürs Bild
 * + Datenbank (Rabatt je Ort und Datum, Vormerken für die Shops) + simuliertes Shopify (Streichpreis setzen/zurücksetzen,
 * Kollektion „Angebote“, Werbebild hochladen und ins Metafeld schreiben).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  addDays, bannerJson, bannerSlots, bestDiscounts, discounted, extendUntil, isActive, percentOff, percentToBp, phaseState, windowProblem,
} from "../src/lib/promo-rules";
import { planPriceUpdates } from "../src/lib/shopify/product-push-map";
import { planResellerPrices } from "../src/lib/shopify/b2b-map";

describe("Aktionen: Zeitfenster", () => {
  const T = "2026-11-20";
  it("aus / geplant / läuft / vorbei; beendet = aus", () => {
    expect(phaseState({ on: false, from: null, until: null }, T)).toBe("off");
    expect(phaseState({ on: true, from: null, until: null }, T)).toBe("active");
    expect(phaseState({ on: true, from: "2026-11-21", until: null }, T)).toBe("scheduled");
    expect(phaseState({ on: true, from: "2026-11-20", until: "2026-11-20" }, T)).toBe("active"); // beide Tage inklusive
    expect(phaseState({ on: true, from: null, until: "2026-11-19" }, T)).toBe("over");
    expect(phaseState({ on: true, from: null, until: null }, T, true)).toBe("off");
    expect(isActive({ on: true, from: "2026-11-01", until: "2026-12-01" }, T)).toBe(true);
  });
  it("Datum prüfen, Tage addieren, verlängern ab Ende oder ab heute", () => {
    expect(windowProblem("2026-11-20", "2026-11-19")).toBe("order");
    expect(windowProblem("2026-02-30", null)).toBe("date");
    expect(windowProblem(null, "2026-11-19")).toBe(null); // schon vorbei ist erlaubt (= aus)
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30"); // Zeitumstellung egal
    expect(extendUntil("2026-11-25", T, 2)).toBe("2026-11-27");
    expect(extendUntil("2026-11-10", T, 7)).toBe("2026-11-27"); // vorbei → ab heute
    expect(extendUntil(null, T, 1)).toBe("2026-11-21");
  });
  it("Prozent: nur ganze 1–90", () => {
    expect(percentToBp("20")).toBe(2000);
    expect(percentToBp(" 70 % ")).toBe(7000);
    expect(percentToBp(15)).toBe(1500);
    for (const bad of ["0", "95", "12,5", "12.5", "", "abc", "-5"]) expect(percentToBp(bad)).toBe(null);
  });
});

describe("Aktionen: Preise", () => {
  it("Abzeichen im Theme zeigt genau den Rabatt (jeder Preis ab 1 €, 1–90 %)", () => {
    for (let c = 100; c < 200_000; c += 137) for (let p = 1; p <= 90; p += 7) expect(percentOff(c, discounted(c, p * 100))).toBe(p);
    expect(discounted(1541, 2000)).toBe(1233); // 15,41 € − 20 % = 12,33 €
    expect(discounted(10000, 7000)).toBe(3000);
  });
  it("mehrere Aktionen auf einem Artikel: der höchste Rabatt", () => {
    expect(bestDiscounts([{ productId: "a", bp: 1000 }, { productId: "a", bp: 2000 }, { productId: "b", bp: 500 }])).toEqual(new Map([["a", 2000], ["b", 500]]));
  });
});

describe("Aktionen: Streichpreis im Shop (planPriceUpdates)", () => {
  const cur = (price: string, compareAtPrice: string | null = null) => [{ id: "gid://v/1", price, compareAtPrice, productId: "gid://p/A" }];
  const row = { shopVariantId: "gid://v/1", netCents: 2513, vatRateBp: 1900 }; // 29,90 € brutto
  it("Aktion an: Preis −20 %, Streichpreis = normaler Preis; Streichpreis von vorher gemerkt", () => {
    const r = planPriceUpdates([{ ...row, promoBp: 2000 }], cur("29.90"), true);
    expect(r.updates).toEqual([{ productId: "gid://p/A", variants: [{ id: "gid://v/1", price: "23.92", compareAtPrice: "29.90" }] }]);
    expect(r.marks.get("gid://v/1")).toEqual({ promoCompareCents: 2990, prePromoCompareCents: null });
    // hatte der Inhaber einen eigenen Streichpreis, kommt der nach der Aktion zurück
    const own = planPriceUpdates([{ ...row, promoBp: 2000 }], cur("29.90", "34.90"), true);
    expect(own.marks.get("gid://v/1")).toEqual({ promoCompareCents: 2990, prePromoCompareCents: 3490 });
  });
  it("läuft schon: nichts zu tun; Normalpreis geändert → neuer Preis + Streichpreis, Merker bleibt", () => {
    const same = planPriceUpdates([{ ...row, promoBp: 2000, promoCompareCents: 2990 }], cur("23.92", "29.90"), true);
    expect(same.updates).toEqual([]);
    expect(same.unchanged).toBe(1);
    expect(same.marks.size).toBe(0);
    const moved = planPriceUpdates([{ ...row, netCents: 3353, promoBp: 2000, promoCompareCents: 2990, prePromoCompareCents: 3490 }], cur("23.92", "29.90"), true);
    expect(moved.updates[0].variants).toEqual([{ id: "gid://v/1", price: "31.92", compareAtPrice: "39.90" }]);
    expect(moved.marks.get("gid://v/1")).toEqual({ promoCompareCents: 3990, prePromoCompareCents: 3490 });
  });
  it("Aktion aus: Preis zurück, Streichpreis zurück auf den von vorher (keiner → leer)", () => {
    const r = planPriceUpdates([{ ...row, promoCompareCents: 2990, prePromoCompareCents: null }], cur("23.92", "29.90"), true);
    expect(r.updates[0].variants).toEqual([{ id: "gid://v/1", price: "29.90", compareAtPrice: null }]);
    expect(r.marks.get("gid://v/1")).toEqual({ promoCompareCents: null, prePromoCompareCents: null });
    const back = planPriceUpdates([{ ...row, promoCompareCents: 2990, prePromoCompareCents: 3490 }], cur("23.92", "29.90"), true);
    expect(back.updates[0].variants).toEqual([{ id: "gid://v/1", price: "29.90", compareAtPrice: "34.90" }]);
  });
  it("Streichpreis inzwischen im Shop von Hand geändert → bleibt; ohne Aktion und ohne Merker: alter Ablauf", () => {
    const r = planPriceUpdates([{ ...row, promoCompareCents: 2990 }], cur("23.92", "39.90"), true);
    expect(r.updates[0].variants).toEqual([{ id: "gid://v/1", price: "29.90" }]);
    expect(r.marks.get("gid://v/1")).toEqual({ promoCompareCents: null, prePromoCompareCents: null });
    const plain = planPriceUpdates([row], cur("29.90", "34.90"), true);
    expect(plain.updates).toEqual([]);
    expect(plain.marks.size).toBe(0);
  });
});

describe("Aktionen: Wiederverkäuferpreise (Shopify B2B)", () => {
  it("Festpreis −20 % mit Streichpreis; danach Streichpreis wieder weg", () => {
    const on = planResellerPrices([{ shopVariantId: "v1", netCents: 2000, vatRateBp: 1900, promoBp: 2000 }], [{ variantId: "v1", amount: "23.80" }], true, "EUR");
    expect(on.add).toEqual([{ variantId: "v1", price: { amount: "19.04", currencyCode: "EUR" }, compareAtPrice: { amount: "23.80", currencyCode: "EUR" } }]);
    const still = planResellerPrices([{ shopVariantId: "v1", netCents: 2000, vatRateBp: 1900, promoBp: 2000 }], [{ variantId: "v1", amount: "19.04", compareAt: "23.80" }], true, "EUR");
    expect(still.add).toEqual([]);
    const off = planResellerPrices([{ shopVariantId: "v1", netCents: 2000, vatRateBp: 1900 }], [{ variantId: "v1", amount: "19.04", compareAt: "23.80" }], true, "EUR");
    expect(off.add).toEqual([{ variantId: "v1", price: { amount: "23.80", currencyCode: "EUR" }, compareAtPrice: null }]);
    const plain = planResellerPrices([{ shopVariantId: "v1", netCents: 2000, vatRateBp: 1900 }], [{ variantId: "v1", amount: "23.80" }], true, "EUR");
    expect(plain.add).toEqual([]);
  });
});

describe("Aktionen: Werbebild im Shop", () => {
  const c = (id: string, place: "top" | "below", startedAt: number, extra: Partial<{ active: boolean; ready: boolean; shops: string[] }> = {}) =>
    ({ id, place, startedAt, shops: ["GENERAL_SHOP"], active: true, ready: true, ...extra });
  it("je Platz die zuletzt eingeschaltete laufende Aktion mit fertigem Bild", () => {
    const cands = [c("a", "top", 1), c("b", "top", 2), c("x", "top", 9, { ready: false }), c("y", "below", 9, { active: false }), c("z", "below", 3, { shops: ["BRAND_SHOP"] })];
    expect(bannerSlots(cands, "GENERAL_SHOP")).toEqual({ top: "b", below: null });
    expect(bannerSlots(cands, "BRAND_SHOP")).toEqual({ top: null, below: "z" });
  });
  it("Metafeld-Inhalt: feste Reihenfolge, leere Plätze null", () => {
    const s = { id: "p1", pct: 20, until: "2026-11-24", product: null, img: { de: { w: "W", t: "T" }, ar: { w: "W2", t: "T2" } }, alt: { ar: "خصم 20%", de: "20 % Rabatt" } };
    const j = bannerJson({ below: s });
    expect(j).toBe(`{"v":1,"top":null,"below":{"id":"p1","pct":20,"until":"2026-11-24","product":"","img":{"de":{"w":"W","t":"T"},"ar":{"w":"W2","t":"T2"}},"alt":{"de":"20 % Rabatt","ar":"خصم 20%"}}}`);
    expect(bannerJson({})).toBe(`{"v":1,"top":null,"below":null}`);
  });
});

describe("Aktionen: Texte fürs Bild", async () => {
  // promo-copy importiert "server-only" (im Test leer) und den KI-Zugang (ohne Schlüssel: feste Texte)
  const { cleanCopy, fallbackCopy, shortName, cut } = await import("../src/lib/ai/promo-copy");
  const products = [{ name: "DeltaPro Barberstuhl Legend – Schwarz", nameNl: "DeltaPro Barberstoel Legend", category: "Barberstühle" }, { name: "Haartrockner Elite", nameNl: "", category: "" }];
  it("Kurznamen ohne Marke und Farbe; kürzen an Wortgrenzen", () => {
    expect(shortName(products[0].name)).toBe("Barberstuhl Legend");
    expect(cut("Professionele uitrusting in de aanbieding voor iedereen", 30)).toBe("Professionele uitrusting in de");
  });
  it("KI-Antwort: Prozent/Preise fliegen raus, fehlende Namen von den festen Texten, ohne KI alles fest", () => {
    const c = cleanCopy({ de: { headline: "Jetzt 20 % sparen!", sub: "Barber-Ausstattung reduziert", names: ["Legend"] }, ar: { headline: "عروض الصالون", sub: "ب 99,00 €", names: ["كرسي ليجند", "سشوار إيليت"] } }, products);
    expect(c.de).toEqual({ headline: "Profi-Ausstattung im Angebot", sub: "Barber-Ausstattung reduziert", names: ["Legend", "Haartrockner Elite"] });
    expect(c.ar).toEqual({ headline: "عروض الصالون", sub: "منتجات مختارة عليها خصم", names: ["كرسي ليجند", "سشوار إيليت"] });
    expect(c.nl.names).toEqual(["Barberstoel Legend", "Haartrockner Elite"]);
    expect(fallbackCopy(products).en.headline).toBe("Pro equipment on sale");
  });
});

// ───────────── Datenbank + simuliertes Shopify ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Aktionen (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { eq, sql } = await import("drizzle-orm");
  const { encrypt } = await import("../src/lib/crypto");
  const promos = await import("../src/lib/promotions");
  const { pushPrices } = await import("../src/lib/shopify/prices");
  const { syncPromoShop } = await import("../src/lib/shopify/promo-shop");
  const { todayIso } = await import("../src/lib/dates");
  const stamp = Date.now();
  const today = todayIso();
  let user = "";
  let pA = "", pB = "", vA = "", vB = "";

  // Shopify-Zustand: Varianten (Preis, Streichpreis), Kollektionen, Dateien, Metafelder
  const S = {
    variants: new Map<string, { price: string; compareAtPrice: string | null; product: string }>(),
    collections: new Map<string, { id: string; handle: string; rules: unknown; published: boolean }>(),
    files: new Map<string, { status: string; url: string }>(), metafields: new Map<string, string>(), deleted: [] as string[], seq: 1, uploads: 0,
    denyFiles: false,
  };
  const ok = (data: unknown) => Response.json({ data });
  function mock() {
    return vi.fn(async (url: string, init: { body: unknown }) => {
      if (String(url).startsWith("https://upload.test/")) { S.uploads++; return new Response(null, { status: 201 }); }
      const { query: q, variables: v } = JSON.parse(String(init.body)) as { query: string; variables: Record<string, any> };
      if (q.includes("shop { taxesIncluded }")) return ok({ shop: { taxesIncluded: true } });
      if (q.includes("... on ProductVariant { id price compareAtPrice")) return ok({ nodes: v.ids.map((id: string) => { const x = S.variants.get(id); return x ? { id, price: x.price, compareAtPrice: x.compareAtPrice, product: { id: x.product } } : null; }) });
      if (q.includes("productVariantsBulkUpdate")) {
        for (const u of v.variants) { const x = S.variants.get(u.id)!; x.price = u.price; if ("compareAtPrice" in u) x.compareAtPrice = u.compareAtPrice; }
        return ok({ productVariantsBulkUpdate: { productVariants: [], userErrors: [] } });
      }
      if (q.includes("markets") || q.includes("priceLists")) return Response.json({ errors: [{ message: "no b2b in this test" }] });
      if (q.includes("collectionByIdentifier")) { const c = [...S.collections.values()].find((x) => x.handle === v.h); return ok({ collectionByIdentifier: c ? { id: c.id, handle: c.handle } : null }); }
      if (q.includes("... on Collection { id handle }")) { const c = [...S.collections.values()].find((x) => x.id === v.id); return ok({ node: c ? { id: c.id, handle: c.handle } : null }); }
      if (q.includes("collectionCreate")) { const id = `gid://shopify/Collection/${S.seq++}`; S.collections.set(id, { id, handle: v.input.handle, rules: v.input.ruleSet, published: false }); return ok({ collectionCreate: { collection: { id, handle: v.input.handle }, userErrors: [] } }); }
      if (q.includes("publications(")) return ok({ publications: { nodes: [{ id: "gid://shopify/Publication/1", catalog: { title: "Online Store" } }] } });
      if (q.includes("publishablePublish")) { S.collections.get(v.id)!.published = true; return ok({ publishablePublish: { userErrors: [] } }); }
      if (q.includes("translatableResource") || q.includes("shopLocales")) return Response.json({ errors: [{ message: "Access denied for translatableResource field. Required access: `read_translations`" }] });
      if (q.includes("stagedUploadsCreate")) {
        if (S.denyFiles) return Response.json({ errors: [{ message: "Access denied for stagedUploadsCreate field." }] });
        return ok({ stagedUploadsCreate: { stagedTargets: v.input.map((i: { filename: string }) => ({ url: `https://upload.test/${i.filename}`, resourceUrl: `https://upload.test/r/${i.filename}`, parameters: [{ name: "key", value: i.filename }] })), userErrors: [] } });
      }
      if (q.includes("fileCreate")) {
        if (S.denyFiles) return Response.json({ errors: [{ message: "Access denied for fileCreate field. Required access: `write_files` access scope." }] });
        const files = v.files.map((f: { filename: string }) => { const id = `gid://shopify/MediaImage/${S.seq++}`; S.files.set(id, { status: "READY", url: `https://cdn.shopify.com/files/${f.filename}` }); return { id, fileStatus: "UPLOADED" }; });
        return ok({ fileCreate: { files, userErrors: [] } });
      }
      if (q.includes("... on MediaImage")) return ok({ nodes: v.ids.map((id: string) => { const f = S.files.get(id); return f ? { id, fileStatus: f.status, image: { url: f.url } } : null; }) });
      if (q.includes("fileDelete")) { for (const id of v.ids) { S.files.delete(id); S.deleted.push(id); } return ok({ fileDelete: { deletedFileIds: v.ids, userErrors: [] } }); }
      if (q.includes("metafieldsSet")) { for (const m of v.m) S.metafields.set(`${m.ownerId}|${m.namespace}.${m.key}`, m.value); return ok({ metafieldsSet: { metafields: [], userErrors: [] } }); }
      if (q.includes("... on ProductVariant { product { handle } }")) return ok({ node: { product: { handle: "haartrockner-elite" } } });
      return Response.json({ errors: [{ message: `unexpected ${q.slice(0, 80)}` }] });
    });
  }

  beforeAll(async () => {
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", domain: "star-general.myshopify.com", staticTokenEnc: encrypt("shpat_test"), locationId: "gid://shopify/Location/1", active: false })
      .onConflictDoUpdate({ target: schema.shops.channel, set: { domain: "star-general.myshopify.com", staticTokenEnc: encrypt("shpat_test"), locationId: "gid://shopify/Location/1", offersCollectionId: "", promoBanner: "" } });
    // andere Aktionen aus früheren Läufen stören die Plätze nicht
    await db.execute(sql`update promotions set price_on = false, banner_on = false, ended_at = now(), price_live = false`);
    const [u] = await db.insert(schema.users).values({ email: `promo.${stamp}@example.com`, name: "Promo", passwordHash: "x" }).returning();
    user = u.id;
    const [a] = await db.insert(schema.products).values({ sku: `PRA-${stamp}`, nameDe: "Haartrockner Elite", vatRateBp: 1900, retailPriceCents: 2513, wholesalePriceCents: 2000, purchasePriceCents: 1500, inGeneralShop: true }).returning();
    const [b] = await db.insert(schema.products).values({ sku: `PRB-${stamp}`, nameDe: "Barberstuhl Legend", vatRateBp: 1900, retailPriceCents: 100000, wholesalePriceCents: 90000, inGeneralShop: true }).returning();
    pA = a.id; pB = b.id;
    vA = (await db.insert(schema.variants).values({ productId: a.id }).returning())[0].id;
    vB = (await db.insert(schema.variants).values({ productId: b.id }).returning())[0].id;
    await db.insert(schema.shopVariants).values([
      { channel: "GENERAL_SHOP", shopVariantId: `gid://shopify/ProductVariant/${stamp}1`, variantId: vA },
      { channel: "GENERAL_SHOP", shopVariantId: `gid://shopify/ProductVariant/${stamp}2`, variantId: vB },
    ]);
    S.variants.set(`gid://shopify/ProductVariant/${stamp}1`, { price: "29.90", compareAtPrice: null, product: "gid://shopify/Product/A" });
    S.variants.set(`gid://shopify/ProductVariant/${stamp}2`, { price: "1190.00", compareAtPrice: "1290.00", product: "gid://shopify/Product/B" }); // eigener Streichpreis des Inhabers
  });
  afterEach(() => vi.unstubAllGlobals());
  // keine Vormerkungen liegen lassen – sonst nimmt pushDirtyPrices() anderer Tests (gleiche Test-DB) diese Artikel mit
  afterAll(async () => { if (pA && pB) await db.execute(sql`delete from shop_price_dirty where product_id in (${pA}, ${pB})`); });

  it("Rabatt je Ort und Datum; Vormerken für die Shops; beendet = alles zurück", async () => {
    const id = await promos.createPromotion({ title: "Black Week", discountBp: 2000, productIds: [pA, pB], places: ["SYSTEM", "GENERAL_SHOP"] }, user);
    expect((await promos.activeDiscounts("SYSTEM", [pA])).get(pA)).toBeUndefined(); // angelegt, noch nicht gestartet
    await db.execute(sql`delete from shop_price_dirty where product_id in (${pA}, ${pB})`);
    await promos.setPriceWindow(id, { on: true, from: addDays(today, 1), until: null }, user); // ab morgen
    expect((await promos.activeDiscounts("SYSTEM", [pA, pB])).size).toBe(0);
    expect((await db.execute(sql`select count(*)::int as n from shop_price_dirty where product_id in (${pA}, ${pB})`)).rows[0].n).toBe(0);
    await promos.setPriceWindow(id, { on: true, from: null, until: addDays(today, 6) }, user); // ab heute
    expect(await promos.activeDiscounts("SYSTEM", [pA, pB])).toEqual(new Map([[pA, 2000], [pB, 2000]]));
    expect((await promos.activeDiscounts("DIRECT", [pA])).size).toBe(0); // Bestell-Link nicht gewählt
    expect((await db.execute(sql`select count(*)::int as n from shop_price_dirty where product_id in (${pA}, ${pB})`)).rows[0].n).toBe(2);
    expect((await db.query.promotions.findFirst({ where: eq(schema.promotions.id, id) }))!.priceLive).toBe(true);
    // ohne Recht „Rabatt“ darf genau dieser Rabatt in Angebot/Rechnung stehen
    expect([...(await promos.allowedPromoBps([pA])).get(pA)!]).toEqual([2000]);

    // Shop: Preis −20 %, Streichpreis; der eigene Streichpreis des Inhabers wird gemerkt
    vi.stubGlobal("fetch", mock());
    const r = await pushPrices([pA, pB], "GENERAL_SHOP");
    expect(r[0]).toMatchObject({ updated: 2, failed: 0 });
    expect(S.variants.get(`gid://shopify/ProductVariant/${stamp}1`)).toMatchObject({ price: "23.92", compareAtPrice: "29.90" });
    expect(S.variants.get(`gid://shopify/ProductVariant/${stamp}2`)).toMatchObject({ price: "952.00", compareAtPrice: "1190.00" });
    const svB = await db.query.shopVariants.findFirst({ where: eq(schema.shopVariants.variantId, vB) });
    expect(svB).toMatchObject({ promoCompareCents: 119000, prePromoCompareCents: 129000 });
    // nochmal: nichts mehr zu tun
    expect((await pushPrices([pA, pB], "GENERAL_SHOP"))[0]).toMatchObject({ updated: 0, unchanged: 2 });

    // Datum vorbei → Worker merkt vor, Preis-Abgleich setzt zurück (eigener Streichpreis kommt wieder)
    await db.update(schema.promotions).set({ priceUntil: addDays(today, -1) }).where(eq(schema.promotions.id, id));
    expect(await promos.syncPromoPriceStates()).toBeGreaterThanOrEqual(1);
    expect((await promos.activeDiscounts("GENERAL_SHOP", [pA])).size).toBe(0);
    expect((await pushPrices([pA, pB], "GENERAL_SHOP"))[0]).toMatchObject({ updated: 2 });
    expect(S.variants.get(`gid://shopify/ProductVariant/${stamp}1`)).toMatchObject({ price: "29.90", compareAtPrice: null });
    expect(S.variants.get(`gid://shopify/ProductVariant/${stamp}2`)).toMatchObject({ price: "1190.00", compareAtPrice: "1290.00" });
    expect(await db.query.shopVariants.findFirst({ where: eq(schema.shopVariants.variantId, vB) })).toMatchObject({ promoCompareCents: null, prePromoCompareCents: null });

    // beenden + löschen; Protokoll
    await promos.endPromotion(id, user);
    await promos.deletePromotion(id, user);
    const log = await db.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["create", "price_on", "price_ended", "end", "delete"]));
  }, 30_000);

  it("Werbebild: hochladen, Kollektion „Angebote“, Metafeld; ohne Recht write_files Hinweis; aus → Platz leer", async () => {
    const id = await promos.createPromotion({ title: "Föhn", discountBp: 2000, productIds: [pA], places: ["GENERAL_SHOP"] }, user);
    // fertige Bilder simulieren (die echte Erstellung testet der Bild-Test)
    const files: Record<string, string> = {};
    for (const k of ["wide-de", "tall-de", "wide-ar", "tall-ar"]) {
      const [f] = await db.insert(schema.storedFiles).values({ name: `${k}.webp`, mime: "image/webp", size: 4, sha256: k, data: Buffer.from("RIFF") }).returning();
      files[k] = f.id;
    }
    await db.update(schema.promotions).set({ bannerFiles: files, bannerVersion: 1, bannerCopy: { de: { headline: "Föhn reduziert", sub: "", names: ["Elite"] } } }).where(eq(schema.promotions.id, id));
    await expect(promos.setBannerWindow(id, { on: true, from: null, until: null, shops: [], place: "top" }, user)).rejects.toThrow("noShops");

    S.denyFiles = true;
    vi.stubGlobal("fetch", mock());
    await promos.setBannerWindow(id, { on: true, from: null, until: addDays(today, 2), shops: ["GENERAL_SHOP"], place: "below" }, user);
    await syncPromoShop("GENERAL_SHOP");
    expect((await db.query.promotionShops.findFirst({ where: eq(schema.promotionShops.promotionId, id) }))!.error).toBe("needScope:write_files");
    expect(S.metafields.size).toBe(0);

    S.denyFiles = false;
    await syncPromoShop("GENERAL_SHOP");
    const coll = [...S.collections.values()].find((c) => c.handle === "angebote")!;
    expect(coll).toMatchObject({ published: true, rules: { appliedDisjunctively: false, rules: [{ column: "IS_PRICE_REDUCED", relation: "IS_SET", condition: "" }] } });
    const mf = JSON.parse(S.metafields.get(`${coll.id}|star_style.banner`)!);
    expect(mf.top).toBe(null);
    expect(mf.below).toMatchObject({ id, pct: 20, product: "haartrockner-elite", img: { de: { w: expect.stringContaining("wide-de"), t: expect.stringContaining("tall-de") }, ar: { w: expect.any(String) } } });
    expect(mf.below.alt.de).toBe("20 % Rabatt: Föhn reduziert");
    const st = (await db.query.promotionShops.findFirst({ where: eq(schema.promotionShops.promotionId, id) }))!;
    expect(st).toMatchObject({ bannerVersion: 1, error: "" });
    expect(Object.keys(st.media).sort()).toEqual(["tall-ar", "tall-de", "wide-ar", "wide-de"]);
    expect((await promos.promotionDetail(id))!.shown.GENERAL_SHOP).toBe("below");

    // neues Bild (Version 2) → neu hochgeladen, alte Dateien im Shop gelöscht
    const oldIds = Object.values(st.media).map((m) => m.id);
    await db.update(schema.promotions).set({ bannerVersion: 2 }).where(eq(schema.promotions.id, id));
    await syncPromoShop("GENERAL_SHOP");
    expect(S.deleted).toEqual(expect.arrayContaining(oldIds));
    // Bild aus → Platz leer, Löschen erst danach erlaubt
    await promos.setBannerWindow(id, { on: false, from: null, until: null, shops: ["GENERAL_SHOP"], place: "below" }, user);
    await expect(promos.deletePromotion(id, user)).rejects.toThrow("notEnded"); // steht noch im Shop
    await syncPromoShop("GENERAL_SHOP");
    expect(JSON.parse(S.metafields.get(`${coll.id}|star_style.banner`)!)).toEqual({ v: 1, top: null, below: null });
    await promos.deletePromotion(id, user);
  }, 60_000);
});

describe("Werbebild zeichnen (echte Schriften, @napi-rs/canvas + sharp)", () => {
  it("breit 2400×800 und hoch 1080×1350, Arabisch, mit und ohne Foto, mehr als 4 Artikel", async () => {
    const sharp = (await import("sharp")).default;
    const { renderBanner, preparePhotos, BANNER_SIZE } = await import("../src/lib/promo-banner");
    // Produktfoto: dunkle Form auf hellem Grund (wie ein Shop-Foto) – der Rand wird abgeschnitten
    const photo = await sharp({ create: { width: 600, height: 600, channels: 3, background: "#f2f2f2" } })
      .composite([{ input: await sharp({ create: { width: 300, height: 420, channels: 3, background: "#1b1b1b" } }).png().toBuffer(), top: 90, left: 150 }])
      .jpeg().toBuffer();
    const photos = await preparePhotos([photo, null, photo, photo, photo]);
    expect(photos[0]).not.toBeNull();
    expect(photos[1]).toBeNull();
    for (const format of ["wide", "tall"] as const) {
      for (const lang of ["ar", "de"] as const) {
        const buf = await renderBanner({
          lang, format, discountBp: 7000, style: format === "wide" ? 0 : 2, until: "2026-11-30",
          copy: lang === "ar" ? { headline: "عروض الصالون", sub: "معدات احترافية بسعر أقل", names: ["كرسي ليجند", "سشوار إيليت"] } : { headline: "Profi-Technik reduziert", sub: "Für Salon und Barbershop", names: ["Legend", "Elite"] },
          photos,
        });
        const meta = await sharp(buf).metadata();
        expect(meta.format).toBe("webp");
        expect([meta.width, meta.height]).toEqual([BANNER_SIZE[format].w, BANNER_SIZE[format].h]);
        expect(buf.length).toBeGreaterThan(20_000);
        expect(buf.length).toBeLessThan(2_500_000);
      }
    }
  }, 60_000);
});
