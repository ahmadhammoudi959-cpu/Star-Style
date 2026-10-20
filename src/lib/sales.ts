/**
 * Verkauf: Angebote, Rechnungen, Storno, Korrektur.
 * Regeln: ausgestellte Rechnungen sind unveränderlich; Korrekturen = Storno + neue Rechnung.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { db, schema, type Tx } from "@/db";
import { nextNumber } from "./numbering";
import { addStock, audit, markDirty, removeStock, StockError } from "./stock";
import { computeTotals, determineTaxMode, effectiveRateBp, OSS_THRESHOLD_CENTS, type TaxMode } from "./tax";
import { addDaysIso, formatDate, todayIso } from "./dates";
import { fitPlanToGross, movePayments, recordPaymentTx } from "./payments";

export class SalesError extends Error {
  constructor(public code: string, public detail?: string) { super(code); }
}

type Channel = (typeof schema.channel.enumValues)[number];

export type LineInput = {
  variantId: string | null; description: string; qty: number; unitPriceCents: number; discountBp: number; vatRateBp: number;
  externalLineId?: string | null;
};

function validateLines(lines: LineInput[]) {
  if (!lines.length) throw new SalesError("noLines");
  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new SalesError("qty");
    if (!Number.isInteger(l.unitPriceCents) || l.unitPriceCents < 0) throw new SalesError("price");
    if (!Number.isInteger(l.discountBp) || l.discountBp < 0 || l.discountBp > 10000) throw new SalesError("discount");
    if (!l.description.trim()) throw new SalesError("description");
  }
}

// ───────────────────────── OSS-Schwelle ─────────────────────────

/** EU-Privatumsätze (netto) im laufenden und im Vorjahr – Schwelle 10.000 € EU-weit. */
export async function ossExceeded(tx: Tx | typeof db, year: number, additionalNetCents = 0): Promise<boolean> {
  const r = await tx.execute<{ cur: string; prev: string }>(sql`
    select
      coalesce(sum(case when extract(year from issue_date) = ${year} then net_cents end), 0) as cur,
      coalesce(sum(case when extract(year from issue_date) = ${year - 1} then net_cents end), 0) as prev
    from invoices where status <> 'DRAFT' and tax_mode = 'EU_B2C'`);
  const cur = Number(r.rows[0].cur), prev = Number(r.rows[0].prev);
  return prev > OSS_THRESHOLD_CENTS || cur + additionalNetCents > OSS_THRESHOLD_CENTS;
}

/** Steuerbehandlung + Steuersätze der Positionen für einen Kunden bestimmen. */
export async function applyTax(tx: Tx | typeof db, customer: typeof schema.customers.$inferSelect, lines: LineInput[], productRates: Map<string, number>, docDiscountBp: number, year: number, gross = false) {
  const mode: TaxMode = determineTaxMode(customer);
  const base = lines.map((l) => ({ ...l, vatRateBp: l.variantId ? productRates.get(l.variantId) ?? l.vatRateBp : l.vatRateBp }));
  let exceeded = false;
  if (mode === "EU_B2C") {
    const netGuess = computeTotals(base, docDiscountBp, { gross }).netCents;
    exceeded = await ossExceeded(tx, year, netGuess);
  }
  const taxed = base.map((l) => ({ ...l, vatRateBp: effectiveRateBp(mode, l.vatRateBp, { country: customer.country, ossExceeded: exceeded }) }));
  return { mode, ossCountry: mode === "EU_B2C" && exceeded ? customer.country : null, lines: taxed, totals: computeTotals(taxed, docDiscountBp, { gross }) };
}

async function productRatesFor(tx: Tx | typeof db, variantIds: string[]) {
  const m = new Map<string, number>();
  if (!variantIds.length) return m;
  const rows = await tx.select({ id: schema.variants.id, rate: schema.products.vatRateBp })
    .from(schema.variants).innerJoin(schema.products, eq(schema.products.id, schema.variants.productId))
    .where(inArray(schema.variants.id, variantIds));
  rows.forEach((r) => m.set(r.id, r.rate));
  return m;
}

// ───────────────────────── Angebote ─────────────────────────

export type OfferInput = {
  id?: string; customerId: string; date: string; validUntil: string; discountBp: number; notes: string; lines: LineInput[];
};

