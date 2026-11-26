// Star Style – Datenmodell
// Geldbeträge immer in Cent (integer). Prozentsätze in Basispunkten (1900 = 19,00 %).
import { relations, sql } from "drizzle-orm";
import {
  pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, customType,
  uniqueIndex, index, serial, bigserial, date,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// ───────────────────────── Enums ─────────────────────────
export const docKind = pgEnum("doc_kind", ["OFFER", "INVOICE", "CANCELLATION", "RECEIPT", "WRITE_OFF", "PAYMENT", "RETURN"]);
/** Retoure je Position: zurück ins Lager (verkaufbar) oder beschädigt (→ Verlust) */
export const returnCondition = pgEnum("return_condition", ["RESTOCK", "DAMAGED"]);
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
  "PACKAGING", "VEHICLE", "INSURANCE", "PHONE_INTERNET", "BANK_FEES", "CONSULTING",
]);
/** Steuerfall einer Eingangsrechnung */
export const expenseTaxCase = pgEnum("expense_tax_case", [
  "DOMESTIC",       // deutsche Rechnung mit Vorsteuer (19 / 7 / 0 %)
  "EU_SERVICE",     // Dienstleistung aus EU ohne MwSt. (§ 13b, z. B. Meta/Google Irland)
  "NON_EU_SERVICE", // Dienstleistung aus Drittland (§ 13b)
  "EU_GOODS",       // Ware aus EU ohne MwSt. (innergemeinschaftlicher Erwerb)
  "NO_VAT",         // ohne Umsatzsteuer (z. B. Versicherung, Gebühren)
]);
/**
 * Art des Lieferanten – nur für die Oberfläche (Wunsch Inhaber 12.11.2026): GOODS = liefert Ware (Seite „Lieferanten“,
 * Wareneingang, Artikel), EXPENSE = kommt nur über Ausgaben (z. B. Baumarkt, Steuerbüro; Seite „Ausgaben → Firmen“).
 * Buchhaltung unverändert: beide sind Kreditoren mit Nummer (DATEV 70000 + Nr.).
 */
export const supplierKind = pgEnum("supplier_kind", ["GOODS", "EXPENSE"]);

