import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { shopsShowNet, taxModeAction } from "../src/lib/shopify/tax-mode-map";

describe("Preise im Shop mit oder ohne MwSt. (Regeln)", () => {
  it("erstes Mal nur merken, gleich bleibt gleich, Wechsel → alle Preise neu", () => {
    expect(taxModeAction(null, true)).toBe("store");
    expect(taxModeAction(undefined, false)).toBe("store");
    expect(taxModeAction(true, true)).toBe("none");
    expect(taxModeAction(false, false)).toBe("none");
    expect(taxModeAction(true, false)).toBe("repush");
    expect(taxModeAction(false, true)).toBe("repush");
  });

  it("Formular zeigt Nettohinweise, sobald ein eingerichteter Shop netto zeigt", () => {
    const shop = (x: { taxesIncluded: boolean | null; domain?: string }) => ({ domain: "a.myshopify.com", clientSecretEnc: "x", staticTokenEnc: "", ...x });
    expect(shopsShowNet([shop({ taxesIncluded: true }), shop({ taxesIncluded: null })])).toBe(false);
    expect(shopsShowNet([shop({ taxesIncluded: true }), shop({ taxesIncluded: false })])).toBe(true);
    expect(shopsShowNet([shop({ taxesIncluded: false, domain: "" })])).toBe(false); // nicht eingerichtet zählt nicht
    expect(shopsShowNet([])).toBe(false);
  });
});