/** Verfügbarkeit = Bestand − aktive Reservierungen anderer Angebote */
export async function availability(tx: Tx | typeof db, variantIds: string[], excludeOfferId?: string) {
  const m = new Map<string, number>();
  if (!variantIds.length) return m;
  const r = await tx.execute<{ id: string; avail: number }>(sql`
    select v.id, v.stock_qty - coalesce((
      select sum(r.qty) from reservations r
      where r.variant_id = v.id and r.active and r.expires_at > now() ${excludeOfferId ? sql`and r.offer_id <> ${excludeOfferId}` : sql``}
    ), 0) as avail
    from variants v where v.id in (${sql.join(variantIds.map((i) => sql`${i}`), sql`, `)})`);
  r.rows.forEach((x) => m.set(String(x.id), Number(x.avail)));
  return m;
}

export async function saveOffer(input: OfferInput, userId?: string) {
  validateLines(input.lines);
  return db.transaction(async (tx) => {
    const customer = await tx.query.customers.findFirst({ where: eq(schema.customers.id, input.customerId) });
    if (!customer) throw new SalesError("noCustomer");
    const rates = await productRatesFor(tx, input.lines.flatMap((l) => (l.variantId ? [l.variantId] : [])));
    const { lines } = await applyTax(tx, customer, input.lines, rates, input.discountBp, Number(input.date.slice(0, 4)));

    let offerId = input.id;
    if (offerId) {
      const ex = await tx.query.offers.findFirst({ where: eq(schema.offers.id, offerId) });
      if (!ex) throw new SalesError("notFound");
      if (!["DRAFT", "SENT"].includes(ex.status)) throw new SalesError("locked");
      await tx.update(schema.offers).set({
        customerId: input.customerId, date: input.date, validUntil: input.validUntil, discountBp: input.discountBp, notes: input.notes,
      }).where(eq(schema.offers.id, offerId));
      await tx.delete(schema.offerLines).where(eq(schema.offerLines.offerId, offerId));
      const oldRes = await tx.delete(schema.reservations).where(eq(schema.reservations.offerId, offerId)).returning({ v: schema.reservations.variantId });
      await markDirty(tx, oldRes.map((r) => r.v));
    } else {
      const number = await nextNumber(tx, "OFFER", Number(input.date.slice(0, 4)));
      const [o] = await tx.insert(schema.offers).values({
        number, customerId: input.customerId, date: input.date, validUntil: input.validUntil, discountBp: input.discountBp, notes: input.notes,
      }).returning({ id: schema.offers.id });
      offerId = o.id;
    }
    await tx.insert(schema.offerLines).values(lines.map((l, i) => ({ offerId: offerId!, position: i + 1, ...l })));
    // Ware für die Gültigkeitsdauer reservieren (bis Ende des letzten Tages)
    const perVariant = new Map<string, number>();
    lines.forEach((l) => l.variantId && perVariant.set(l.variantId, (perVariant.get(l.variantId) ?? 0) + l.qty));
    const expiresAt = new Date(input.validUntil + "T23:59:59+02:00");
    for (const [variantId, qty] of perVariant) {
      await tx.insert(schema.reservations).values({ offerId: offerId!, variantId, qty, expiresAt });
    }
    await markDirty(tx, [...perVariant.keys()]);
    await audit(tx, { entity: "offer", entityId: offerId!, action: input.id ? "update" : "create", after: input, userId });
    return offerId!;
  });
}

export async function setOfferStatus(offerId: string, status: "SENT" | "ACCEPTED" | "REJECTED", acceptedVia = "", userId?: string) {
  await db.transaction(async (tx) => {
    const o = await tx.query.offers.findFirst({ where: eq(schema.offers.id, offerId) });
    if (!o) throw new SalesError("notFound");
    if (["CONVERTED", "REJECTED", "EXPIRED"].includes(o.status)) throw new SalesError("locked");
    await tx.update(schema.offers).set({
      status,
      ...(status === "SENT" ? { sentAt: new Date() } : {}),
      ...(status === "ACCEPTED" ? { acceptedAt: new Date(), acceptedVia } : {}),
    }).where(eq(schema.offers.id, offerId));
    if (status === "REJECTED") {
      const r = await tx.update(schema.reservations).set({ active: false }).where(eq(schema.reservations.offerId, offerId)).returning({ v: schema.reservations.variantId });
      await markDirty(tx, r.map((x) => x.v));
    }
    await audit(tx, { entity: "offer", entityId: offerId, action: status.toLowerCase(), before: { status: o.status }, after: { status, acceptedVia }, userId });
  });
}

