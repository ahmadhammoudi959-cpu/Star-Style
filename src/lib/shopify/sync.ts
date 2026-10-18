import "server-only";
/**
 * Abgleich mit Shopify: Produkte zuordnen, Bestand melden, Bestellungen als Rechnungen übernehmen,
 * Stornos und Erstattungen nachziehen. Unser System ist die Wahrheit für den Bestand.
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, schema } from "@/db";
import { gql, getShop, ShopifyError, type Shop, type ShopChannel } from "./client";
import { berlinDate, cents, mapOrder, PAID, quantitiesAfterRefund, type ShopOrder } from "./order-map";
import { cancelInvoice, issueInvoice, saveInvoiceDraft, startCorrection, SalesError } from "../sales";
import { cancelPayment, PaymentError, recordPayment } from "../payments";
import { bookWriteOff } from "../stock";
import { todayIso } from "../dates";

export const CHANNELS: ShopChannel[] = ["BRAND_SHOP", "GENERAL_SHOP"];

// ───────────────────────── Protokoll ─────────────────────────

export async function logEvent(channel: ShopChannel, level: "info" | "warn" | "error", kind: string, message: string, ref = "", invoiceId: string | null = null) {
  await db.insert(schema.shopEvents).values({ channel, level, kind, message: message.slice(0, 1000), ref, invoiceId });
}
/** true, wenn der Schlüssel neu ist (Vorgang noch nicht verarbeitet) */
async function once(key: string) {
  const r = await db.insert(schema.shopProcessed).values({ key }).onConflictDoNothing().returning({ key: schema.shopProcessed.key });
  return r.length > 0;
}
async function seen(key: string) {
  return Boolean(await db.query.shopProcessed.findFirst({ where: eq(schema.shopProcessed.key, key) }));
}

async function readyShop(channel: ShopChannel, needLocation = false): Promise<Shop> {
  const s = await getShop(channel);
  if (!s || !s.domain) throw new ShopifyError("notConfigured", "Shop nicht eingerichtet");
  if (needLocation && !s.locationId) throw new ShopifyError("notConfigured", "Lagerort fehlt");
  return s;
}

// ───────────────────────── Verbindung ─────────────────────────

export async function testConnection(channel: ShopChannel) {
  const shop = await readyShop(channel);
  const d = await gql<{ shop: { name: string; myshopifyDomain: string; currencyCode: string }; locations: { nodes: { id: string; name: string; isActive: boolean }[] } }>(shop,
    `{ shop { name myshopifyDomain currencyCode } locations(first: 20) { nodes { id name isActive } } }`);
  return { name: d.shop.name, currency: d.shop.currencyCode, locations: d.locations.nodes.filter((l) => l.isActive) };
}

// ───────────────────────── Produkte zuordnen ─────────────────────────

const PRODUCTS_Q = `query($after: String) { productVariants(first: 250, after: $after) {
  pageInfo { hasNextPage endCursor }
  nodes { id sku barcode displayName inventoryItem { id tracked } } } }`;

