import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ───────────── Kategorien und Shop-Fotos mit simuliertem Shopify ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Kategorien und Shop-Fotos (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { and, eq } = await import("drizzle-orm");
  const { encrypt } = await import("../src/lib/crypto");
  const cats = await import("../src/lib/categories");
  const { collectionInput } = await import("../src/lib/shopify/category-map");
  const tag = String(Date.now()).slice(-8);
  const png = (n: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: n }, (_, i) => i % 250)]);

  type Call = { url: string; query?: string; variables?: Record<string, any> };
  let calls: Call[] = [];
  let navDenied = false;
  let seq = 0;
  // Zustand des simulierten Shops
  const collections: { id: string; title: string; handle: string; rule: string; count: number }[] = [
    { id: "gid://shopify/Collection/1", title: "Barberstühle", handle: "barberstuehle", rule: "Barberstuhl", count: 20 },
  ];
  const menuItems = () => [
    { id: "gid://shopify/MenuItem/101", title: "Salonmöbel", type: "CATALOG", resourceId: null, url: "/collections/all", tags: [], items: [
      { id: "gid://shopify/MenuItem/102", title: "Barberstühle", type: "COLLECTION", resourceId: "gid://shopify/Collection/1", url: "/collections/barberstuehle", tags: [], items: [] }] },
    { id: "gid://shopify/MenuItem/201", title: "Technik & Licht", type: "CATALOG", resourceId: null, url: "/collections/all", tags: [], items: [
      { id: "gid://shopify/MenuItem/202", title: "Maschinen & Föhne", type: "COLLECTION", resourceId: "gid://shopify/Collection/2", url: "/collections/maschinen-foehne", tags: [], items: [] }] },
    { id: "gid://shopify/MenuItem/301", title: "FAQ", type: "PAGE", resourceId: "gid://shopify/Page/1", url: "/pages/faq", tags: [], items: [] },
  ];
  let menu = menuItems();
  const media = new Map<string, string[]>();                                 // Shop-Produkt → Medien (Reihenfolge)
  const variantProduct = new Map<string, { id: string; productType: string }>(); // Shop-Variante → Shop-Produkt

  const json = (data: unknown) => Response.json({ data });
  function shopifyMock() {
    return vi.fn(async (url: string, init?: { body?: unknown; method?: string }) => {
      if (url.endsWith("/admin/oauth/access_token")) return Response.json({ access_token: "tok", scope: "x", expires_in: 86399 });
      if (url.startsWith("https://staged.example/")) { calls.push({ url }); return new Response(null, { status: 204 }); }
      if (url.startsWith("https://cdn.shopify.com/")) { calls.push({ url }); return new Response(new Uint8Array(png(30)), { headers: { "content-type": "image/png" } }); }
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, any> };
      calls.push({ url, query, variables });
      if (query.includes("productTypes(")) return json({ productTypes: { nodes: ["Werkzeug & Zubehör", "Barberstuhl"] } });
      if (query.includes("collections(")) return json({ collections: { pageInfo: { hasNextPage: false, endCursor: "" }, nodes: collections.map((c) => ({
        title: c.title, ruleSet: { appliedDisjunctively: false, rules: [{ column: "TYPE", relation: "EQUALS", condition: c.rule }] } })) } });
      if (query.includes("publications(")) return json({ publications: { nodes: [{ id: "gid://shopify/Publication/1", catalog: { title: "Online Store" } }] } });
      if (query.includes("publishablePublish")) return json({ publishablePublish: { userErrors: [] } });
      if (query.includes("collectionCreate")) {
        const id = `gid://shopify/Collection/${tag}${++seq}`;
        const input = variables.input as ReturnType<typeof collectionInput>;
        collections.push({ id, title: input.title, handle: `h-${seq}`, rule: input.ruleSet.rules[0].condition, count: 0 });
        return json({ collectionCreate: { collection: { id, handle: `h-${seq}`, title: input.title }, userErrors: [] } });
      }
      if (query.includes("collection(id:")) { const c = collections.find((x) => x.id === variables.id); return json({ collection: c ? { id: c.id, productsCount: { count: c.count } } : null }); }
      if (query.includes("collectionDelete")) {
        const i = collections.findIndex((x) => x.id === variables.input.id); collections.splice(i, 1);
        return json({ collectionDelete: { deletedCollectionId: variables.input.id, userErrors: [] } });
      }
      if (query.includes("menus(")) {
        if (navDenied) return Response.json({ errors: [{ message: "Access denied for menus field. Required access: `read_online_store_navigation` access scope.", extensions: { code: "ACCESS_DENIED" } }] });
        return json({ menus: { nodes: [{ id: "gid://shopify/Menu/9", handle: "main-menu", title: "Hauptmenü", items: menu }] } });
      }
      if (query.includes("menuUpdate(")) {
        // wie Shopify beim nächsten Lesen: alle Felder da, neue Punkte bekommen eine ID
        const norm = (xs: any[]): any[] => xs.map((x) => ({ id: x.id ?? `gid://shopify/MenuItem/${tag}${++seq}`, title: x.title, type: x.type,
          resourceId: x.resourceId ?? null, url: x.url ?? null, tags: x.tags ?? [], items: norm(x.items ?? []) }));
        menu = norm(variables.items);
        return json({ menuUpdate: { menu: { id: variables.id }, userErrors: [] } });
      }
      if (query.includes("taxesIncluded")) return json({ shop: { currencyCode: "EUR", taxesIncluded: true } });
      if (query.includes("productVariants(first: 50, query")) return json({ productVariants: { nodes: [] } });
      if (query.includes("stagedUploadsCreate")) {
        const input = variables.input as { filename: string }[];
        return json({ stagedUploadsCreate: { userErrors: [], stagedTargets: input.map((f) => ({
          url: `https://staged.example/upload/${f.filename}`, resourceUrl: `https://staged.example/res/${f.filename}`, parameters: [{ name: "key", value: f.filename }] })) } });
      }
      if (query.includes("productSet")) {
        const input = variables.input as { productType?: string; files?: unknown[]; variants: { optionValues: { optionName: string; name: string }[]; barcode?: string; inventoryItem: { sku: string } }[] };
        const pid = `gid://shopify/Product/${tag}${++seq}`;
        const ids = (input.files ?? []).map(() => `gid://shopify/MediaImage/${tag}${++seq}`);
        media.set(pid, ids);
        const vs = input.variants.map((x, i) => {
          const id = `gid://shopify/ProductVariant/${tag}${seq}v${i}`;
          variantProduct.set(id, { id: pid, productType: input.productType ?? "" });
          return { id, sku: x.inventoryItem.sku, barcode: x.barcode ?? null, displayName: `P ${i}`, selectedOptions: x.optionValues.map((o) => ({ name: o.optionName, value: o.name })),
            inventoryItem: { id: `gid://shopify/InventoryItem/${tag}${seq}v${i}`, tracked: true } };
        });
        return json({ productSet: { userErrors: [], product: { id: pid, handle: `p-${seq}`, variants: { nodes: vs }, media: { nodes: ids.map((id) => ({ id })) } } } });
      }
      if (query.includes("productVariant(id:")) {
        const pr = variantProduct.get(variables.id);
        return json({ productVariant: pr ? { product: { id: pr.id, media: { nodes: (media.get(pr.id) ?? []).map((id) => ({
          id, mediaContentType: "IMAGE", status: "READY", image: { url: `https://cdn.shopify.com/s/files/${id.split("/").pop()}.webp` } })) } } } : null });
      }
      if (query.includes("productDeleteMedia")) {
        media.set(variables.productId, (media.get(variables.productId) ?? []).filter((id) => !variables.mediaIds.includes(id)));
        return json({ productDeleteMedia: { deletedMediaIds: variables.mediaIds, mediaUserErrors: [] } });
      }
      if (query.includes("productReorderMedia")) {
        let list = [...(media.get(variables.id) ?? [])];
        for (const m of variables.moves as { id: string; newPosition: string }[]) { list = list.filter((x) => x !== m.id); list.splice(Number(m.newPosition), 0, m.id); }
        media.set(variables.id, list);
        return json({ productReorderMedia: { job: { id: "job" }, mediaUserErrors: [] } });
      }
      if (query.includes("productUpdate(")) {
        const pid = variables.product.id as string;
        if (variables.media) {
          const add = (variables.media as unknown[]).map(() => `gid://shopify/MediaImage/${tag}${++seq}`);
          media.set(pid, [...(media.get(pid) ?? []), ...add]);
        }
        if (variables.product.productType !== undefined) for (const [, p] of variantProduct) if (p.id === pid) p.productType = variables.product.productType;
        return json({ productUpdate: { userErrors: [], product: { id: pid, productType: variables.product.productType ?? "", media: { nodes: (media.get(pid) ?? []).map((id) => ({ id })) } } } });
      }
      if (query.includes("nodes(ids:")) return json({ nodes: (variables.ids as string[]).map((id) => { const p = variantProduct.get(id); return p ? { id, product: { ...p } } : null; }) });
      return Response.json({ errors: [{ message: `unexpected ${query.slice(0, 80)}` }] });
    });
  }

  async function file(bytes: Buffer, mime = "image/png") {
    const [r] = await db.insert(schema.storedFiles).values({ name: "f", mime, size: bytes.length, sha256: "x", data: bytes }).returning({ id: schema.storedFiles.id });
    return r.id;
  }
  async function newProduct(sku: string, o: { category?: string; imageFileId?: string | null } = {}) {
    const [p] = await db.insert(schema.products).values({ sku, nameDe: `Stuhl ${sku}`, vatRateBp: 1900, retailPriceCents: 10000, purchasePriceCents: 4000,
      inGeneralShop: true, category: o.category ?? "Werkzeug & Zubehör", imageFileId: o.imageFileId ?? null }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id, size: "", color: "", barcode: `46${tag}${sku.slice(-2)}`, stockQty: 3 }).returning();
    return { p, v };
  }
  /** Artikel mit einem Shop-Produkt verbinden (wie nach „Produkte aus dem Shop laden“) */
  async function link(variantId: string, productType: string, mediaIds: string[] = []) {
    const sv = `gid://shopify/ProductVariant/${tag}L${++seq}`, pid = `gid://shopify/Product/${tag}L${seq}`;
    variantProduct.set(sv, { id: pid, productType });
    media.set(pid, mediaIds);
    await db.insert(schema.shopVariants).values({ channel: "GENERAL_SHOP", shopVariantId: sv, inventoryItemId: `ii-${sv}`, variantId, matchedBy: "barcode", title: "x", sku: "", barcode: "" });
    return { sv, pid };
  }
  const gallery = async (productId: string) => (await db.select().from(schema.shopMedia)
    .where(and(eq(schema.shopMedia.productId, productId), eq(schema.shopMedia.channel, "GENERAL_SHOP"))).orderBy(schema.shopMedia.position));
  const q = (s: string) => calls.filter((c) => c.query?.includes(s));

  beforeAll(async () => {
    const shop = { domain: "star-general.myshopify.com", clientId: "cid", clientSecretEnc: encrypt("geheim"), staticTokenEnc: "", tokenEnc: "", tokenExpiresAt: null,
      active: false, locationId: "gid://shopify/Location/77", stockBuffer: 0, storeTypes: [], storeTypesAt: null, categoryMap: {} };
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", ...shop }).onConflictDoUpdate({ target: schema.shops.channel, set: shop });
    const brand = { domain: "", clientId: "", clientSecretEnc: "", staticTokenEnc: "", tokenEnc: "", locationId: "" };
    await db.insert(schema.shops).values({ channel: "BRAND_SHOP", ...brand }).onConflictDoUpdate({ target: schema.shops.channel, set: brand });
  });
  afterEach(() => { vi.unstubAllGlobals(); calls = []; });

  it("Kategorie anlegen: automatische Kollektion, veröffentlicht, ins Menü unter der Gruppe – alles andere im Menü bleibt gleich", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const name = `Scheren ${tag}`;
    const r = await cats.createCategory({ name: `  Scheren   ${tag} `, channels: ["GENERAL_SHOP"], groups: { GENERAL_SHOP: "gid://shopify/MenuItem/201" } }, "u-test");
    expect(r.name).toBe(name);
    expect(r.results).toEqual([expect.objectContaining({ channel: "GENERAL_SHOP", outcome: "created", menu: "added", label: name })]);
    expect(q("collectionCreate")[0].variables).toEqual({ input: collectionInput(name) });
    expect(q("publishablePublish").map((c) => c.variables!.id)).toEqual([r.results[0].collectionId]);
    // Menü: neuer Punkt hinten unter „Technik & Licht“, alles andere unverändert (IDs, Links)
    const before = menuItems();
    expect(menu[0]).toEqual(before[0]);
    expect(menu[2]).toEqual(before[2]);
    expect(menu[1].items).toEqual([before[1].items[0], { id: expect.any(String), title: name, type: "COLLECTION", resourceId: r.results[0].collectionId, url: expect.stringMatching(/^\/collections\/h-/), tags: [], items: [] }]);
    // was an Shopify ging: bestehende Punkte mit ihrer ID, der neue ohne
    const sent = q("menuUpdate(")[0].variables!.items as any[];
    expect(sent.map((x) => x.id)).toEqual(before.map((x) => x.id));
    expect(sent[1].items.map((x: any) => x.id)).toEqual(["gid://shopify/MenuItem/202", undefined]);
    const row = await cats.getCategory(r.id);
    expect(row!.shopCollections).toEqual({ GENERAL_SHOP: r.results[0].collectionId });
    // gleicher Name (Groß/klein egal) → gibt es schon
    await expect(cats.createCategory({ name: name.toUpperCase(), channels: [] })).rejects.toMatchObject({ code: "exists" });
    await expect(cats.createCategory({ name: "   ", channels: [] })).rejects.toMatchObject({ code: "nameRequired" });
    // Shop-Kategorie gleichen Namens gibt es schon → nichts doppelt anlegen
    calls = [];
    const r2 = await cats.createCategory({ name: `barberstühle`, channels: ["GENERAL_SHOP"] }).catch((e) => e);
    if (r2 instanceof Error) expect(r2).toMatchObject({ code: "exists" }); // falls schon im Verzeichnis
    else expect(r2.results[0]).toMatchObject({ outcome: "exists", label: "Barberstühle" });
    expect(q("collectionCreate")).toHaveLength(0);
  });

  it("leere Kategorie löschen: unsere leere Kollektion verschwindet aus Menü und Shop; mit Artikeln geht es nicht", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const r = await cats.createCategory({ name: `Wegwerf ${tag}`, channels: ["GENERAL_SHOP"], groups: { GENERAL_SHOP: "gid://shopify/MenuItem/101" } });
    const cid = r.results[0].collectionId!;
    expect(JSON.stringify(menu)).toContain(cid);
    const { p } = await newProduct(`CAT-${tag}-D1`, { category: `Wegwerf ${tag}` });
    await expect(cats.deleteCategory(r.id)).rejects.toMatchObject({ code: "notEmpty" });
    await cats.moveProductToCategory(p.id, null);
    // im Shop noch Produkte drin → nicht löschen
    collections.find((c) => c.id === cid)!.count = 2;
    await expect(cats.deleteCategory(r.id)).rejects.toMatchObject({ code: "storeNotEmpty" });
    collections.find((c) => c.id === cid)!.count = 0;
    calls = [];
    expect(await cats.deleteCategory(r.id, "u-test")).toEqual({ name: `Wegwerf ${tag}`, removed: { GENERAL_SHOP: cid } });
    expect(JSON.stringify(menu)).not.toContain(cid);
    expect(menu).toEqual(menuItems().map((g) => g.id === "gid://shopify/MenuItem/201" ? menu[1] : g)); // nur „Salonmöbel“ wieder wie vorher
    expect(q("collectionDelete")[0].variables).toEqual({ input: { id: cid } });
    expect(await cats.getCategory(r.id)).toBeUndefined();
  });

  it("ohne Recht fürs Menü: Kategorie wird trotzdem angelegt, Hinweis „noAccess“ und Protokoll", async () => {
    navDenied = true;
    vi.stubGlobal("fetch", shopifyMock());
    const r = await cats.createCategory({ name: `Föhne ${tag}`, channels: ["GENERAL_SHOP"], groups: { GENERAL_SHOP: null } });
    expect(r.results[0]).toMatchObject({ outcome: "created", menu: "noAccess" });
    expect(q("menuUpdate(")).toHaveLength(0);
    const ev = await db.select().from(schema.shopEvents).where(and(eq(schema.shopEvents.channel, "GENERAL_SHOP"), eq(schema.shopEvents.message, "needScopeNavigation")));
    expect(ev.length).toBeGreaterThanOrEqual(1);
  });

  it("Artikel in eine Kategorie: im Shop bekommt das verbundene Produkt den Produkttyp; fehlt sie im Shop, bleibt es, wo es ist", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const target = await cats.createCategory({ name: `Pinsel ${tag}`, channels: ["GENERAL_SHOP"] });
    const local = await cats.createCategory({ name: `Nur bei uns ${tag}`, channels: [] });
    const { p, v } = await newProduct(`CAT-${tag}-M1`);
    const { sv, pid } = await link(v.id, "Werkzeug & Zubehör");
    calls = [];
    const m = await cats.moveProductToCategory(p.id, target.id, "u-test");
    expect(m).toMatchObject({ before: "Werkzeug & Zubehör", category: `Pinsel ${tag}`, shops: [{ channel: "GENERAL_SHOP", updated: 1, missing: 0, failed: 0 }] });
    expect(q("productUpdate(")[0].variables).toEqual({ product: { id: pid, productType: `Pinsel ${tag}` } });
    expect(variantProduct.get(sv)!.productType).toBe(`Pinsel ${tag}`);
    // gleiche Kategorie nochmal → nichts im Shop
    calls = [];
    expect((await cats.moveProductToCategory(p.id, target.id)).shops).toEqual([]);
    expect(q("productUpdate(")).toHaveLength(0);
    // Kategorie gibt es im Shop nicht → nicht verschieben, Hinweis
    const m2 = await cats.moveProductToCategory(p.id, local.id);
    expect(m2.shops).toEqual([{ channel: "GENERAL_SHOP", updated: 0, unchanged: 0, missing: 1, failed: 0 }]);
    expect(variantProduct.get(sv)!.productType).toBe(`Pinsel ${tag}`);
    expect((await db.query.products.findFirst({ where: eq(schema.products.id, p.id) }))!.category).toBe(`Nur bei uns ${tag}`);
    // „Im Shop anlegen“ nachträglich → schon verbundene Artikel der Kategorie wandern mit (im Hintergrund)
    const add = await cats.addCategoryToStore(local.id, "GENERAL_SHOP", null);
    expect(add.outcome).toBe("created");
    for (let i = 0; i < 50 && variantProduct.get(sv)!.productType !== `Nur bei uns ${tag}`; i++) await new Promise((res) => setTimeout(res, 20));
    expect(variantProduct.get(sv)!.productType).toBe(`Nur bei uns ${tag}`);
    // Liste: Zustand je Shop
    const stores = await cats.storeContexts();
    const list = await cats.listCategories(stores);
    expect(list.find((c) => c.id === local.id)).toMatchObject({ n: 1, stores: { GENERAL_SHOP: { state: "same" } } });
  });

  it("neues Shop-Produkt bekommt die Galerie statt des Lagerfotos – in dieser Reihenfolge; die Medien werden gemerkt", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { saveGalleryTx } = await import("../src/lib/shopify/gallery");
    const { pushProductToShops } = await import("../src/lib/shopify/product-push");
    const lager = await file(png(10)), g1 = await file(png(21)), g2 = await file(png(22));
    const { p } = await newProduct(`CAT-${tag}-G1`, { imageFileId: lager });
    await db.transaction((tx) => saveGalleryTx(tx, p.id, "GENERAL_SHOP", [g2, g1], "u-test"));
    const r = await pushProductToShops(p.id);
    expect(r).toEqual([{ channel: "GENERAL_SHOP", outcome: "created", imagesFailed: false }]);
    // hochgeladen: genau die zwei Galerie-Fotos (Größe 30 = g2, 29 = g1), nicht das Lagerfoto
    expect((q("stagedUploadsCreate")[0].variables!.input as { fileSize: string }[]).map((x) => x.fileSize)).toEqual(["30", "29"]);
    const set = q("productSet")[0].variables!.input as { files: unknown[] };
    expect(set.files).toHaveLength(2);
    const rows = await gallery(p.id);
    const pid = [...media.keys()].at(-1)!;
    expect(rows.map((x) => [x.fileId, x.mediaId])).toEqual([[g2, media.get(pid)![0]], [g1, media.get(pid)![1]]]);
  });

  it("verbundenes Produkt: entfernt, neu und umsortiert geht in den Shop; im Shop von Hand ergänzte Fotos bleiben", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { saveGalleryTx, syncGallery } = await import("../src/lib/shopify/gallery");
    const g1 = await file(png(31)), g2 = await file(png(32)), g3 = await file(png(33));
    const { p, v } = await newProduct(`CAT-${tag}-G2`);
    const { pid } = await link(v.id, "Werkzeug & Zubehör", ["m1", "m2", "fremd"]);
    await db.insert(schema.shopMedia).values([
      { productId: p.id, channel: "GENERAL_SHOP", fileId: g1, position: 0, mediaId: "m1" },
      { productId: p.id, channel: "GENERAL_SHOP", fileId: g2, position: 1, mediaId: "m2" },
    ]);
    // im Formular: g1 entfernt („aus System und Shop“), g3 neu nach vorne, g2 dahinter
    expect(await db.transaction((tx) => saveGalleryTx(tx, p.id, "GENERAL_SHOP", { files: [g3, g2], hidden: [], drop: [g1] }))).toBe(true);
    expect((await gallery(p.id)).map((x) => [x.fileId, x.removed])).toEqual([[g1, true], [g3, false], [g2, false]]);
    expect(await syncGallery(p.id, "GENERAL_SHOP")).toEqual({ status: "done", uploaded: 1, removed: 1 });
    expect(q("productDeleteMedia")[0].variables).toEqual({ productId: pid, mediaIds: ["m1"] });
    const m3 = media.get(pid)!.find((x) => !["m2", "fremd"].includes(x))!;
    expect(media.get(pid)).toEqual([m3, "m2", "fremd"]); // unsere vorne, fremdes Foto bleibt dahinter
    expect((await gallery(p.id)).map((x) => [x.fileId, x.mediaId])).toEqual([[g3, m3], [g2, "m2"]]);
    // nichts geändert → keine Aufrufe außer dem Nachsehen
    calls = [];
    expect(await syncGallery(p.id, "GENERAL_SHOP")).toEqual({ status: "nothing" });
    expect(calls.filter((c) => c.query && !c.query.includes("productVariant(id:"))).toHaveLength(0);
    // im Shop von Hand gelöscht → kommt wieder (unser System bestimmt die Galerie)
    media.set(pid, ["fremd"]);
    expect(await syncGallery(p.id, "GENERAL_SHOP")).toMatchObject({ status: "done", uploaded: 2 });
    expect(media.get(pid)!.slice(-1)).toEqual(["fremd"]);
    expect(media.get(pid)).toHaveLength(3);
  });

  it("Entfernen mit Wahl (Wunsch Inhaber 04.11.2026): nur System → bleibt im Shop; nur Shop → bleibt hier; wieder in den Shop", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { adoptShopGallery, galleriesOf, saveGalleryTx, syncGallery } = await import("../src/lib/shopify/gallery");
    const { p, v } = await newProduct(`CAT-${tag}-G5`);
    const { pid } = await link(v.id, "Werkzeug & Zubehör", ["s1", "s2", "s3", "s4"]);
    const r = await adoptShopGallery(p.id, "GENERAL_SHOP", "u-test");
    if (!r.ok) throw new Error("adopt");
    const [f1, f2, f3, f4] = r.items.map((x) => x.fileId);
    calls = [];
    // f1 nur aus dem System, f2 nur aus dem Shop, f3 aus beiden, f4 bleibt
    expect(await db.transaction((tx) => saveGalleryTx(tx, p.id, "GENERAL_SHOP", { files: [f2, f4], hidden: [f2], drop: [f3] }, "u-test"))).toBe(true);
    expect((await gallery(p.id)).map((x) => [x.fileId, x.removed, x.hidden])).toEqual([[f3, true, false], [f2, false, true], [f4, false, false]]);
    expect(await syncGallery(p.id, "GENERAL_SHOP")).toEqual({ status: "done", uploaded: 0, removed: 2 });
    expect(q("productDeleteMedia").map((c) => [...c.variables!.mediaIds].sort())).toEqual([["s2", "s3"]]);
    // s1 bleibt im Shop (gilt ab jetzt als fremd → hinter unserer Galerie), s2/s3 sind weg
    expect(media.get(pid)).toEqual(["s4", "s1"]);
    expect((await gallery(p.id)).map((x) => [x.fileId, x.mediaId, x.hidden])).toEqual([[f2, "", true], [f4, "s4", false]]);
    expect((await galleriesOf(p.id)).GENERAL_SHOP.map((x) => [x.fileId, x.hidden])).toEqual([[f2, true], [f4, false]]);
    // Protokoll: was im Shop gelöscht wurde und was dort bleibt
    const log = await db.query.auditLog.findFirst({ where: and(eq(schema.auditLog.entityId, p.id), eq(schema.auditLog.action, "shop_gallery")), orderBy: (a, { desc }) => [desc(a.createdAt)] });
    expect(log?.after).toMatchObject({ deleteInStore: [f3], keptInStore: [f1], hidden: [f2] });
    // nichts mehr zu tun; das versteckte Foto wird nie hochgeladen
    calls = [];
    expect(await syncGallery(p.id, "GENERAL_SHOP")).toEqual({ status: "nothing" });
    // „wieder in den Shop“ → neu hochgeladen und vorne einsortiert; das fremde s1 bleibt dahinter
    expect(await db.transaction((tx) => saveGalleryTx(tx, p.id, "GENERAL_SHOP", { files: [f2, f4], hidden: [], drop: [] }))).toBe(true);
    expect(await syncGallery(p.id, "GENERAL_SHOP")).toMatchObject({ status: "done", uploaded: 1, removed: 0 });
    const back = (await gallery(p.id))[0].mediaId;
    expect(back).not.toBe("");
    expect(media.get(pid)).toEqual([back, "s4", "s1"]);
    // Entfernen ohne ausdrückliche Wahl (frühere Form) löscht im Shop nichts
    calls = [];
    expect(await db.transaction((tx) => saveGalleryTx(tx, p.id, "GENERAL_SHOP", [f4]))).toBe(true);
    await syncGallery(p.id, "GENERAL_SHOP");
    expect(q("productDeleteMedia")).toHaveLength(0);
    expect(media.get(pid)).toContain(back);
  });

  it("Löschen im Shop klappt nicht (Shop kurz weg) → bleibt vorgemerkt, der Hintergrund versucht es wieder", async () => {
    const { saveGalleryTx, syncGallery, retryGalleryDeletes } = await import("../src/lib/shopify/gallery");
    vi.stubGlobal("fetch", shopifyMock());
    const g1 = await file(png(41)), g2 = await file(png(42));
    const { p, v } = await newProduct(`CAT-${tag}-G6`);
    const { pid } = await link(v.id, "Werkzeug & Zubehör", ["d1", "d2"]);
    await db.insert(schema.shopMedia).values([
      { productId: p.id, channel: "GENERAL_SHOP", fileId: g1, position: 0, mediaId: "d1" },
      { productId: p.id, channel: "GENERAL_SHOP", fileId: g2, position: 1, mediaId: "d2" },
    ]);
    await db.transaction((tx) => saveGalleryTx(tx, p.id, "GENERAL_SHOP", { files: [g2], hidden: [g2], drop: [g1] }));
    // Shop nicht erreichbar (schon beim Token – sonst wartet der Aufruf seine Wiederholungen ab)
    await db.update(schema.shops).set({ tokenEnc: "", tokenExpiresAt: null }).where(eq(schema.shops.channel, "GENERAL_SHOP"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await syncGallery(p.id, "GENERAL_SHOP")).toMatchObject({ status: "failed" });
    const rows = await gallery(p.id);
    expect(rows.map((x) => [x.fileId, x.removed, x.mediaId, x.error])).toEqual([[g1, true, "d1", ""], [g2, false, "d2", ""]]);
    // Hintergrund (Shop läuft, kein Fehler) → jetzt gelöscht
    vi.stubGlobal("fetch", shopifyMock());
    await db.update(schema.shops).set({ active: true, lastError: "" }).where(eq(schema.shops.channel, "GENERAL_SHOP"));
    expect(await retryGalleryDeletes()).toBeGreaterThanOrEqual(1);
    expect(media.get(pid)).toEqual([]);
    expect((await gallery(p.id)).map((x) => [x.fileId, x.mediaId, x.hidden])).toEqual([[g2, "", true]]);
    await db.update(schema.shops).set({ active: false }).where(eq(schema.shops.channel, "GENERAL_SHOP"));
  });

  it("Fotos aus dem Shop übernehmen; Galerie-Eingabe nimmt nur echte Bilder", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    const { adoptShopGallery, saveGalleryTx } = await import("../src/lib/shopify/gallery");
    const { p, v } = await newProduct(`CAT-${tag}-G3`);
    await link(v.id, "Werkzeug & Zubehör", ["a1", "a2"]);
    const r = await adoptShopGallery(p.id, "GENERAL_SHOP", "u-test");
    expect(r.ok && r.items.map((x) => x.mediaId)).toEqual(["a1", "a2"]);
    expect(calls.filter((c) => c.url.startsWith("https://cdn.shopify.com/"))).toHaveLength(2);
    expect((await gallery(p.id)).map((x) => x.mediaId)).toEqual(["a1", "a2"]);
    expect(await adoptShopGallery(p.id, "GENERAL_SHOP")).toEqual({ ok: false, error: "notEmpty" });

    const other = await newProduct(`CAT-${tag}-G4`);
    const pdf = await file(Buffer.from("%PDF-1.4"), "application/pdf"), img = await file(png(5));
    await db.transaction((tx) => saveGalleryTx(tx, other.p.id, "GENERAL_SHOP", [pdf, img]));
    expect((await gallery(other.p.id)).map((x) => x.fileId)).toEqual([img]);
    // nicht verbunden → nichts im Shop zu tun
    const { syncGallery } = await import("../src/lib/shopify/gallery");
    expect(await syncGallery(other.p.id, "GENERAL_SHOP")).toEqual({ status: "notLinked" });

    // Artikel löschen nimmt die Galerie-Fotos mit
    const { deleteProduct } = await import("../src/lib/product-delete");
    await deleteProduct(other.p.id);
    expect(await db.query.storedFiles.findFirst({ where: eq(schema.storedFiles.id, img) })).toBeUndefined();
  });
});