/** Abgelaufene Angebote markieren und Reservierungen freigeben (wird beim Laden der Listen aufgerufen). */
export async function expireOffers() {
  const today = todayIso();
  await db.transaction(async (tx) => {
    const old = await tx.select({ id: schema.offers.id }).from(schema.offers)
      .where(and(inArray(schema.offers.status, ["DRAFT", "SENT"]), lt(schema.offers.validUntil, today)));
    if (!old.length) return;
    const ids = old.map((o) => o.id);
    await tx.update(schema.offers).set({ status: "EXPIRED" }).where(inArray(schema.offers.id, ids));
    const r = await tx.update(schema.reservations).set({ active: false }).where(inArray(schema.reservations.offerId, ids)).returning({ v: schema.reservations.variantId });
    await markDirty(tx, r.map((x) => x.v));
  });
}

/** Angebot → Rechnungsentwurf. Reservierung bleibt bis zur Ausstellung bestehen. */
export async function offerToInvoice(offerId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const o = await tx.query.offers.findFirst({ where: eq(schema.offers.id, offerId), with: { lines: true } });
    if (!o) throw new SalesError("notFound");
    if (o.status === "CONVERTED") {
      const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.offerId, offerId) });
      if (inv) return inv.id;
    }
    if (["REJECTED", "EXPIRED"].includes(o.status)) throw new SalesError("locked");
    const id = await createDraft(tx, {
      customerId: o.customerId, offerId: o.id, channel: "STORE", discountBp: o.discountBp, notes: o.notes,
      lines: o.lines.sort((a, b) => a.position - b.position).map((l) => ({
        variantId: l.variantId, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp,
      })),
    });
    await tx.update(schema.offers).set({ status: "CONVERTED" }).where(eq(schema.offers.id, offerId));
    await audit(tx, { entity: "offer", entityId: offerId, action: "convert", after: { invoiceId: id }, userId });
    return id;
  });
}

// ───────────────────────── Rechnungen ─────────────────────────

export type InvoiceDraftInput = {
  id?: string; customerId: string; offerId?: string | null; replacesInvoiceId?: string | null; channel: Channel;
  deliveryDate?: string | null; discountBp: number; notes: string; lines: LineInput[];
  retentionOfTitle?: boolean;
  /** Zahlung bei Ausstellung (z. B. bar im Laden oder Anzahlung) */
  initialPaymentCents?: number; initialPaymentMethod?: (typeof schema.paymentMethod.enumValues)[number] | null;
  /** Ratenplan; undefined = unverändert lassen, [] = keinen Plan */
  installments?: { dueDate: string; amountCents: number }[];
  /** Shop-Bestellungen: Bruttopreise, Steuer wie vom Shop kassiert, Bestellnummer im Shop */
  pricesGross?: boolean;
  taxOverride?: { mode: TaxMode; ossCountry: string | null };
  externalOrderId?: string | null;
};