export async function syncProducts(channel: ShopChannel) {
  const shop = await readyShop(channel);
  const started = new Date();
  let after: string | null = null, total = 0;
  do {
    const d: { productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { id: string; sku: string | null; barcode: string | null; displayName: string; inventoryItem: { id: string; tracked: boolean } | null }[] } } =
      await gql(shop, PRODUCTS_Q, { after });
    for (const n of d.productVariants.nodes) {
      total++;
      await db.insert(schema.shopVariants).values({
        channel, shopVariantId: n.id, inventoryItemId: n.inventoryItem?.id ?? "", title: n.displayName.slice(0, 300), sku: (n.sku ?? "").trim(),
        barcode: (n.barcode ?? "").trim(), tracked: n.inventoryItem?.tracked ?? false, seenAt: started,
      }).onConflictDoUpdate({
        target: [schema.shopVariants.channel, schema.shopVariants.shopVariantId],
        set: { inventoryItemId: n.inventoryItem?.id ?? "", title: n.displayName.slice(0, 300), sku: (n.sku ?? "").trim(), barcode: (n.barcode ?? "").trim(), tracked: n.inventoryItem?.tracked ?? false, seenAt: started },
      });
    }
    after = d.productVariants.pageInfo.hasNextPage ? d.productVariants.pageInfo.endCursor : null;
  } while (after);
  // im Shop gelöschte Varianten entfernen
  await db.delete(schema.shopVariants).where(and(eq(schema.shopVariants.channel, channel), sql`${schema.shopVariants.seenAt} < ${started}`));
  // automatisch zuordnen: 1) EAN/Barcode  2) Artikelnummer bei Artikeln mit genau einer Variante
  await db.execute(sql`
    update shop_variants sv set variant_id = v.id, matched_by = 'barcode'
    from variants v where sv.channel = ${channel} and sv.variant_id is null and sv.barcode <> '' and v.barcode = sv.barcode and v.active`);
  await db.execute(sql`
    update shop_variants sv set variant_id = x.vid, matched_by = 'sku'
    from (select p.sku, min(v.id) as vid from products p join variants v on v.product_id = p.id and v.active
          where p.active group by p.sku having count(*) = 1) x
    where sv.channel = ${channel} and sv.variant_id is null and sv.sku <> '' and lower(sv.sku) = lower(x.sku)`);
  const counts = await db.execute<{ matched: number; open: number }>(sql`
    select count(*) filter (where variant_id is not null)::int as matched, count(*) filter (where variant_id is null and tracked)::int as open
    from shop_variants where channel = ${channel}`);
  await db.update(schema.shops).set({ lastProductSync: new Date() }).where(eq(schema.shops.channel, channel));
  const { matched, open } = counts.rows[0];
  await logEvent(channel, open ? "warn" : "info", "products", `productsLoaded:${total}|${matched}|${open}`);
  return { total, matched, open };
}

export async function linkVariant(channel: ShopChannel, shopVariantRowId: string, variantId: string | null) {
  await db.update(schema.shopVariants).set({ variantId, matchedBy: variantId ? "manual" : "", lastPushedQty: null })
    .where(and(eq(schema.shopVariants.id, shopVariantRowId), eq(schema.shopVariants.channel, channel)));
  if (variantId) await db.execute(sql`insert into stock_dirty (variant_id) values (${variantId}) on conflict (variant_id) do update set at = now()`);
}

// ───────────────────────── Bestand melden ─────────────────────────

const SET_Q = `mutation set($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) { userErrors { code field message } } }`;

