// Star Style – Datenmodell
// Geldbeträge immer in Cent (integer). Prozentsätze in Basispunkten (1900 = 19,00 %).
import { relations } from "drizzle-orm";
import {
  pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, customType,
  uniqueIndex, index, serial, date,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// ───────────────────────── Enums ─────────────────────────
export const docKind = pgEnum("doc_kind", ["OFFER", "INVOICE", "CANCELLATION", "RECEIPT", "WRITE_OFF", "PAYMENT"]);
export const customerType = pgEnum("customer_type", ["COMPANY", "PERSON"]);
export const priceGroup = pgEnum("price_group", ["WHOLESALE", "RETAIL"]);
export const vatIdStatus = pgEnum("vat_id_status", ["NONE", "PENDING", "VALID", "INVALID"]);
export const movementType = pgEnum("movement_type", ["RECEIPT", "SALE", "RETURN", "WRITE_OFF", "ADJUSTMENT", "CANCEL"]);
export const channel = pgEnum("channel", ["BRAND_SHOP", "GENERAL_SHOP", "STORE"]);
export const writeOffReason = pgEnum("write_off_reason", ["BREAKAGE", "DAMAGE", "EXPIRED", "LOSS", "OTHER"]);
export const offerStatus = pgEnum("offer_status", ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CONVERTED"]);
export const invoiceStatus = pgEnum("invoice_status", ["DRAFT", "ISSUED", "CANCELLED"]);
export const invoiceKind = pgEnum("invoice_kind", ["INVOICE", "CANCELLATION"]);
export const taxMode = pgEnum("tax_mode", ["DOMESTIC", "EU_REVERSE_CHARGE", "EU_PENDING_VATID", "EU_B2C", "EXPORT"]);
export const paymentMethod = pgEnum("payment_method", ["CASH", "BANK", "CARD", "ONLINE"]);
export const expenseCategory = pgEnum("expense_category", [
  "GOODS", "MARKETING", "ADVERTISING", "STORE_SUPPLIES", "SHIPPING", "RENT", "SHOP_FEES", "SOFTWARE", "OTHER",
]);

// ───────────────────────── Benutzer & Einstellungen ─────────────────────────
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  locale: text("locale").notNull().default("de"),
  totpSecret: text("totp_secret"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Firmendaten – genau eine Zeile (id = "company") */
export const companySettings = pgTable("company_settings", {
  id: text("id").primaryKey().default("company"),
  name: text("name").notNull().default(""),
  owner: text("owner").notNull().default(""),
  street: text("street").notNull().default(""),
  zip: text("zip").notNull().default(""),
  city: text("city").notNull().default(""),
  country: text("country").notNull().default("DE"),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  website: text("website").notNull().default(""),
  vatId: text("vat_id").notNull().default(""),
  taxNumber: text("tax_number").notNull().default(""),
  bankName: text("bank_name").notNull().default(""),
  iban: text("iban").notNull().default(""),
  bic: text("bic").notNull().default(""),
  logoFileId: text("logo_file_id"),
  defaultPaymentDays: integer("default_payment_days").notNull().default(14),
  offerValidityDays: integer("offer_validity_days").notNull().default(14),
  invoiceFooter: text("invoice_footer").notNull().default(""),
  updatedAt: updatedAt(),
});

/** Lückenlose Nummernkreise pro Belegart und Jahr */
export const numberSequences = pgTable("number_sequences", {
  id: id(),
  kind: docKind("kind").notNull(),
  year: integer("year").notNull(),
  next: integer("next").notNull().default(1),
}, (t) => [uniqueIndex("number_seq_kind_year").on(t.kind, t.year)]);

export const storedFiles = pgTable("stored_files", {
  id: id(),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  data: bytea("data").notNull(),
  createdAt: createdAt(),
});

export const auditLog = pgTable("audit_log", {
  id: id(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  userId: text("user_id"),
  createdAt: createdAt(),
}, (t) => [index("audit_entity").on(t.entity, t.entityId)]);

// ───────────────────────── Stammdaten ─────────────────────────
export const suppliers = pgTable("suppliers", {
  id: id(),
  name: text("name").notNull(),
  contact: text("contact").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  street: text("street").notNull().default(""),
  zip: text("zip").notNull().default(""),
  city: text("city").notNull().default(""),
  country: text("country").notNull().default("DE"),
  vatId: text("vat_id").notNull().default(""),
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const customers = pgTable("customers", {
  id: id(),
  number: serial("number").notNull().unique(),
  type: customerType("type").notNull().default("COMPANY"),
  name: text("name").notNull(),
  contact: text("contact").notNull().default(""),
  email: text("email").notNull().default(""),
  phone: text("phone").notNull().default(""),
  street: text("street").notNull().default(""),
  zip: text("zip").notNull().default(""),
  city: text("city").notNull().default(""),
  country: text("country").notNull().default("DE"),
  vatId: text("vat_id").notNull().default(""),
  vatIdStatus: vatIdStatus("vat_id_status").notNull().default("NONE"),
  vatCheckedAt: timestamp("vat_checked_at", { withTimezone: true }),
  priceGroup: priceGroup("price_group").notNull().default("WHOLESALE"),
  creditLimitCents: integer("credit_limit_cents"),
  paymentTermDays: integer("payment_term_days"),
  notes: text("notes").notNull().default(""),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const vatChecks = pgTable("vat_checks", {
  id: id(),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  vatId: text("vat_id").notNull(),
  source: text("source").notNull(), // VIES | BZST
  valid: boolean("valid"),
  name: text("name").notNull().default(""),
  address: text("address").notNull().default(""),
  raw: jsonb("raw"),
  error: text("error").notNull().default(""),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

// ───────────────────────── Artikel & Lager ─────────────────────────
export const products = pgTable("products", {
  id: id(),
  sku: text("sku").notNull().unique(),
  nameDe: text("name_de").notNull(),
  nameNl: text("name_nl").notNull().default(""),
  descriptionDe: text("description_de").notNull().default(""),
  descriptionNl: text("description_nl").notNull().default(""),
  category: text("category").notNull().default(""),
  supplierId: text("supplier_id").references(() => suppliers.id),
  vatRateBp: integer("vat_rate_bp").notNull().default(1900),
  purchasePriceCents: integer("purchase_price_cents").notNull().default(0),
  wholesalePriceCents: integer("wholesale_price_cents").notNull().default(0),
  retailPriceCents: integer("retail_price_cents").notNull().default(0),
  imageFileId: text("image_file_id"),
  tracksExpiry: boolean("tracks_expiry").notNull().default(false),
  inBrandShop: boolean("in_brand_shop").notNull().default(false),
  inGeneralShop: boolean("in_general_shop").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const variants = pgTable("variants", {
  id: id(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  size: text("size").notNull().default(""),
  color: text("color").notNull().default(""),
  barcode: text("barcode").unique(),
  wholesalePriceCents: integer("wholesale_price_cents"),
  retailPriceCents: integer("retail_price_cents"),
  minStock: integer("min_stock").notNull().default(0),
  stockQty: integer("stock_qty").notNull().default(0), // Cache; Wahrheit = Summe der Bewegungen
  avgCostCents: integer("avg_cost_cents").notNull().default(0), // gleitender Durchschnitts-EK
  shopRefBrand: text("shop_ref_brand"),
  shopRefGeneral: text("shop_ref_general"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("variant_product_size_color").on(t.productId, t.size, t.color)]);

export const batches = pgTable("batches", {
  id: id(),
  variantId: text("variant_id").notNull().references(() => variants.id, { onDelete: "cascade" }),
  batchNo: text("batch_no").notNull().default(""),
  expiryDate: date("expiry_date", { mode: "string" }),
  unitCostCents: integer("unit_cost_cents").notNull(),
  qtyReceived: integer("qty_received").notNull(),
  qtyLeft: integer("qty_left").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("batch_variant_expiry").on(t.variantId, t.expiryDate)]);

export const stockMovements = pgTable("stock_movements", {
  id: id(),
  variantId: text("variant_id").notNull().references(() => variants.id),
  batchId: text("batch_id").references(() => batches.id),
  type: movementType("type").notNull(),
  qty: integer("qty").notNull(), // + Zugang, − Abgang
  unitCostCents: integer("unit_cost_cents").notNull().default(0),
  channel: channel("channel"),
  refType: text("ref_type"), // receipt | invoice | writeoff | adjustment
  refId: text("ref_id"),
  note: text("note").notNull().default(""),
  userId: text("user_id"),
  createdAt: createdAt(),
}, (t) => [index("movement_variant_time").on(t.variantId, t.createdAt), index("movement_ref").on(t.refType, t.refId)]);

export const goodsReceipts = pgTable("goods_receipts", {
  id: id(),
  number: text("number").notNull().unique(),
  supplierId: text("supplier_id").references(() => suppliers.id),
  date: date("date", { mode: "string" }).notNull(),
  supplierInvoiceNo: text("supplier_invoice_no").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
});

export const receiptLines = pgTable("receipt_lines", {
  id: id(),
  receiptId: text("receipt_id").notNull().references(() => goodsReceipts.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => variants.id),
  batchId: text("batch_id").references(() => batches.id),
  qty: integer("qty").notNull(),
  unitCostCents: integer("unit_cost_cents").notNull(),
  batchNo: text("batch_no").notNull().default(""),
  expiryDate: date("expiry_date", { mode: "string" }),
});

export const writeOffs = pgTable("write_offs", {
  id: id(),
  number: text("number").notNull().unique(),
  date: date("date", { mode: "string" }).notNull(),
  reason: writeOffReason("reason").notNull(),
  note: text("note").notNull().default(""),
  photoFileId: text("photo_file_id"),
  createdAt: createdAt(),
});

export const writeOffLines = pgTable("write_off_lines", {
  id: id(),
  writeOffId: text("write_off_id").notNull().references(() => writeOffs.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => variants.id),
  batchId: text("batch_id").references(() => batches.id),
  qty: integer("qty").notNull(),
  unitCostCents: integer("unit_cost_cents").notNull(),
});

// ───────────────────────── Verkauf ─────────────────────────
export const offers = pgTable("offers", {
  id: id(),
  number: text("number").notNull().unique(),
  status: offerStatus("status").notNull().default("DRAFT"),
  customerId: text("customer_id").notNull().references(() => customers.id),
  date: date("date", { mode: "string" }).notNull(),
  validUntil: date("valid_until", { mode: "string" }).notNull(),
  discountBp: integer("discount_bp").notNull().default(0),
  acceptedVia: text("accepted_via").notNull().default(""),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  notes: text("notes").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const offerLines = pgTable("offer_lines", {
  id: id(),
  offerId: text("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  variantId: text("variant_id").references(() => variants.id),
  description: text("description").notNull(),
  qty: integer("qty").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  discountBp: integer("discount_bp").notNull().default(0),
  vatRateBp: integer("vat_rate_bp").notNull().default(1900),
});

export const reservations = pgTable("reservations", {
  id: id(),
  variantId: text("variant_id").notNull().references(() => variants.id, { onDelete: "cascade" }),
  offerId: text("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
  qty: integer("qty").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [index("reservation_variant_active").on(t.variantId, t.active)]);

export const invoices = pgTable("invoices", {
  id: id(),
  number: text("number").unique(), // erst bei Ausstellung vergeben
  kind: invoiceKind("kind").notNull().default("INVOICE"),
  status: invoiceStatus("status").notNull().default("DRAFT"),
  cancelsInvoiceId: text("cancels_invoice_id").unique(),
  replacesInvoiceId: text("replaces_invoice_id"),
  offerId: text("offer_id").references(() => offers.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  channel: channel("channel").notNull().default("STORE"),
  externalOrderId: text("external_order_id"),
  issueDate: date("issue_date", { mode: "string" }),
  deliveryDate: date("delivery_date", { mode: "string" }),
  dueDate: date("due_date", { mode: "string" }),
  taxMode: taxMode("tax_mode").notNull().default("DOMESTIC"),
  ossCountry: text("oss_country"),
  custName: text("cust_name").notNull().default(""),
  custStreet: text("cust_street").notNull().default(""),
  custZip: text("cust_zip").notNull().default(""),
  custCity: text("cust_city").notNull().default(""),
  custCountry: text("cust_country").notNull().default("DE"),
  custVatId: text("cust_vat_id").notNull().default(""),
  discountBp: integer("discount_bp").notNull().default(0),
  skontoBp: integer("skonto_bp").notNull().default(0),
  skontoDays: integer("skonto_days").notNull().default(0),
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  discountCents: integer("discount_cents").notNull().default(0),
  netCents: integer("net_cents").notNull().default(0),
  vatCents: integer("vat_cents").notNull().default(0),
  grossCents: integer("gross_cents").notNull().default(0),
  vatBreakdown: jsonb("vat_breakdown").$type<{ rateBp: number; netCents: number; vatCents: number }[]>().notNull().default([]),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  retentionOfTitle: boolean("retention_of_title").notNull().default(true),
  initialPaymentCents: integer("initial_payment_cents").notNull().default(0),
  initialPaymentMethod: paymentMethod("initial_payment_method"),
  notes: text("notes").notNull().default(""),
  exportProofFileId: text("export_proof_file_id"),
  pdfFileId: text("pdf_file_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("invoice_status_date").on(t.status, t.issueDate), index("invoice_customer").on(t.customerId)]);

export const invoiceLines = pgTable("invoice_lines", {
  id: id(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  variantId: text("variant_id").references(() => variants.id),
  description: text("description").notNull(),
  qty: integer("qty").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  discountBp: integer("discount_bp").notNull().default(0),
  vatRateBp: integer("vat_rate_bp").notNull().default(1900),
  netCents: integer("net_cents").notNull().default(0),
  vatCents: integer("vat_cents").notNull().default(0),
});

export const installments = pgTable("installments", {
  id: id(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  amountCents: integer("amount_cents").notNull(),
});

export const payments = pgTable("payments", {
  id: id(),
  number: text("number").notNull().unique(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  date: date("date", { mode: "string" }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  method: paymentMethod("method").notNull(),
  note: text("note").notNull().default(""),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason").notNull().default(""),
  movedFromInvoiceId: text("moved_from_invoice_id"),
  createdAt: createdAt(),
});

/** Zahlungserinnerungen und Mahnungen */
export const dunnings = pgTable("dunnings", {
  id: id(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  level: integer("level").notNull(), // 1 = Zahlungserinnerung, 2 = 1. Mahnung, 3 = 2. Mahnung
  date: date("date", { mode: "string" }).notNull(),
  openCents: integer("open_cents").notNull(),
  feeCents: integer("fee_cents").notNull().default(0),
  newDueDate: date("new_due_date", { mode: "string" }).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ───────────────────────── Ausgaben ─────────────────────────
export const expenses = pgTable("expenses", {
  id: id(),
  date: date("date", { mode: "string" }).notNull(),
  supplierId: text("supplier_id").references(() => suppliers.id),
  vendorName: text("vendor_name").notNull().default(""),
  vendorCountry: text("vendor_country").notNull().default("DE"),
  invoiceNo: text("invoice_no").notNull().default(""),
  category: expenseCategory("category").notNull(),
  netCents: integer("net_cents").notNull(),
  vatCents: integer("vat_cents").notNull().default(0),
  grossCents: integer("gross_cents").notNull(),
  vatRateBp: integer("vat_rate_bp").notNull().default(1900),
  reverseCharge: boolean("reverse_charge").notNull().default(false),
  paid: boolean("paid").notNull().default(true),
  paidAt: date("paid_at", { mode: "string" }),
  fileId: text("file_id"),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("expense_date").on(t.date)]);

// ───────────────────────── Relationen ─────────────────────────
export const productsRelations = relations(products, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [products.supplierId], references: [suppliers.id] }),
  variants: many(variants),
}));
export const variantsRelations = relations(variants, ({ one, many }) => ({
  product: one(products, { fields: [variants.productId], references: [products.id] }),
  batches: many(batches),
  movements: many(stockMovements),
}));
export const batchesRelations = relations(batches, ({ one }) => ({
  variant: one(variants, { fields: [batches.variantId], references: [variants.id] }),
}));
export const movementsRelations = relations(stockMovements, ({ one }) => ({
  variant: one(variants, { fields: [stockMovements.variantId], references: [variants.id] }),
  batch: one(batches, { fields: [stockMovements.batchId], references: [batches.id] }),
}));
export const receiptsRelations = relations(goodsReceipts, ({ one, many }) => ({
  supplier: one(suppliers, { fields: [goodsReceipts.supplierId], references: [suppliers.id] }),
  lines: many(receiptLines),
}));
export const receiptLinesRelations = relations(receiptLines, ({ one }) => ({
  receipt: one(goodsReceipts, { fields: [receiptLines.receiptId], references: [goodsReceipts.id] }),
  variant: one(variants, { fields: [receiptLines.variantId], references: [variants.id] }),
}));
export const writeOffsRelations = relations(writeOffs, ({ many }) => ({ lines: many(writeOffLines) }));
export const writeOffLinesRelations = relations(writeOffLines, ({ one }) => ({
  writeOff: one(writeOffs, { fields: [writeOffLines.writeOffId], references: [writeOffs.id] }),
  variant: one(variants, { fields: [writeOffLines.variantId], references: [variants.id] }),
}));
export const suppliersRelations = relations(suppliers, ({ many }) => ({ products: many(products) }));

export const customersRelations = relations(customers, ({ many }) => ({ offers: many(offers), invoices: many(invoices), vatChecks: many(vatChecks) }));
export const vatChecksRelations = relations(vatChecks, ({ one }) => ({ customer: one(customers, { fields: [vatChecks.customerId], references: [customers.id] }) }));
export const offersRelations = relations(offers, ({ one, many }) => ({
  customer: one(customers, { fields: [offers.customerId], references: [customers.id] }),
  lines: many(offerLines),
  reservations: many(reservations),
}));
export const offerLinesRelations = relations(offerLines, ({ one }) => ({
  offer: one(offers, { fields: [offerLines.offerId], references: [offers.id] }),
  variant: one(variants, { fields: [offerLines.variantId], references: [variants.id] }),
}));
export const reservationsRelations = relations(reservations, ({ one }) => ({
  offer: one(offers, { fields: [reservations.offerId], references: [offers.id] }),
  variant: one(variants, { fields: [reservations.variantId], references: [variants.id] }),
}));
export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  offer: one(offers, { fields: [invoices.offerId], references: [offers.id] }),
  lines: many(invoiceLines),
  payments: many(payments),
  installments: many(installments),
  dunnings: many(dunnings),
}));
export const dunningsRelations = relations(dunnings, ({ one }) => ({ invoice: one(invoices, { fields: [dunnings.invoiceId], references: [invoices.id] }) }));
export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  variant: one(variants, { fields: [invoiceLines.variantId], references: [variants.id] }),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({ invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }) }));
export const installmentsRelations = relations(installments, ({ one }) => ({ invoice: one(invoices, { fields: [installments.invoiceId], references: [invoices.id] }) }));