async function createDraft(tx: Tx, input: InvoiceDraftInput) {
  validateLines(input.lines);
  const customer = await tx.query.customers.findFirst({ where: eq(schema.customers.id, input.customerId) });
  if (!customer) throw new SalesError("noCustomer");
  const gross = input.pricesGross ?? false;
  const t = input.taxOverride
    ? { mode: input.taxOverride.mode, ossCountry: input.taxOverride.ossCountry, lines: input.lines, totals: computeTotals(input.lines, input.discountBp, { gross }) }
    : await applyTax(tx, customer, input.lines, await productRatesFor(tx, input.lines.flatMap((l) => (l.variantId ? [l.variantId] : []))), input.discountBp, new Date().getFullYear(), gross);
  const values = {
    customerId: input.customerId, offerId: input.offerId ?? null, replacesInvoiceId: input.replacesInvoiceId ?? null,
    channel: input.channel, deliveryDate: input.deliveryDate || null, discountBp: input.discountBp,
    notes: input.notes, taxMode: t.mode, ossCountry: t.ossCountry,
    subtotalCents: t.totals.subtotalCents, discountCents: t.totals.discountCents, netCents: t.totals.netCents,
    vatCents: t.totals.vatCents, grossCents: t.totals.grossCents, vatBreakdown: t.totals.vatByRate,
    retentionOfTitle: input.retentionOfTitle ?? true,
    initialPaymentCents: input.initialPaymentCents ?? 0,
    initialPaymentMethod: input.initialPaymentCents ? input.initialPaymentMethod ?? "CASH" : null,
    pricesGross: gross, taxLocked: Boolean(input.taxOverride), externalOrderId: input.externalOrderId ?? null,
  };
  if (values.initialPaymentCents < 0 || values.initialPaymentCents > values.grossCents) throw new SalesError("initialPayment");
  let id = input.id;
  if (id) {
    const ex = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, id) });
    if (!ex) throw new SalesError("notFound");
    if (ex.status !== "DRAFT") throw new SalesError("locked");
    await tx.update(schema.invoices).set(values).where(eq(schema.invoices.id, id));
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, id));
  } else {
    const [r] = await tx.insert(schema.invoices).values(values).returning({ id: schema.invoices.id });
    id = r.id;
  }
  await tx.insert(schema.invoiceLines).values(t.totals.lines.map((l, i) => ({
    invoiceId: id!, position: i + 1, variantId: t.lines[i].variantId, description: t.lines[i].description,
    qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp, netCents: l.netCents, vatCents: l.vatCents,
    externalLineId: t.lines[i].externalLineId ?? null,
  })));
  if (input.installments) {
    await tx.delete(schema.installments).where(eq(schema.installments.invoiceId, id!));
    if (input.installments.length) await tx.insert(schema.installments).values(input.installments.map((r) => ({ invoiceId: id!, ...r })));
  }
  return id!;
}

export async function saveInvoiceDraft(input: InvoiceDraftInput, userId?: string) {
  return db.transaction(async (tx) => {
    const id = await createDraft(tx, input);
    await audit(tx, { entity: "invoice", entityId: id, action: input.id ? "update_draft" : "create_draft", after: input, userId });
    return id;
  });
}

export async function deleteDraft(id: string, userId?: string) {
  await db.transaction(async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, id) });
    if (!inv || inv.status !== "DRAFT") throw new SalesError("locked");
    await tx.delete(schema.invoices).where(eq(schema.invoices.id, id));
    if (inv.offerId) await tx.update(schema.offers).set({ status: "ACCEPTED" }).where(eq(schema.offers.id, inv.offerId));
    await audit(tx, { entity: "invoice", entityId: id, action: "delete_draft", before: inv, userId });
  });
}

/**
 * Rechnung ausstellen: Nummer vergeben, Kundendaten einfrieren, Steuer neu bestimmen, Ware ausbuchen.
 * Ersetzt sie eine alte Rechnung, wird diese im selben Schritt storniert.
 */