/** Verfügbaren Bestand (Lager − Reservierungen − Puffer) an den Shop melden. Nur geänderte Werte, außer force. */
export async function pushStock(channel: ShopChannel, o: { variantIds?: string[]; force?: boolean } = {}) {
  const shop = await readyShop(channel, true);
  if (!shop.active) return { pushed: 0, errors: 0 };
  const rows = await db.execute<{ id: string; inventory_item_id: string; last_pushed_qty: number | null; available: number }>(sql`
    select sv.id, sv.inventory_item_id, sv.last_pushed_qty,
      greatest(0, v.stock_qty - coalesce((select sum(r.qty) from reservations r where r.variant_id = v.id and r.active and r.expires_at > now()), 0) - ${shop.stockBuffer})::int as available
    from shop_variants sv join variants v on v.id = sv.variant_id
    where sv.channel = ${channel} and sv.tracked and sv.inventory_item_id <> ''
      ${o.variantIds?.length ? sql`and sv.variant_id in (${sql.join(o.variantIds.map((v) => sql`${v}`), sql`, `)})` : sql``}`);
  const todo = rows.rows.filter((r) => o.force || r.last_pushed_qty !== r.available);
  let pushed = 0, errors = 0;
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    const d = await gql<{ inventorySetQuantities: { userErrors: { code: string | null; field: string[] | null; message: string }[] } }>(shop, SET_Q, {
      key: randomUUID(),
      input: {
        name: "available", reason: "correction", referenceDocumentUri: `star-style://stock-sync/${randomUUID()}`,
        quantities: chunk.map((r) => ({ inventoryItemId: r.inventory_item_id, locationId: shop.locationId, quantity: r.available, changeFromQuantity: null })),
      },
    });
    const bad = new Map<number, string>();
    for (const e of d.inventorySetQuantities.userErrors) {
      const idx = Number(e.field?.find((f, k) => e.field![k - 1] === "quantities"));
      if (Number.isInteger(idx)) bad.set(idx, e.message); else chunk.forEach((_, k) => bad.set(k, e.message));
    }
    for (const [k, r] of chunk.entries()) {
      if (bad.has(k)) { errors++; await db.update(schema.shopVariants).set({ pushError: bad.get(k)!.slice(0, 300) }).where(eq(schema.shopVariants.id, r.id)); }
      else { pushed++; await db.update(schema.shopVariants).set({ lastPushedQty: r.available, lastPushedAt: new Date(), pushError: "" }).where(eq(schema.shopVariants.id, r.id)); }
    }
  }
  await db.update(schema.shops).set({ lastStockSync: new Date() }).where(eq(schema.shops.channel, channel));
  if (errors) await logEvent(channel, "warn", "stock", `stockErrors:${errors}`);
  return { pushed, errors };
}

/** Geänderte Bestände an alle aktiven Shops melden; Einträge erst nach Erfolg entfernen. */
export async function processDirty() {
  const dirty = await db.select().from(schema.stockDirty);
  if (!dirty.length) return 0;
  const ids = dirty.map((d) => d.variantId);
  const until = new Date(Math.max(...dirty.map((d) => d.at.getTime())));
  const shops = await db.select().from(schema.shops).where(and(eq(schema.shops.active, true), sql`${schema.shops.locationId} <> ''`));
  for (const s of shops) await pushStock(s.channel as ShopChannel, { variantIds: ids });
  // Zeitvergleich auf Millisekunden (JS-Datum hat keine Mikrosekunden)
  await db.delete(schema.stockDirty).where(and(inArray(schema.stockDirty.variantId, ids), sql`date_trunc('milliseconds', ${schema.stockDirty.at}) <= ${until}`));
  return ids.length;
}

// ───────────────────────── Bestellungen ─────────────────────────

const ORDER_FIELDS = `id name createdAt updatedAt processedAt cancelledAt test email currencyCode taxesIncluded displayFinancialStatus paymentGatewayNames
  billingAddress { firstName lastName company address1 address2 zip city countryCodeV2 phone }
  shippingAddress { firstName lastName company address1 address2 zip city countryCodeV2 phone }
  totalPriceSet { shopMoney { amount } } currentTotalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } } totalRefundedSet { shopMoney { amount } }
  lineItems(first: 100) { nodes { id sku title variantTitle quantity variant { id } discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } } taxLines { rate } } }
  shippingLines(first: 10) { nodes { title discountedPriceSet { shopMoney { amount } } taxLines { rate } } }
  refunds { id createdAt totalRefundedSet { shopMoney { amount } } refundLineItems(first: 100) { nodes { quantity restockType lineItem { id } } } }`;

export async function fetchOrder(shop: Shop, id: string) {
  const d = await gql<{ order: ShopOrder | null }>(shop, `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`, { id });
  return d.order;
}