// ───────────────────────── Benutzer & Einstellungen ─────────────────────────
export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  locale: text("locale").notNull().default("de"),
  // Zwei-Schritt-Anmeldung: Schlüssel verschlüsselt (crypto.ts); eingeschaltet erst mit totp_enabled_at
  totpSecret: text("totp_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpLastStep: integer("totp_last_step"), // zuletzt benutztes 30-s-Fenster → derselbe Code geht nicht zweimal
  recoveryCodes: jsonb("recovery_codes").$type<string[]>().notNull().default([]), // nur HMAC der Ersatz-Codes
  // +1 = alle Sitzungen (und „Gerät vertrauen“) ungültig: Passwort geändert, „alle Geräte abmelden“, Zwei-Schritt eingeschaltet
  sessionVersion: integer("session_version").notNull().default(1),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  // Berechtigungen (Wunsch Inhaber 12.11.2026, src/lib/permissions.ts): Admin = alles + Mitarbeiter verwalten;
  // sonst nur die angehakten Rechte. active = false → Anmeldung gesperrt, Sitzungen sofort ungültig.
  isAdmin: boolean("is_admin").notNull().default(false),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  // Einmal-Passwort vom Admin → beim nächsten Anmelden erst ein eigenes Passwort setzen
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Jeder Anmeldeversuch (Sicherheit): Grundlage für die Sperre nach Fehlversuchen und für „Letzte Anmeldungen“.
 * device = ID aus dem Geräte-Cookie, wenn das Gerät für dieses Konto bekannt war, sonst leer.
 * reason: success | needCode | invalid | code | locked | expired (gezählt als Fehlversuch: invalid, code)
 */
export const loginAttempts = pgTable("login_attempts", {
  id: id(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  userId: text("user_id"),
  email: text("email").notNull().default(""),
  ip: text("ip").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  device: text("device").notNull().default(""),
  step: text("step").notNull(), // password | code | change
  ok: boolean("ok").notNull(),
  reason: text("reason").notNull(),
}, (t) => [index("login_attempts_at").on(t.at), index("login_attempts_user_at").on(t.userId, t.at), index("login_attempts_ip_at").on(t.ip, t.at)]);

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
  showGuide: boolean("show_guide").notNull().default(false), // „Erste Schritte“ auch nach Abschluss anzeigen (z. B. zum Einarbeiten)
  // Echtbetrieb seit (Wunsch Inhaber 04.11.2026): gesetzt von „System zurücksetzen“; ab dann gibt es kein Zurücksetzen mehr
  liveSince: timestamp("live_since", { withTimezone: true }),
  // Steuerberater / DATEV
  datevConsultant: integer("datev_consultant"),
  datevClient: integer("datev_client"),
  chartOfAccounts: text("chart_of_accounts").notNull().default("SKR03"),
  fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
  accountOverrides: jsonb("account_overrides").$type<Record<string, number>>().notNull().default({}),
  advisorEmail: text("advisor_email").notNull().default(""),
  // Belegdesign (Seite „Belegdesign“, src/lib/doc-design.ts): nur die Abweichungen vom Standard; {} = bisheriges Aussehen
  docDesign: jsonb("doc_design").$type<Record<string, unknown>>().notNull().default({}),
  // Versanddienste (Seite „Versanddienste“, src/lib/carriers.ts): Reihenfolge, ausgeblendet, vorgewählt, eigene; {} = wie bisher
  carriers: jsonb("carriers").$type<Record<string, unknown>>().notNull().default({}),
  // GLS-Anbindung (ShipIT, Seite „GLS“, src/lib/gls.ts): Adresse, Benutzer, Passwort (verschlüsselt), Contact-ID, Dienste; {} = nicht eingerichtet
  gls: jsonb("gls").$type<Record<string, unknown>>().notNull().default({}),
  // Postfach info@ im System (Seite „E-Mail“, src/lib/mail-rules.ts): IMAP/SMTP, Benutzer, App-Passwort (verschlüsselt), Absendername, Signatur
  mail: jsonb("mail").$type<Record<string, unknown>>().notNull().default({}),
  // WhatsApp Business (Cloud API, Seite „WhatsApp“, src/lib/whatsapp-rules.ts): Nummer-ID, WABA-ID, Token + App-Geheimnis (verschlüsselt), Prüfwort für den Webhook
  whatsapp: jsonb("whatsapp").$type<Record<string, unknown>>().notNull().default({}),
  // Bestell-Links „Direktverkauf“ (src/lib/direct.ts), je Preisgruppe RETAIL/WHOLESALE: Token verschlüsselt + sha256 zum Prüfen, an/aus; {} = noch keiner
  directLink: jsonb("direct_link").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

/** Abgeschlossene Monate: Belege mit Datum in diesem Monat können nicht mehr geändert werden. */
export const periodLocks = pgTable("period_locks", {
  month: text("month").primaryKey(), // YYYY-MM
  lockedAt: timestamp("locked_at", { withTimezone: true }).notNull().defaultNow(),
  userId: text("user_id"),
});

/** Jede erzeugte Monatsmappe für den Steuerberater wird archiviert. */
export const advisorExports = pgTable("advisor_exports", {
  id: id(),
  month: text("month").notNull(),
  fileId: text("file_id").notNull(),
  bookings: integer("bookings").notNull().default(0),
  createdAt: createdAt(),
  userId: text("user_id"),
}, (t) => [index("advisor_export_month").on(t.month)]);

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
  number: serial("number").notNull().unique(),
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
  kind: supplierKind("kind").notNull().default("GOODS"),
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
  // Herkunft (Wunsch Inhaber 13.11.2026: „تفصل بين الزباين يلي بكريتها من السيستم والزباين يلي جاية من المتجرين“):
  // null = im System angelegt; sonst der Shop, aus dem er kam (Konto oder Bestellung). Ändert sich nie, auch nicht beim Verbinden.
  fromShop: channel("from_shop"),
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
/** Kategorien (Wunsch Inhaber 04.11.2026: eigene Seite, im Shop als automatische Kollektion „Produkttyp ist gleich …“).
 *  Artikel verweisen per Name (products.category). shop_collections = Kollektionen, die WIR angelegt haben (nur die dürfen wir löschen). */
export const categories = pgTable("categories", {
  id: id(),
  name: text("name").notNull(),
  shopCollections: jsonb("shop_collections").$type<Partial<Record<"BRAND_SHOP" | "GENERAL_SHOP", string>>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("categories_name_lower").on(sql`lower(${t.name})`)]);

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
  // Versandart (Wunsch Inhaber 19.11.2026): null = automatisch aus Gewicht/Paketmaßen (src/lib/shipping-class.ts),
  // PARCEL = immer Paket (GLS), FREIGHT = immer Spedition (Möbel; im Shop Tag „spedition“ → nur Abholung bzw. Anfrage)
  shippingClass: text("shipping_class").$type<"PARCEL" | "FREIGHT">(),
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
  // eigene Preise dieser Größe/Farbe (netto); null = Preis des Artikels. Einkaufspreis seit 26.11.2026 (Wunsch Inhaber: z. B. Barber-Leuchte
  // 45 cm EK 45 / Großhandel 55 / Shop 150, 58 cm wie der Artikel) – nur Vorschlag für Wareneingang/Marge, Wareneinsatz kommt aus den Chargen
  purchasePriceCents: integer("purchase_price_cents"),
  wholesalePriceCents: integer("wholesale_price_cents"),
  retailPriceCents: integer("retail_price_cents"),
  minStock: integer("min_stock").notNull().default(0),
  weightGrams: integer("weight_grams"), // Gewicht einer Packung in Gramm (Versand nach Gewicht im Shop); null = unbekannt
  // Paketmaße (Karton) in mm – entscheiden mit dem Gewicht, ob die Ware als GLS-Paket geht (src/lib/shipping-class.ts); null = unbekannt
  pkgLengthMm: integer("pkg_length_mm"),
  pkgWidthMm: integer("pkg_width_mm"),
  pkgHeightMm: integer("pkg_height_mm"),
  imageFileId: text("image_file_id"), // eigenes Foto (z. B. Farbe); sonst Foto des Artikels
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
  // Artikel von Hand vom Bestell-Link (nicht im System, Wunsch Inhaber 20.11.2026): nur fürs Angebot – für eine Rechnung erst als
  // Artikel anlegen und im Angebot ersetzen (offerToInvoice sperrt sonst). Foto = das Foto vom Bestell-Link (auch im Angebots-PDF).
  manual: boolean("manual").notNull().default(false),
  photoFileId: text("photo_file_id").references(() => storedFiles.id, { onDelete: "set null" }),
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
  /** Preise der Positionen sind Bruttopreise (Shop-Bestellungen) */
  pricesGross: boolean("prices_gross").notNull().default(false),
  /** Steuer nicht neu berechnen (Shop hat Steuer bereits festgelegt und kassiert) */
  taxLocked: boolean("tax_locked").notNull().default(false),
  /** Shop-Bestellung zur Abholung im Lager (Shopify PICK_UP) – nicht „zu versenden“, sondern „zur Abholung“ */
  deliveryMethod: text("delivery_method").notNull().default(""),
  pickupReadyAt: timestamp("pickup_ready_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("invoice_status_date").on(t.status, t.issueDate), index("invoice_customer").on(t.customerId), index("invoice_external").on(t.channel, t.externalOrderId)]);

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
  externalLineId: text("external_line_id"), // Position im Shop (gid://shopify/LineItem/…) bzw. „shipping“
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

/**
 * Retouren (Wunsch Inhaber 16.11.2026: „تسجيل المرتجعات“): Kunde gibt Ware einer ausgestellten Rechnung zurück.
 * GoBD: die Rechnung bleibt unverändert – gebucht wird Storno (ST-) und bei einer Teilretoure eine neue Rechnung mit den
 * behaltenen Mengen (wie „Bearbeiten“). Ware zurück ins Lager mit Charge/MHD wie verkauft; beschädigt → Verlust (AB-).
 * Erstattung = Zahlung mit negativem Betrag auf der neuen (bzw. stornierten) Rechnung. Logik: src/lib/returns.ts.
 */
export const returns = pgTable("returns", {
  id: id(),
  number: text("number").notNull().unique(), // RT-2026-0001
  date: date("date", { mode: "string" }).notNull(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id), // zurückgegebene Rechnung (danach storniert)
  cancellationId: text("cancellation_id").references(() => invoices.id), // Storno ST-
  correctionId: text("correction_id").references(() => invoices.id), // neue Rechnung mit den behaltenen Mengen (Teilretoure)
  customerId: text("customer_id").notNull().references(() => customers.id),
  reason: text("reason").notNull().default("other"), // wrong | damaged | unwanted | quality | other
  note: text("note").notNull().default(""),
  creditCents: integer("credit_cents").notNull().default(0), // Gutschrift brutto: um so viel wird die Rechnung kleiner
  refundCents: integer("refund_cents").notNull().default(0), // davon ausgezahlt
  refundMethod: paymentMethod("refund_method"),
  refundPaymentId: text("refund_payment_id"),
  writeOffId: text("write_off_id"),
  createdBy: text("created_by"),
  createdAt: createdAt(),
}, (t) => [index("return_invoice").on(t.invoiceId), index("return_customer").on(t.customerId), index("return_date").on(t.date)]);

export const returnLines = pgTable("return_lines", {
  id: id(),
  returnId: text("return_id").notNull().references(() => returns.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  invoiceLineId: text("invoice_line_id").notNull(), // Position der zurückgegebenen Rechnung
  variantId: text("variant_id").references(() => variants.id),
  description: text("description").notNull(),
  qty: integer("qty").notNull(),
  condition: returnCondition("condition").notNull().default("RESTOCK"),
});

/**
 * Direktverkauf über den Bestell-Link (Wunsch Inhaber 19.11.2026: „الزبون … بيعطيه تاب فيه لينك … حطهم بالعربة وبعتهم …
 * اجوا على السيستم وليس على المتجر الالكتروني“): Katalog auf dem Tablet im Büro oder per Link an einen Händler; der Kunde
 * stellt eine Liste zusammen, schreibt Name + E-Mail (Pflicht) und schickt sie ab – ohne Bezahlen, ohne Shop. Hier landet
 * die Liste; der Mitarbeiter wählt den Kunden (oder legt ihn ganz normal an) und macht daraus ein Angebot oder einen
 * Rechnungsentwurf. Ein Link je Preisgruppe (جملة / جملة الجملة), price_group = Preise, die der Kunde gesehen hat.
 * NEW = wartet, CONVERTED = Angebot/Rechnungsentwurf erstellt (offer_id/invoice_id; gelöscht → null, dann wieder offen), REJECTED = abgelehnt.
 * Logik: src/lib/direct.ts (DB), src/lib/direct-rules.ts (rein).
 */
export const directOrders = pgTable("direct_orders", {
  id: id(),
  number: serial("number").notNull().unique(),
  status: text("status").$type<"NEW" | "CONVERTED" | "REJECTED">().notNull().default("NEW"),
  name: text("name").notNull(),
  email: text("email").notNull(), // klein geschrieben – Schlüssel zum Kunden (nie der Name)
  company: text("company").notNull().default(""),
  phone: text("phone").notNull().default(""),
  street: text("street").notNull().default(""),
  zip: text("zip").notNull().default(""),
  city: text("city").notNull().default(""),
  country: text("country").notNull().default("DE"),
  vatId: text("vat_id").notNull().default(""),
  note: text("note").notNull().default(""),
  lang: text("lang").notNull().default("de"),
  priceGroup: priceGroup("price_group").notNull().default("RETAIL"), // Link „جملة“ (RETAIL) oder „جملة الجملة“ (WHOLESALE)
  netCents: integer("net_cents").notNull().default(0), // Summe netto, wie dem Kunden gezeigt
  grossCents: integer("gross_cents").notNull().default(0),
  ipHash: text("ip_hash").notNull().default(""), // nur für die Begrenzung je Gerät/Netz (HMAC, keine IP gespeichert)
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  invoiceId: text("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
  offerId: text("offer_id").references(() => offers.id, { onDelete: "set null" }),
  rejectReason: text("reject_reason").notNull().default(""),
  handledBy: text("handled_by"),
  handledAt: timestamp("handled_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index("direct_status").on(t.status, t.createdAt), index("direct_email").on(t.email), index("direct_ip").on(t.ipHash, t.createdAt)]);

export const directOrderLines = pgTable("direct_order_lines", {
  id: id(),
  orderId: text("order_id").notNull().references(() => directOrders.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  variantId: text("variant_id").references(() => variants.id, { onDelete: "set null" }),
  description: text("description").notNull(), // wie auf der Rechnung (Name + Größe/Farbe), bleibt auch ohne Artikel
  barcode: text("barcode").notNull().default(""),
  qty: integer("qty").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(), // netto, wie dem Kunden gezeigt (Preis der Preisgruppe des Links)
  vatRateBp: integer("vat_rate_bp").notNull(),
  // Rabatt einer Aktion, mit dem die Zeile gezeigt wurde (Basispunkte; unit_price_cents ist der Preis VOR dem Rabatt)
  promoBp: integer("promo_bp").notNull().default(0),
  // Artikel von Hand (Wunsch Inhaber 20.11.2026: am Bestell-Link mit der Kamera fotografiert, Name/Menge/Preis/Größe/Farbe
  // eingetippt – nicht im System, nur fürs Angebot). null = Artikel aus dem Katalog. Preis 0 = „Preis auf Anfrage“.
  manual: jsonb("manual").$type<{ name: string; size: string; color: string } | null>(),
  photoFileId: text("photo_file_id").references(() => storedFiles.id, { onDelete: "set null" }),
}, (t) => [index("direct_line_order").on(t.orderId)]);

/**
 * Aktionen (Wunsch Inhaber 19.11.2026: „قسم العروض“): Rabatt in ganzen Prozent auf ausgewählte Artikel – im System
 * (Angebot/Rechnung, Katalog, Kundenansicht), am Bestell-Link und in den Shops (Streichpreis + „-20%“, Kollektion „Angebote“) –
 * und ein Werbebild im Shop über oder unter dem Hero. Rabatt und Bild laufen unabhängig: je an/aus und optional von/bis
 * (Berliner Datum, beide Tage inklusive). Regeln rein in src/lib/promo-rules.ts, DB src/lib/promotions.ts, Shops
 * src/lib/shopify/promo-shop.ts + prices.ts.
 */
export const promotions = pgTable("promotions", {
  id: id(),
  number: serial("number").notNull().unique(),
  title: text("title").notNull().default(""),
  discountBp: integer("discount_bp").notNull(), // 2000 = 20 % (nur ganze Prozent)
  // wo der Rabatt gilt: SYSTEM (Angebot/Rechnung/Katalog), DIRECT (Bestell-Link), GENERAL_SHOP, BRAND_SHOP
  places: jsonb("places").$type<string[]>().notNull().default(["SYSTEM", "DIRECT", "GENERAL_SHOP", "BRAND_SHOP"]),
  priceOn: boolean("price_on").notNull().default(false),
  priceFrom: date("price_from"),
  priceUntil: date("price_until"),
  // zuletzt an die Shops gegebener Stand des Rabatts (aktiv ja/nein) – weicht er ab (Datum erreicht), merkt der Worker die Artikel vor
  priceLive: boolean("price_live").notNull().default(false),
  bannerOn: boolean("banner_on").notNull().default(false),
  bannerFrom: date("banner_from"),
  bannerUntil: date("banner_until"),
  bannerShops: jsonb("banner_shops").$type<string[]>().notNull().default(["GENERAL_SHOP"]),
  bannerPlace: text("banner_place").$type<"top" | "below">().notNull().default("top"),
  bannerStyle: integer("banner_style").notNull().default(0),
  // Texte im Bild je Shop-Sprache (de/en/ar/nl): Überschrift, Unterzeile, Kurznamen der Artikel
  bannerCopy: jsonb("banner_copy").$type<Record<string, { headline: string; sub: string; names: string[] }>>().notNull().default({}),
  // fertige Bilder: "wide-de" → stored_files.id (wide 2400×800, tall 1080×1350; de/en/ar/nl)
  bannerFiles: jsonb("banner_files").$type<Record<string, string>>().notNull().default({}),
  bannerVersion: integer("banner_version").notNull().default(0), // +1 je neues Bild → Shops laden neu hoch
  bannerJob: text("banner_job").$type<"" | "running" | "failed">().notNull().default(""),
  bannerError: text("banner_error").notNull().default(""),
  bannerStartedAt: timestamp("banner_started_at", { withTimezone: true }), // zuletzt eingeschaltet – neuere Aktion gewinnt den Platz
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const promotionItems = pgTable("promotion_items", {
  promotionId: text("promotion_id").notNull().references(() => promotions.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [uniqueIndex("promotion_item_unique").on(t.promotionId, t.productId), index("promotion_item_product").on(t.productId)]);

/** Werbebild je Aktion und Shop: hochgeladene Dateien (Shopify Files) der Version banner_version, Fehler */
export const promotionShops = pgTable("promotion_shops", {
  promotionId: text("promotion_id").notNull().references(() => promotions.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  bannerVersion: integer("banner_version").notNull().default(0),
  // "wide-de" → { id: gid://shopify/MediaImage/…, url: https://cdn.shopify.com/… }
  media: jsonb("media").$type<Record<string, { id: string; url: string }>>().notNull().default({}),
  error: text("error").notNull().default(""), // z. B. needScope:write_files, network, Meldung von Shopify
  tries: integer("tries").notNull().default(0),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("promotion_shop_unique").on(t.promotionId, t.channel)]);

/**
 * WhatsApp im System (Wunsch Inhaber 16.11.2026: „الواتساب جوه الابلكيشن … المراسله تترسل من جوه السيستم“): ein Chat je
 * Telefonnummer (wa_id = Nummer international ohne +), verknüpft mit dem Kunden (gleiche Nummer) oder von Hand.
 * Nachrichten kommen über den Webhook (Meta Cloud API) und gehen über die Graph API raus. Logik: src/lib/whatsapp.ts.
 */
export const waChats = pgTable("wa_chats", {
  id: id(),
  waId: text("wa_id").notNull().unique(),
  name: text("name").notNull().default(""), // Profilname bei WhatsApp
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }), // 24-Stunden-Fenster für freie Antworten
  lastText: text("last_text").notNull().default(""),
  unread: integer("unread").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("wa_chat_last").on(t.lastMessageAt), index("wa_chat_customer").on(t.customerId)]);

export const waMessages = pgTable("wa_messages", {
  id: id(),
  chatId: text("chat_id").notNull().references(() => waChats.id, { onDelete: "cascade" }),
  waMessageId: text("wa_message_id").unique(), // wamid.…
  direction: text("direction").notNull(), // in | out
  type: text("type").notNull(), // text | image | document | audio | video | sticker | location | template | reaction | unsupported
  body: text("body").notNull().default(""), // Text, Bildunterschrift oder Vorlagenname
  mediaId: text("media_id"), // Medien-ID bei Meta (eingehend: zum Herunterladen)
  mediaFileId: text("media_file_id"), // heruntergeladen in stored_files
  mediaMime: text("media_mime").notNull().default(""),
  mediaName: text("media_name").notNull().default(""),
  status: text("status").notNull().default(""), // eingehend: received; ausgehend: sent | delivered | read | failed
  error: text("error").notNull().default(""),
  replyTo: text("reply_to"), // wamid der zitierten Nachricht
  sentBy: text("sent_by"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  seq: bigserial("seq", { mode: "number" }).notNull(), // Reihenfolge bei gleicher Sekunde (Meta liefert nur Sekunden)
  createdAt: createdAt(),
}, (t) => [index("wa_msg_chat_at").on(t.chatId, t.at)]);

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
  reverseCharge: boolean("reverse_charge").notNull().default(false), // veraltet, ersetzt durch taxCase
  taxCase: expenseTaxCase("tax_case").notNull().default("DOMESTIC"),
  channel: channel("channel"), // null = allgemein (nicht einem Kanal zugeordnet)
  paid: boolean("paid").notNull().default(true),
  paidAt: date("paid_at", { mode: "string" }),
  paymentMethod: paymentMethod("payment_method"),
  fileId: text("file_id"),
  note: text("note").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("expense_date").on(t.date)]);

// ───────────────────────── Shopify ─────────────────────────
/** Verbindung je Shop (Kanal BRAND_SHOP / GENERAL_SHOP). Geheimnisse verschlüsselt (AES-GCM, Schlüssel aus SESSION_SECRET). */
export const shops = pgTable("shops", {
  channel: channel("channel").primaryKey(),
  domain: text("domain").notNull().default(""),          // xyz.myshopify.com
  clientId: text("client_id").notNull().default(""),
  clientSecretEnc: text("client_secret_enc").notNull().default(""),
  staticTokenEnc: text("static_token_enc").notNull().default(""), // ältere „Custom App“ (shpat_…)
  tokenEnc: text("token_enc").notNull().default(""),     // zwischengespeicherter Zugriffstoken (24 h)
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  locationId: text("location_id").notNull().default(""),
  locationName: text("location_name").notNull().default(""),
  active: boolean("active").notNull().default(false),
  stockBuffer: integer("stock_buffer").notNull().default(0), // so viele Stück im Shop zurückhalten
  importTestOrders: boolean("import_test_orders").notNull().default(false),
  ordersSince: timestamp("orders_since", { withTimezone: true }), // Bestellungen vor diesem Zeitpunkt nicht importieren
  lastOrderSync: timestamp("last_order_sync", { withTimezone: true }),
  lastStockSync: timestamp("last_stock_sync", { withTimezone: true }),
  lastProductSync: timestamp("last_product_sync", { withTimezone: true }),
  webhooksAt: timestamp("webhooks_at", { withTimezone: true }),
  lastError: text("last_error").notNull().default(""),
  // Kategorien des Shops (Produkttypen + Titel der automatischen Kollektion „Produkttyp ist gleich …“), zwischengespeichert
  storeTypes: jsonb("store_types").$type<{ type: string; collection: string | null }[]>().notNull().default([]),
  storeTypesAt: timestamp("store_types_at", { withTimezone: true }),
  // unsere Kategorie → Produkttyp im Shop, wenn die Namen nicht gleich sind (vom Nutzer gewählt)
  categoryMap: jsonb("category_map").$type<Record<string, string>>().notNull().default({}),
  // Kundenkonten-Abgleich: bis hierher (updatedAt im Shop) übernommen; null = beim nächsten Mal alle (src/lib/shopify/customers.ts)
  customersSince: timestamp("customers_since", { withTimezone: true }),
  // Aktionen: automatische Kollektion „Angebote“ (alle reduzierten Artikel) und der zuletzt geschriebene Inhalt ihres
  // Metafelds star_style.banner (Werbebilder über/unter dem Hero) – geschrieben wird nur bei Änderung (src/lib/shopify/promo-shop.ts)
  offersCollectionId: text("offers_collection_id").notNull().default(""),
  promoBanner: text("promo_banner").notNull().default(""),
  updatedAt: updatedAt(),
});

/** Varianten im Shop und ihre Zuordnung zu unseren Varianten */
export const shopVariants = pgTable("shop_variants", {
  id: id(),
  channel: channel("channel").notNull(),
  shopVariantId: text("shop_variant_id").notNull(),       // gid://shopify/ProductVariant/…
  inventoryItemId: text("inventory_item_id").notNull().default(""),
  title: text("title").notNull().default(""),
  sku: text("sku").notNull().default(""),
  barcode: text("barcode").notNull().default(""),
  tracked: boolean("tracked").notNull().default(true),
  variantId: text("variant_id").references(() => variants.id, { onDelete: "set null" }),
  matchedBy: text("matched_by").notNull().default(""),     // barcode | sku | manual
  lastPushedQty: integer("last_pushed_qty"),
  lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
  // zuletzt an den Shop gemeldetes Gewicht (Gramm); weicht es von variants.weight_grams ab, meldet der Worker es (pushDueWeights)
  pushedWeightGrams: integer("pushed_weight_grams"),
  // zuletzt im Shop gesetzter Tag „spedition“ am Produkt (true/false); weicht er von der Versandart ab, setzt der Worker ihn neu
  pushedFreight: boolean("pushed_freight"),
  // Aktionen: Streichpreis (Cent, wie im Shop gezeigt), den WIR gesetzt haben, und der Streichpreis davor (null = keiner).
  // Nach der Aktion wird nur ein Streichpreis zurückgesetzt, den wir gesetzt haben (src/lib/shopify/prices.ts)
  promoCompareCents: integer("promo_compare_cents"),
  prePromoCompareCents: integer("pre_promo_compare_cents"),
  pushError: text("push_error").notNull().default(""),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("shop_variant_unique").on(t.channel, t.shopVariantId), index("shop_variant_ours").on(t.variantId)]);

/**
 * Fotos fürs Shop-Schaufenster (Wunsch Inhaber 04.11.2026): im Lager nur ein Foto (products.image_file_id),
 * im Shop eine eigene Galerie je Kanal. media_id = Shopify-Medium, das wir hochgeladen bzw. übernommen haben (leer = noch nicht im Shop).
 * removed = im Formular entfernt, im Shop noch zu löschen (danach verschwindet die Zeile).
 * hidden = „nur aus dem Shop löschen“ (Wunsch Inhaber 04.11.2026): bleibt bei uns in der Galerie (grau), im Shop wird es gelöscht
 * und media_id danach geleert; „Wieder in den Shop“ = hidden false → wird neu hochgeladen.
 */
export const shopMedia = pgTable("shop_media", {
  id: id(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  fileId: text("file_id").notNull().references(() => storedFiles.id),
  position: integer("position").notNull(),
  mediaId: text("media_id").notNull().default(""),
  removed: boolean("removed").notNull().default(false),
  hidden: boolean("hidden").notNull().default(false),
  error: text("error").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("shop_media_product").on(t.productId, t.channel, t.position)]);

/** Protokoll für den Nutzer: Importe, Bestandsabgleich, Fehler */
export const shopEvents = pgTable("shop_events", {
  id: id(),
  channel: channel("channel").notNull(),
  level: text("level").notNull().default("info"),          // info | warn | error
  kind: text("kind").notNull(),                            // order | cancel | refund | payment | stock | products | connect | webhook
  ref: text("ref").notNull().default(""),                  // z. B. Bestellnummer #1001
  invoiceId: text("invoice_id"),
  message: text("message").notNull().default(""),
  createdAt: createdAt(),
}, (t) => [index("shop_event_time").on(t.channel, t.createdAt)]);

/** Bereits verarbeitete Vorgänge (Erstattungen, Webhooks) – verhindert doppelte Buchungen */
export const shopProcessed = pgTable("shop_processed", {
  key: text("key").primaryKey(),                           // z. B. refund:gid://shopify/Refund/123
  createdAt: createdAt(),
});

/** Inhalt einer Sendung: Rechnungsposition (bei Shop-Bestellungen zusätzlich die Shopify-Position) und Menge */
export type ShipmentItem = { lineId: string | null; externalLineId: string | null; variantId: string | null; description: string; qty: number };

/**
 * Versand mit Sendungsverfolgung (Wunsch Inhaber 12.11.2026): eine Zeile = eine Sendung (ein Versanddienst, 1–n Pakete mit je einer
 * Nummer). Gehört zur Rechnung, bei einer Korrektur wandert sie mit (moveShipments). Bei Shop-Bestellungen wird sie als Fulfillment an
 * Shopify gemeldet → Shopify schickt dem Kunden die Versandbestätigung mit Link zur Sendungsverfolgung. Nie löschen, nur zurücknehmen.
 * shop_status: none (keine Shop-Bestellung) | pending (melden) | update (geänderte Nummern melden) | cancel (im Shop zurücknehmen)
 *              | sent (im Shop) | failed (Shop hat abgelehnt, Fehler in shop_error) | cancelled
 */
export const shipments = pgTable("shipments", {
  id: id(),
  invoiceId: text("invoice_id").notNull().references(() => invoices.id),
  channel: channel("channel").notNull().default("STORE"),
  externalOrderId: text("external_order_id"),                      // Shopify-Bestellung (gid) bei Shop-Bestellungen
  carrier: text("carrier").notNull(),                              // DHL | DPD | GLS | HERMES | UPS | OTHER
  carrierName: text("carrier_name").notNull().default(""),         // OTHER: Name der Spedition (z. B. für Möbel)
  trackingNumbers: jsonb("tracking_numbers").$type<string[]>().notNull().default([]),
  trackingUrl: text("tracking_url").notNull().default(""),         // OTHER: Link der Spedition (optional)
  items: jsonb("items").$type<ShipmentItem[]>().notNull().default([]),
  shippedOn: date("shipped_on", { mode: "string" }).notNull(),
  notifyCustomer: boolean("notify_customer").notNull().default(true),
  source: text("source").notNull().default("system"),              // system | shop (im Shopify-Admin versendet, übernommen)
  shopFulfillmentIds: jsonb("shop_fulfillment_ids").$type<string[]>().notNull().default([]),
  shopStatus: text("shop_status").notNull().default("none"),
  shopError: text("shop_error").notNull().default(""),
  shopTries: integer("shop_tries").notNull().default(0),
  deliveryStatus: text("delivery_status").notNull().default(""),    // Shopify displayStatus (IN_TRANSIT, DELIVERED …), wenn gemeldet
  note: text("note").notNull().default(""),                        // z. B. „1 Palette, 85 kg“ (Spedition)
  /** GLS-Etikett aus dem System (ShipIT): TrackIDs zum Stornieren, Etikett als PDF, Stand created | cancelled */
  glsTrackIds: jsonb("gls_track_ids").$type<string[]>().notNull().default([]),
  glsStatus: text("gls_status").notNull().default(""),
  // Kunde hat zugestimmt, dass GLS E-Mail/Telefon zur Zustellbenachrichtigung bekommt (GLS-Vertrag: Einwilligung nachweisen)
  glsContactConsent: boolean("gls_contact_consent").notNull().default(false),
  labelFileId: text("label_file_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("shipment_invoice").on(t.invoiceId), index("shipment_order").on(t.channel, t.externalOrderId), index("shipment_shop_status").on(t.shopStatus)]);

/**
 * Kunde „جملة الجملة“ (Wiederverkäufer) ↔ Unternehmen im Shop (Shopify B2B, Wunsch Inhaber 12.11.2026): Der Kunde meldet sich im
 * Shop mit seiner E-Mail an und sieht die Preise der Wiederverkäufer-Preisliste. Verbunden wird über die E-Mail, nie über den Namen.
 * wanted = Inhaber will die Verbindung (Häkchen am Kunden); status pending/linked/removed/failed, Fehler in error.
 */
export const shopCompanies = pgTable("shop_companies", {
  id: id(),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  wanted: boolean("wanted").notNull().default(true),
  /** E-Mail, mit der zuletzt verbunden wurde (Shop-Kunde = Kontakt des Unternehmens) */
  email: text("email").notNull().default(""),
  companyId: text("company_id").notNull().default(""),
  locationId: text("location_id").notNull().default(""),
  contactId: text("contact_id").notNull().default(""),
  shopCustomerId: text("shop_customer_id").notNull().default(""),
  /** Name/Anschrift/USt-IdNr. beim letzten Abgleich – geändert → im Shop nachziehen */
  fingerprint: text("fingerprint").notNull().default(""),
  status: text("status").notNull().default("pending"),
  error: text("error").notNull().default(""),
  tries: integer("tries").notNull().default(0),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("shop_company_customer").on(t.customerId, t.channel), index("shop_company_status").on(t.status)]);

/**
 * Kunden aus den Shops (Wunsch Inhaber 13.11.2026: „أي زبون يعمل اكونت على أي من المتجرين يطلع بالسيستم“, auch wer
 * bestellt und nicht online bezahlt, z. B. Nachnahme): je Shop-Kunde eine Zeile, verbunden mit unserem Kunden (per E-Mail).
 */
export const shopCustomers = pgTable("shop_customers", {
  id: id(),
  customerId: text("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  shopCustomerId: text("shop_customer_id").notNull(), // gid://shopify/Customer/…
  email: text("email").notNull().default(""),
  /** ENABLED = hat ein Konto (seit 28.10.2026 nach der ersten Anmeldung), DISABLED = nur bestellt (Gast) bzw. gesperrt */
  state: text("state").notNull().default(""),
  orders: integer("orders").notNull().default(0),
  /** im Shop angelegt am */
  registeredAt: timestamp("registered_at", { withTimezone: true }),
  /** true = unser Kunde wurde dafür neu angelegt, false = mit vorhandenem Kunden (gleiche E-Mail) verbunden */
  createdCustomer: boolean("created_customer").notNull().default(false),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("shop_customer_shop_id").on(t.channel, t.shopCustomerId), index("shop_customer_customer").on(t.customerId)]);

/** Varianten, deren Bestand sich geändert hat und an die Shops gemeldet werden muss */
export const stockDirty = pgTable("stock_dirty", {
  variantId: text("variant_id").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Artikel, deren Shop-Preis (Großhandelspreis Salon = retail_price_cents, MwSt.) sich geändert hat und an die verbundenen
 * Shop-Varianten gemeldet werden muss (Wunsch Inhaber 09.11.2026). Zeile bleibt, bis es geklappt hat (Worker alle 5 min).
 */
export const shopPriceDirty = pgTable("shop_price_dirty", {
  productId: text("product_id").primaryKey().references(() => products.id, { onDelete: "cascade" }),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

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
export const suppliersRelations = relations(suppliers, ({ many }) => ({ products: many(products), expenses: many(expenses) }));

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
  shipments: many(shipments),
}));
export const shipmentsRelations = relations(shipments, ({ one }) => ({ invoice: one(invoices, { fields: [shipments.invoiceId], references: [invoices.id] }) }));
export const expensesRelations = relations(expenses, ({ one }) => ({ supplier: one(suppliers, { fields: [expenses.supplierId], references: [suppliers.id] }) }));
export const dunningsRelations = relations(dunnings, ({ one }) => ({ invoice: one(invoices, { fields: [dunnings.invoiceId], references: [invoices.id] }) }));
export const invoiceLinesRelations = relations(invoiceLines, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceLines.invoiceId], references: [invoices.id] }),
  variant: one(variants, { fields: [invoiceLines.variantId], references: [variants.id] }),
}));
export const paymentsRelations = relations(payments, ({ one }) => ({ invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }) }));
export const waChatsRelations = relations(waChats, ({ one, many }) => ({
  customer: one(customers, { fields: [waChats.customerId], references: [customers.id] }),
  messages: many(waMessages),
}));
export const waMessagesRelations = relations(waMessages, ({ one }) => ({ chat: one(waChats, { fields: [waMessages.chatId], references: [waChats.id] }) }));
export const returnsRelations = relations(returns, ({ one, many }) => ({
  invoice: one(invoices, { fields: [returns.invoiceId], references: [invoices.id], relationName: "returnInvoice" }),
  customer: one(customers, { fields: [returns.customerId], references: [customers.id] }),
  lines: many(returnLines),
}));
export const returnLinesRelations = relations(returnLines, ({ one }) => ({
  ret: one(returns, { fields: [returnLines.returnId], references: [returns.id] }),
  variant: one(variants, { fields: [returnLines.variantId], references: [variants.id] }),
}));
export const installmentsRelations = relations(installments, ({ one }) => ({ invoice: one(invoices, { fields: [installments.invoiceId], references: [invoices.id] }) }));
export const directOrdersRelations = relations(directOrders, ({ one, many }) => ({
  lines: many(directOrderLines),
  customer: one(customers, { fields: [directOrders.customerId], references: [customers.id] }),
  invoice: one(invoices, { fields: [directOrders.invoiceId], references: [invoices.id] }),
  offer: one(offers, { fields: [directOrders.offerId], references: [offers.id] }),
}));
export const directOrderLinesRelations = relations(directOrderLines, ({ one }) => ({
  order: one(directOrders, { fields: [directOrderLines.orderId], references: [directOrders.id] }),
  variant: one(variants, { fields: [directOrderLines.variantId], references: [variants.id] }),
}));