export async function issueInvoice(id: string, userId?: string, opts: { allowNegativeStock?: boolean } = {}) {
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`select id from invoices where id = ${id} for update`);
    if (!locked.rows.length) throw new SalesError("notFound");
    const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, id), with: { lines: true, customer: true } });
    if (!inv) throw new SalesError("notFound");
    if (inv.status !== "DRAFT") throw new SalesError("locked");
    const company = await tx.query.companySettings.findFirst();
    const today = todayIso();
    const year = Number(today.slice(0, 4));

    // Alte Rechnung zuerst stornieren (Ware kommt zurück), damit die neue sie wieder ausbuchen kann
    let cancellationId: string | null = null;
    if (inv.replacesInvoiceId) cancellationId = await cancelInTx(tx, inv.replacesInvoiceId, userId, id);

    // Steuer mit dem aktuellen Kundenstatus neu rechnen (z. B. USt-IdNr. inzwischen gültig)
    const lines = inv.lines.sort((a, b) => a.position - b.position);
    const lineIn = lines.map((l) => ({
      variantId: l.variantId, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp,
      externalLineId: l.externalLineId,
    }));
    const t = inv.taxLocked
      ? { mode: inv.taxMode, ossCountry: inv.ossCountry, lines: lineIn, totals: computeTotals(lineIn, inv.discountBp, { gross: inv.pricesGross }) }
      : await applyTax(tx, inv.customer, lineIn, await productRatesFor(tx, lines.flatMap((l) => (l.variantId ? [l.variantId] : []))), inv.discountBp, year, inv.pricesGross);
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, id));
    await tx.insert(schema.invoiceLines).values(t.totals.lines.map((l, i) => ({
      invoiceId: id, position: i + 1, variantId: t.lines[i].variantId, description: t.lines[i].description,
      qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp, netCents: l.netCents, vatCents: l.vatCents,
      externalLineId: t.lines[i].externalLineId ?? null,
    })));

    const number = await nextNumber(tx, "INVOICE", year);
    const payDays = inv.customer.paymentTermDays ?? company?.defaultPaymentDays ?? 14;
    const c = inv.customer;
    await tx.update(schema.invoices).set({
      number, status: "ISSUED", issueDate: today, deliveryDate: inv.deliveryDate ?? today, dueDate: addDaysIso(today, payDays),
      taxMode: t.mode, ossCountry: t.ossCountry, custName: c.name, custStreet: c.street, custZip: c.zip, custCity: c.city,
      custCountry: c.country, custVatId: c.vatId,
      subtotalCents: t.totals.subtotalCents, discountCents: t.totals.discountCents, netCents: t.totals.netCents,
      vatCents: t.totals.vatCents, grossCents: t.totals.grossCents, vatBreakdown: t.totals.vatByRate,
    }).where(eq(schema.invoices.id, id));

    // Ware ausbuchen (FEFO); Reservierungen des Angebots erledigen
    for (const l of lines) {
      if (!l.variantId) continue;
      try {
        await removeStock(tx, {
          variantId: l.variantId, qty: l.qty, type: "SALE", refType: "invoice", refId: id, channel: inv.channel, userId,
          note: number, allowNegative: opts.allowNegativeStock,
        });
      } catch (e) {
        if (e instanceof StockError && e.code === "NOT_ENOUGH") throw new SalesError("notEnough", l.description);
        throw e;
      }
    }
    if (inv.offerId) await tx.update(schema.reservations).set({ active: false }).where(eq(schema.reservations.offerId, inv.offerId));

    // Zahlungen: von der ersetzten Rechnung übernehmen, Ratenplan an Betrag anpassen, Zahlung bei Ausstellung buchen
    if (inv.replacesInvoiceId) await movePayments(tx, inv.replacesInvoiceId, id, userId);
    await fitPlanToGross(tx, id, t.totals.grossCents);
    const plan = await tx.select().from(schema.installments).where(eq(schema.installments.invoiceId, id));
    if (plan.length) {
      const last = plan.map((r) => r.dueDate).sort().at(-1)!;
      await tx.update(schema.invoices).set({ dueDate: last }).where(eq(schema.invoices.id, id));
    }
    if (inv.initialPaymentCents > 0) {
      await recordPaymentTx(tx, {
        invoiceId: id, date: today, amountCents: Math.min(inv.initialPaymentCents, t.totals.grossCents),
        method: inv.initialPaymentMethod ?? "CASH", note: "bei Ausstellung", userId, allowOverpay: true,
      });
    }
    await audit(tx, { entity: "invoice", entityId: id, action: "issue", after: { number, cancellationId }, userId });
    return { number, cancellationId };
  });
}