export async function syncOrders(channel: ShopChannel) {
  const shop = await readyShop(channel);
  if (!shop.active) return { processed: 0 };
  const started = new Date();
  const since = shop.lastOrderSync ? new Date(shop.lastOrderSync.getTime() - 10 * 60_000) : shop.ordersSince ?? new Date(Date.now() - 86_400_000);
  let after: string | null = null, processed = 0;
  do {
    const d: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: ShopOrder[] } } = await gql(shop,
      `query($after: String, $q: String) { orders(first: 25, after: $after, sortKey: UPDATED_AT, query: $q) { pageInfo { hasNextPage endCursor } nodes { ${ORDER_FIELDS} } } }`,
      { after, q: `updated_at:>='${since.toISOString()}'` });
    for (const o of d.orders.nodes) { await processOrder(shop, o); processed++; }
    after = d.orders.pageInfo.hasNextPage ? d.orders.pageInfo.endCursor : null;
  } while (after);
  await db.update(schema.shops).set({ lastOrderSync: started, lastError: "" }).where(eq(schema.shops.channel, channel));
  return { processed };
}

// Eine Bestellung nie gleichzeitig zweimal verarbeiten (Webhook + Abgleich)
const locks = new Map<string, Promise<unknown>>();
export function processOrder(shop: Shop, o: ShopOrder) {
  const key = `${shop.channel}:${o.id}`;
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => doProcessOrder(shop, o));
  locks.set(key, next);
  return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
}

async function currentInvoice(channel: ShopChannel, externalId: string) {
  return db.query.invoices.findFirst({
    where: and(eq(schema.invoices.channel, channel), eq(schema.invoices.externalOrderId, externalId), eq(schema.invoices.kind, "INVOICE"), isNotNull(schema.invoices.number)),
    orderBy: [desc(schema.invoices.createdAt)], with: { lines: true, payments: true },
  });
}

async function findOrCreateCustomer(c: ReturnType<typeof mapOrder>["customer"]) {
  if (c.email) {
    const ex = await db.query.customers.findFirst({ where: sql`lower(${schema.customers.email}) = ${c.email}` });
    if (ex) return ex.id;
  }
  const [row] = await db.insert(schema.customers).values({
    name: c.name, type: c.type, contact: c.contact, email: c.email, phone: c.phone, street: c.street, zip: c.zip, city: c.city, country: c.country,
    priceGroup: "RETAIL", notes: "aus Shopify angelegt",
  }).returning({ id: schema.customers.id });
  return row.id;
}

async function payInvoice(invoiceId: string, amountCents: number, date: string, note: string) {
  if (amountCents <= 0) return;
  try { await recordPayment({ invoiceId, date, amountCents, method: "ONLINE", note, allowOverpay: false }); }
  catch (e) {
    if (e instanceof PaymentError && e.code === "periodLocked") await recordPayment({ invoiceId, date: todayIso(), amountCents, method: "ONLINE", note });
    else if (e instanceof PaymentError && e.code === "overpay" && e.detail) await recordPayment({ invoiceId, date, amountCents: Number(e.detail), method: "ONLINE", note });
    else throw e;
  }
}

async function cancelAllPayments(invoiceId: string, reason: string) {
  const ps = await db.query.payments.findMany({ where: and(eq(schema.payments.invoiceId, invoiceId), isNull(schema.payments.cancelledAt)) });
  for (const p of ps) await cancelPayment(p.id, reason);
  return ps.reduce((s, p) => s + p.amountCents, 0);
}