// ───────────── mit Datenbank und simuliertem Shopify ─────────────
const run = process.env.DATABASE_URL ? describe : describe.skip;
run("Shop stellt auf Nettopreise um → alle Preise neu (Datenbank, Shopify simuliert)", async () => {
  const { db, schema } = await import("../src/db");
  const { eq } = await import("drizzle-orm");
  const { encrypt } = await import("../src/lib/crypto");
  const { watchTaxModes } = await import("../src/lib/shopify/tax-mode");
  const tag = String(Date.now()).slice(-8);
  let shopTaxesIncluded = true;
  let updates: { productId: string; variants: { id: string; price: string }[] }[] = [];
  // Preise, wie sie gerade im Shop stehen (brutto, vom bisherigen Abgleich)
  const shopPrice = new Map<string, string>();

  function shopifyMock() {
    return vi.fn(async (url: string, init?: { body?: unknown }) => {
      if (url.endsWith("/admin/oauth/access_token")) return Response.json({ access_token: "tok", scope: "x", expires_in: 86399 });
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (query.includes("markets(")) return Response.json({ data: { shop: { taxesIncluded: shopTaxesIncluded }, markets: { nodes: [] } } });
      if (query.includes("priceLists(")) return Response.json({ data: { shop: { taxesIncluded: shopTaxesIncluded }, priceLists: { nodes: [] } } });
      if (query.includes("taxesIncluded")) return Response.json({ data: { shop: { taxesIncluded: shopTaxesIncluded } } });
      if (query.includes("nodes(ids:")) return Response.json({ data: { nodes: (variables.ids as string[]).map((id) =>
        ({ id, price: shopPrice.get(id) ?? "0.00", compareAtPrice: null, product: { id: `gid://shopify/Product/${tag}` } })) } });
      if (query.includes("productVariantsBulkUpdate")) {
        const u = variables as { productId: string; variants: { id: string; price: string }[] };
        updates.push(u);
        for (const x of u.variants) shopPrice.set(x.id, x.price);
        return Response.json({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } });
      }
      return Response.json({ errors: [{ message: `unexpected ${query.slice(0, 60)}` }] });
    });
  }

  let svA = "", svB = "";
  beforeAll(async () => {
    const shop = { domain: "star-general.myshopify.com", clientId: "cid", clientSecretEnc: encrypt("geheim"), staticTokenEnc: "", tokenEnc: "", tokenExpiresAt: null,
      active: false, locationId: "gid://shopify/Location/77", taxesIncluded: null };
    await db.insert(schema.shops).values({ channel: "GENERAL_SHOP", ...shop }).onConflictDoUpdate({ target: schema.shops.channel, set: shop });
    const brand = { domain: "", clientId: "", clientSecretEnc: "", staticTokenEnc: "", tokenEnc: "", locationId: "", taxesIncluded: null };
    await db.insert(schema.shops).values({ channel: "BRAND_SHOP", ...brand }).onConflictDoUpdate({ target: schema.shops.channel, set: brand });
    // Netto 100,00 € → im Shop bisher 119,00 €; zweite Größe mit eigenem Preis 25,13 € → bisher 29,90 €
    const [p] = await db.insert(schema.products).values({ sku: `TAX-${tag}`, nameDe: `Netto-Test ${tag}`, vatRateBp: 1900, retailPriceCents: 10000, wholesalePriceCents: 5000, inGeneralShop: true }).returning();
    const [a] = await db.insert(schema.variants).values({ productId: p.id, size: "S", barcode: `49${tag}1` }).returning();
    const [b] = await db.insert(schema.variants).values({ productId: p.id, size: "M", barcode: `49${tag}2`, retailPriceCents: 2513 }).returning();
    svA = `gid://shopify/ProductVariant/${tag}1`; svB = `gid://shopify/ProductVariant/${tag}2`;
    await db.insert(schema.shopVariants).values([
      { channel: "GENERAL_SHOP", shopVariantId: svA, variantId: a.id, matchedBy: "barcode" },
      { channel: "GENERAL_SHOP", shopVariantId: svB, variantId: b.id, matchedBy: "barcode" },
    ]);
    shopPrice.set(svA, "119.00"); shopPrice.set(svB, "29.90");
  });
  afterEach(() => { vi.unstubAllGlobals(); updates = []; });

  const stored = async () => (await db.query.shops.findFirst({ where: eq(schema.shops.channel, "GENERAL_SHOP") }))!.taxesIncluded;

  it("erster Lauf merkt sich nur die Einstellung, schickt nichts", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    shopTaxesIncluded = true;
    expect(await watchTaxModes()).toEqual([{ channel: "GENERAL_SHOP", action: "store", ok: true }]);
    expect(updates).toEqual([]);
    expect(await stored()).toBe(true);
    expect(await watchTaxModes()).toEqual([]); // unverändert → nichts
  });

  it("Shop zeigt jetzt netto → alle Preise netto neu, Einstellung gemerkt; zurück auf brutto → wieder brutto", async () => {
    vi.stubGlobal("fetch", shopifyMock());
    shopTaxesIncluded = false;
    expect(await watchTaxModes()).toEqual([{ channel: "GENERAL_SHOP", action: "repush", ok: true }]);
    const sent = Object.fromEntries(updates.flatMap((u) => u.variants).map((x) => [x.id, x.price]));
    expect(sent[svA]).toBe("100.00");
    expect(sent[svB]).toBe("25.13");
    expect(await stored()).toBe(false);
    const ev = await db.select().from(schema.shopEvents).where(eq(schema.shopEvents.message, "taxMode:net"));
    expect(ev.length).toBeGreaterThan(0);

    updates = [];
    expect(await watchTaxModes()).toEqual([]); // gleich geblieben

    shopTaxesIncluded = true;
    expect(await watchTaxModes()).toEqual([{ channel: "GENERAL_SHOP", action: "repush", ok: true }]);
    const back = Object.fromEntries(updates.flatMap((u) => u.variants).map((x) => [x.id, x.price]));
    expect(back[svA]).toBe("119.00");
    expect(back[svB]).toBe("29.90"); // runder Bruttopreis wie vorher
    expect(await stored()).toBe(true);
  });

  it("Shop kurz nicht erreichbar → nichts gemerkt, nächster Lauf versucht es wieder", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await watchTaxModes()).toEqual([]);
    expect(await stored()).toBe(true);
  }, 60_000); // der Shopify-Client versucht es bei Netzfehlern mehrmals mit Pause
});