/** Storno: Gegenbeleg mit negativen Beträgen, Ware zurück ins Lager zum ursprünglichen EK. */
async function cancelInTx(tx: Tx, invoiceId: string, userId?: string, replacedById?: string) {
  await tx.execute(sql`select id from invoices where id = ${invoiceId} for update`);
  const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { lines: true } });
  if (!inv) throw new SalesError("notFound");
  if (inv.status !== "ISSUED" || inv.kind !== "INVOICE") throw new SalesError("locked");
  const today = todayIso();
  const number = await nextNumber(tx, "CANCELLATION", Number(today.slice(0, 4)));
  const neg = (n: number) => -n;
  const [st] = await tx.insert(schema.invoices).values({
    number, kind: "CANCELLATION", status: "ISSUED", cancelsInvoiceId: inv.id, customerId: inv.customerId, channel: inv.channel,
    issueDate: today, deliveryDate: inv.deliveryDate, taxMode: inv.taxMode, ossCountry: inv.ossCountry,
    custName: inv.custName, custStreet: inv.custStreet, custZip: inv.custZip, custCity: inv.custCity, custCountry: inv.custCountry, custVatId: inv.custVatId,
    discountBp: inv.discountBp, subtotalCents: neg(inv.subtotalCents), discountCents: neg(inv.discountCents), netCents: neg(inv.netCents),
    vatCents: neg(inv.vatCents), grossCents: neg(inv.grossCents),
    vatBreakdown: inv.vatBreakdown.map((g) => ({ rateBp: g.rateBp, netCents: -g.netCents, vatCents: -g.vatCents })),
    retentionOfTitle: false, notes: `Stornorechnung zu Rechnung ${inv.number} vom ${formatDate(inv.issueDate)}.`,
  }).returning({ id: schema.invoices.id });
  await tx.insert(schema.invoiceLines).values(inv.lines.map((l) => ({
    invoiceId: st.id, position: l.position, variantId: l.variantId, description: l.description, qty: -l.qty,
    unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp, netCents: -l.netCents, vatCents: -l.vatCents,
  })));
  // Ware zurück: je Verkaufsbewegung mit deren EK
  const sold = await tx.select().from(schema.stockMovements)
    .where(and(eq(schema.stockMovements.refType, "invoice"), eq(schema.stockMovements.refId, inv.id), eq(schema.stockMovements.type, "SALE")));
  for (const m of sold) {
    await addStock(tx, { variantId: m.variantId, qty: -m.qty, unitCostCents: m.unitCostCents, type: "CANCEL", refType: "invoice", refId: st.id, note: number, userId });
  }
  await tx.update(schema.invoices).set({ status: "CANCELLED" }).where(eq(schema.invoices.id, inv.id));
  await audit(tx, { entity: "invoice", entityId: inv.id, action: "cancel", after: { cancellationId: st.id, replacedById }, userId });
  return st.id;
}

export async function cancelInvoice(invoiceId: string, userId?: string) {
  return db.transaction((tx) => cancelInTx(tx, invoiceId, userId));
}

/**
 * „Bearbeiten“ einer ausgestellten Rechnung: legt einen Entwurf als Kopie an, der die alte ersetzt.
 * Erst beim Ausstellen des Entwurfs wird die alte storniert – bis dahin bleibt alles unverändert.
 */
export async function startCorrection(invoiceId: string, userId?: string) {
  return db.transaction(async (tx) => {
    const inv = await tx.query.invoices.findFirst({ where: eq(schema.invoices.id, invoiceId), with: { lines: true, installments: true } });
    if (!inv) throw new SalesError("notFound");
    if (inv.status !== "ISSUED" || inv.kind !== "INVOICE") throw new SalesError("locked");
    const open = await tx.query.invoices.findFirst({ where: and(eq(schema.invoices.replacesInvoiceId, invoiceId), eq(schema.invoices.status, "DRAFT")) });
    if (open) return open.id;
    const id = await createDraft(tx, {
      customerId: inv.customerId, replacesInvoiceId: inv.id, channel: inv.channel, deliveryDate: inv.deliveryDate,
      discountBp: inv.discountBp, notes: inv.notes, retentionOfTitle: inv.retentionOfTitle,
      installments: inv.installments.map((r) => ({ dueDate: r.dueDate, amountCents: r.amountCents })),
      pricesGross: inv.pricesGross, externalOrderId: inv.externalOrderId,
      taxOverride: inv.taxLocked ? { mode: inv.taxMode, ossCountry: inv.ossCountry } : undefined,
      lines: inv.lines.sort((a, b) => a.position - b.position).map((l) => ({
        variantId: l.variantId, description: l.description, qty: l.qty, unitPriceCents: l.unitPriceCents, discountBp: l.discountBp, vatRateBp: l.vatRateBp,
        externalLineId: l.externalLineId,
      })),
    });
    await audit(tx, { entity: "invoice", entityId: invoiceId, action: "start_correction", after: { draftId: id }, userId });
    return id;
  });
}