async function doProcessOrder(shop: Shop, o: ShopOrder) {
  const channel = shop.channel as ShopChannel;
  let inv = await currentInvoice(channel, o.id);

  // 1) Neue Bestellung → Rechnung
  if (!inv) {
    if (o.test && !shop.importTestOrders) return;
    if (shop.ordersSince && new Date(o.createdAt) < shop.ordersSince) return;
    if (o.cancelledAt) return;
    const links = new Map((await db.select({ s: schema.shopVariants.shopVariantId, v: schema.shopVariants.variantId }).from(schema.shopVariants)
      .where(and(eq(schema.shopVariants.channel, channel), isNotNull(schema.shopVariants.variantId)))).map((r) => [r.s, r.v!]));
    const m = mapOrder(o, links);
    if (m.skip) {
      if (await once(`review:${channel}:${o.id}`)) await logEvent(channel, "warn", "review", `skip:${m.skip}`, o.name);
      return;
    }
    const customerId = await findOrCreateCustomer(m.customer);
    const draft = await saveInvoiceDraft({
      customerId, channel, discountBp: 0, notes: `Shop-Bestellung ${o.name}`, lines: m.lines, deliveryDate: m.date, retentionOfTitle: false,
      pricesGross: m.pricesGross, taxOverride: { mode: m.taxMode, ossCountry: m.ossCountry }, externalOrderId: o.id,
    });
    await issueInvoice(draft, undefined, { allowNegativeStock: true });
    inv = (await currentInvoice(channel, o.id))!;
    await logEvent(channel, "info", "order", `imported:${inv.number}`, o.name, inv.id);
    for (const w of m.warnings) await logEvent(channel, "warn", "order", w, o.name, inv.id);
    if (m.paid) {
      const paidCents = Math.abs(m.totalCents - inv.grossCents) <= 2 ? inv.grossCents : Math.min(m.totalCents, inv.grossCents);
      await payInvoice(inv.id, paidCents, berlinDate(o.processedAt ?? o.createdAt), `Shopify ${o.name} · ${o.paymentGatewayNames.join(", ")}`);
      inv = (await currentInvoice(channel, o.id))!;
    }
  }
  if (inv.status !== "ISSUED") return; // bereits storniert

  // 2) Storno im Shop → Stornorechnung, Zahlung zurück
  if (o.cancelledAt) {
    if (!(await once(`cancel:${channel}:${o.id}`))) return;
    await cancelInvoice(inv.id);
    const refunded = cents(o.totalRefundedSet) > 0 || ["REFUNDED", "VOIDED"].includes(o.displayFinancialStatus ?? "");
    if (refunded) await cancelAllPayments(inv.id, `Shopify-Storno ${o.name}`);
    for (const r of o.refunds) await once(`refund:${channel}:${r.id}`);
    await logEvent(channel, "info", "cancel", refunded ? "cancelledRefunded" : "cancelledKeepPayment", o.name, inv.id);
    return;
  }

  // 3) Erstattungen
  for (const r of [...o.refunds].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (await seen(`refund:${channel}:${r.id}`)) continue;
    inv = (await currentInvoice(channel, o.id))!;
    if (inv.status !== "ISSUED") break;
    const refundCents = cents(r.totalRefundedSet);
    const lines = [...inv.lines].sort((a, b) => a.position - b.position);
    const after = quantitiesAfterRefund(lines, r);
    const products = after.filter((l) => l.externalLineId !== "shipping");
    const fullyRefunded = o.displayFinancialStatus === "REFUNDED" || (products.length > 0 && products.every((l) => l.qty === 0));
    await once(`refund:${channel}:${r.id}`);
    if (fullyRefunded) {
      await cancelInvoice(inv.id);
      await cancelAllPayments(inv.id, `Shopify-Erstattung ${o.name}`);
      await logEvent(channel, "info", "refund", "fullRefund", o.name, inv.id);
      await writeOffNotRestocked(channel, o, r, lines);
      return;
    }
    if (!r.refundLineItems.nodes.length) {
      await logEvent(channel, "warn", "refund", `amountOnly:${refundCents}`, o.name, inv.id);
      continue;
    }
    // Teil-Erstattung: Korrektur (Storno + neue Rechnung mit Restmengen), Zahlung anpassen
    const draft = await startCorrection(inv.id);
    await saveInvoiceDraft({
      id: draft, customerId: inv.customerId, replacesInvoiceId: inv.id, channel, discountBp: 0, notes: `${inv.notes} · Teil-Erstattung`.slice(0, 1000),
      deliveryDate: inv.deliveryDate, retentionOfTitle: false, pricesGross: inv.pricesGross, externalOrderId: o.id,
      taxOverride: { mode: inv.taxMode, ossCountry: inv.ossCountry },
      lines: after.filter((l) => l.qty > 0).map((l) => {
        const src = lines.find((x) => x.id === (l as { id?: string }).id)!;
        return { variantId: src.variantId, description: src.description, qty: l.qty, unitPriceCents: src.unitPriceCents, discountBp: src.discountBp, vatRateBp: src.vatRateBp, externalLineId: src.externalLineId };
      }),
    });
    await issueInvoice(draft, undefined, { allowNegativeStock: true });
    const fresh = (await currentInvoice(channel, o.id))!;
    const paidBefore = await cancelAllPayments(fresh.id, `Shopify-Erstattung ${o.name}`);
    const remaining = paidBefore - refundCents;
    if (remaining > 0) await payInvoice(fresh.id, Math.min(remaining, fresh.grossCents), todayIso(), `Shopify ${o.name} nach Erstattung`);
    if (paidBefore > 0 && Math.abs(remaining - fresh.grossCents) > 2) await logEvent(channel, "warn", "refund", `checkAmounts:${remaining - fresh.grossCents}`, o.name, fresh.id);
    await logEvent(channel, "info", "refund", `partial:${fresh.number}`, o.name, fresh.id);
    await writeOffNotRestocked(channel, o, r, lines);
  }

  // 4) Später bezahlt (z. B. Vorkasse)
  inv = (await currentInvoice(channel, o.id))!;
  if (inv.status === "ISSUED" && PAID.includes(o.displayFinancialStatus ?? "") && !inv.payments.some((p) => !p.cancelledAt)) {
    const open = Math.min(inv.grossCents, cents(o.currentTotalPriceSet));
    await payInvoice(inv.id, open, todayIso(), `Shopify ${o.name} · ${o.paymentGatewayNames.join(", ")}`);
    await logEvent(channel, "info", "payment", "paid", o.name, inv.id);
  }
}

