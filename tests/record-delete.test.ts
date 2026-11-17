import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db";
import {
  customerBlocked, customerUsage, deleteCustomer, deleteSupplier, RecordDeleteError, supplierBlocked, supplierUsage,
  type CustomerUsage, type SupplierUsage,
} from "../src/lib/record-delete";
import { saveExpense } from "../src/lib/expenses";
import { receiveGoods } from "../src/lib/stock";
import { todayIso } from "../src/lib/dates";

// Lieferanten, Firmen aus Ausgaben und Kunden löschen, die aus Versehen angelegt wurden (Wunsch Inhaber 17.11.2026)
describe("Löschen erlaubt? (rein)", () => {
  const s0: SupplierUsage = { receipts: 0, expenses: 0, products: 0, productList: [] };
  const c0: CustomerUsage = { offers: 0, invoices: 0, drafts: 0, draftList: [], returns: 0, shopAccounts: [], reseller: false };
  it("Lieferant: nur ohne Wareneingänge, Ausgaben und Artikel", () => {
    expect(supplierBlocked(s0)).toBe(false);
    expect(supplierBlocked({ ...s0, receipts: 1 })).toBe(true);
    expect(supplierBlocked({ ...s0, expenses: 2 })).toBe(true);
    expect(supplierBlocked({ ...s0, products: 1 })).toBe(true);
  });
  it("Kunde: nur ohne Belege, Entwürfe, Shop-Konto und Shop-Großhandelspreise", () => {
    expect(customerBlocked(c0)).toBe(false);
    for (const k of ["offers", "invoices", "drafts", "returns"] as const) expect(customerBlocked({ ...c0, [k]: 1 })).toBe(true);
    expect(customerBlocked({ ...c0, shopAccounts: ["GENERAL_SHOP"] })).toBe(true);
    expect(customerBlocked({ ...c0, reseller: true })).toBe(true);
  });
});

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("Löschen (Datenbank)", () => {
  const tag = () => crypto.randomUUID().slice(0, 8);
  const uid = async () => (await db.select({ id: schema.users.id }).from(schema.users).limit(1))[0]?.id;
  const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof RecordDeleteError ? e.code : String(e); } };
  const logOf = (entity: string, id: string) => db.query.auditLog.findFirst({ where: and(eq(schema.auditLog.entity, entity), eq(schema.auditLog.entityId, id), eq(schema.auditLog.action, "delete")) });

  it("unbenutzter Lieferant wird gelöscht, Vorher-Stand im Protokoll", async () => {
    const [s] = await db.insert(schema.suppliers).values({ name: `Falsch ${tag()}`, city: "Datteln" }).returning();
    expect(supplierBlocked(await supplierUsage(s.id))).toBe(false);
    await deleteSupplier(s.id, (await uid())!);
    expect(await db.query.suppliers.findFirst({ where: eq(schema.suppliers.id, s.id) })).toBeUndefined();
    const log = await logOf("supplier", s.id);
    expect((log?.before as { name?: string; city?: string })?.city).toBe("Datteln");
    expect(await code(deleteSupplier(s.id, (await uid())!))).toBe("notFound");
  });

  it("Lieferant an einem Artikel: gesperrt, nach dem Umstellen des Artikels löschbar", async () => {
    const t = tag();
    const [s] = await db.insert(schema.suppliers).values({ name: `Am Artikel ${t}` }).returning();
    const [p] = await db.insert(schema.products).values({ sku: `RD-${t}`, nameDe: `Artikel ${t}`, supplierId: s.id }).returning();
    const u = await supplierUsage(s.id);
    expect(u.products).toBe(1);
    expect(u.productList[0]).toEqual({ id: p.id, name: `Artikel ${t}` });
    expect(await code(deleteSupplier(s.id, (await uid())!))).toBe("used");
    await db.update(schema.products).set({ supplierId: null }).where(eq(schema.products.id, p.id));
    expect(await code(deleteSupplier(s.id, (await uid())!))).toBe("ok");
  });

  it("Lieferant mit Wareneingang oder Ausgabe bleibt (Belege 10 Jahre)", async () => {
    const t = tag();
    const [s] = await db.insert(schema.suppliers).values({ name: `Mit Beleg ${t}` }).returning();
    const [p] = await db.insert(schema.products).values({ sku: `RD2-${t}`, nameDe: `Ware ${t}` }).returning();
    const [v] = await db.insert(schema.variants).values({ productId: p.id }).returning();
    await receiveGoods({ supplierId: s.id, date: todayIso(), supplierInvoiceNo: "", note: "", lines: [{ variantId: v.id, qty: 1, unitCostCents: 100, expiryDate: null }] });
    expect((await supplierUsage(s.id)).receipts).toBe(1);
    expect(await code(deleteSupplier(s.id, (await uid())!))).toBe("used");

    const firm = `Baumarkt ${t}`;
    await saveExpense({ date: todayIso(), vendorName: firm, vendorCountry: "DE", vendorVatId: "", invoiceNo: `B-${t}`, category: "STORE_SUPPLIES", taxCase: "DOMESTIC",
      channel: null, amountCents: 119_00, vatRateBp: 1900, paid: true, paidAt: todayIso(), paymentMethod: "CARD", note: "" });
    const f = await db.query.suppliers.findFirst({ where: eq(schema.suppliers.name, firm) });
    expect(f?.kind).toBe("EXPENSE");
    expect((await supplierUsage(f!.id)).expenses).toBe(1);
    expect(await code(deleteSupplier(f!.id, (await uid())!))).toBe("used");
  });

  it("unbenutzter Kunde wird gelöscht: USt-Prüfungen weg, WhatsApp-Chat bleibt ohne Verknüpfung", async () => {
    const t = tag();
    const [c] = await db.insert(schema.customers).values({ name: `Doppelt ${t}`, email: `doppelt-${t}@example.com`, phone: "0178 0000" }).returning();
    await db.insert(schema.vatChecks).values({ customerId: c.id, vatId: "DE123456789", source: "BZST", valid: true });
    const [chat] = await db.insert(schema.waChats).values({ waId: `rd-${t}`, customerId: c.id }).returning();
    expect(customerBlocked(await customerUsage(c.id))).toBe(false);
    await deleteCustomer(c.id, (await uid())!);
    expect(await db.query.customers.findFirst({ where: eq(schema.customers.id, c.id) })).toBeUndefined();
    expect(await db.query.vatChecks.findFirst({ where: eq(schema.vatChecks.customerId, c.id) })).toBeUndefined();
    expect((await db.query.waChats.findFirst({ where: eq(schema.waChats.id, chat.id) }))?.customerId).toBeNull();
    const log = await logOf("customer", c.id);
    expect((log?.before as { customer?: { name?: string }; vatChecks?: unknown[] })?.customer?.name).toBe(`Doppelt ${t}`);
    expect((log?.before as { vatChecks?: unknown[] }).vatChecks).toHaveLength(1);
  });

  it("Kunde mit Rechnungsentwurf: gesperrt, nach dem Löschen des Entwurfs löschbar", async () => {
    const [c] = await db.insert(schema.customers).values({ name: `Mit Entwurf ${tag()}` }).returning();
    const [inv] = await db.insert(schema.invoices).values({ customerId: c.id }).returning();
    const u = await customerUsage(c.id);
    expect(u.drafts).toBe(1);
    expect(u.invoices).toBe(0);
    expect(u.draftList).toEqual([{ id: inv.id }]);
    expect(await code(deleteCustomer(c.id, (await uid())!))).toBe("used");
    await db.delete(schema.invoices).where(eq(schema.invoices.id, inv.id));
    expect(await code(deleteCustomer(c.id, (await uid())!))).toBe("ok");
  });

  it("Kunde mit Konto im Online-Shop bleibt (käme zurück); nur gesperrter Gast ohne Bestellung zählt nicht", async () => {
    const t = tag();
    const [c] = await db.insert(schema.customers).values({ name: `Shop ${t}`, email: `shop-${t}@example.com` }).returning();
    await db.insert(schema.shopCustomers).values({ customerId: c.id, channel: "GENERAL_SHOP", shopCustomerId: `gid://shopify/Customer/${t}`, state: "ENABLED" });
    expect((await customerUsage(c.id)).shopAccounts).toEqual(["GENERAL_SHOP"]);
    expect(await code(deleteCustomer(c.id, (await uid())!))).toBe("used");
    await db.update(schema.shopCustomers).set({ state: "DISABLED", orders: 0 }).where(eq(schema.shopCustomers.customerId, c.id));
    expect(await code(deleteCustomer(c.id, (await uid())!))).toBe("ok");
    expect(await db.query.shopCustomers.findFirst({ where: eq(schema.shopCustomers.customerId, c.id) })).toBeUndefined();
  });

  it("Kunde mit eingeschalteten Shop-Großhandelspreisen bleibt, bis das Häkchen weg und getrennt ist", async () => {
    const t = tag();
    const [c] = await db.insert(schema.customers).values({ name: `B2B ${t}`, email: `b2b-${t}@example.com` }).returning();
    await db.insert(schema.shopCompanies).values({ customerId: c.id, channel: "GENERAL_SHOP", wanted: true, status: "linked" });
    expect((await customerUsage(c.id)).reseller).toBe(true);
    expect(await code(deleteCustomer(c.id, (await uid())!))).toBe("used");
    await db.update(schema.shopCompanies).set({ wanted: false }).where(eq(schema.shopCompanies.customerId, c.id));
    expect(await code(deleteCustomer(c.id, (await uid())!))).toBe("used"); // noch verbunden – erst trennen lassen
    await db.update(schema.shopCompanies).set({ status: "removed" }).where(eq(schema.shopCompanies.customerId, c.id));
    expect(await code(deleteCustomer(c.id, (await uid())!))).toBe("ok");
  });
});