/** Erstattete Ware, die nicht zurück ins Lager kommt (restockType NO_RESTOCK), als Verlust ausbuchen. */
async function writeOffNotRestocked(channel: ShopChannel, o: ShopOrder, r: ShopOrder["refunds"][number], lines: { externalLineId: string | null; variantId: string | null }[]) {
  const items = r.refundLineItems.nodes.filter((x) => x.restockType === "NO_RESTOCK")
    .map((x) => ({ variantId: lines.find((l) => l.externalLineId === x.lineItem.id)?.variantId, qty: x.quantity }))
    .filter((x): x is { variantId: string; qty: number } => Boolean(x.variantId) && x.qty > 0);
  if (!items.length) return;
  try {
    await bookWriteOff({ date: todayIso(), reason: "LOSS", note: `Shopify-Erstattung ohne Rückgabe ${o.name}`, lines: items.map((i) => ({ variantId: i.variantId, qty: i.qty })), photoFileId: null });
    await logEvent(channel, "info", "refund", "writtenOff", o.name);
  } catch (e) { await logEvent(channel, "warn", "refund", `writeOffFailed:${(e as Error).message}`, o.name); }
}

// ───────────────────────── Ein kompletter Durchlauf ─────────────────────────

export async function runCycle(o: { orders?: boolean; reconcile?: boolean } = {}) {
  await processDirty().catch((e) => console.error("shopify dirty", e));
  const shops = await db.select().from(schema.shops).where(eq(schema.shops.active, true));
  for (const s of shops) {
    const ch = s.channel as ShopChannel;
    try {
      if (o.orders) await syncOrders(ch);
      if (o.reconcile && s.locationId) await pushStock(ch);
    } catch (e) {
      const msg = e instanceof ShopifyError || e instanceof SalesError ? `${e.constructor.name}:${(e as Error).message}` : String(e);
      await db.update(schema.shops).set({ lastError: msg.slice(0, 500) }).where(eq(schema.shops.channel, ch));
      await logEvent(ch, "error", "sync", msg);
    }
  }
}
