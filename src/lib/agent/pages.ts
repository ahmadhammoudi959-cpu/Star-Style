/**
 * Landkarte des Systems für den Assistenten „Star Style“: welche Seite wofür da ist (rein, getestet).
 * Nur Seiten, die die angemeldete Person öffnen darf (gleiche Regeln wie das Menü: `canOpen`).
 */
import { canOpen, type Access } from "../permissions";

type Page = { path: string; check?: string; what: string };

const PAGES: Page[] = [
  { path: "/", what: "Home: key figures, hints (low stock, expiring, unpaid), shortcuts" },
  { path: "/sales", what: "Sales: lists of offers and invoices with filters (customer, status, payment state, shipping); buttons for new offer and direct invoice" },
  { path: "/sales/invoices/new", what: "New invoice editor: choose customer, add products (search field or the 'all products' window), quantity, price, discount, notes, payment at issue, installment plan. Buttons: save as draft, issue (FINAL – an issued invoice can never be changed or deleted, only cancelled/corrected)" },
  { path: "/sales/offers/new", what: "New offer (quote) editor, same as invoice editor; saving reserves stock" },
  { path: "/sales/invoices/<id>", check: "/sales", what: "Invoice detail: PDF, payments (record payment, plan), shipping with tracking number, e-mail to customer, edit (= correction), cancel, return" },
  { path: "/sales/offers/<id>", check: "/sales", what: "Offer detail: turn into invoice, PDF, e-mail, status" },
  { path: "/direct", what: "Direct sales: lists that customers send through the public order link (catalogue on a tablet or phone, no payment) – order links per price group (copy, QR), list of received lists (filter: all by default, new / done / declined; ?state=new shows only new ones)" },
  { path: "/direct/<id>", check: "/direct", what: "One received list: requested products, the customer's details, choose the customer (or add a new one) and create a quote or an invoice draft from it; decline" },
  { path: "/promotions", what: "Promotions (discount campaigns): list of promotions with their ad image, discount and status; button “New promotion”" },
  { path: "/promotions/new", check: "/promotions", what: "New promotion: pick products, discount in whole percent (1–90), where it applies (system, order link, general shop, brand shop) – then the AI makes the ad image" },
  { path: "/promotions/<id>", check: "/promotions", what: "One promotion: ad image (new image, edit text, download), discount on/off with optional from/until dates (+days buttons), ad image in the shop on/off (which shop, above or below the hero, dates), products, end promotion. Starting/stopping changes prices in the shops – a saving step" },
  { path: "/returns", what: "Returns list" },
  { path: "/returns/new", what: "Record a return for an issued invoice (back to stock or damaged, refund)" },
  { path: "/receivables", what: "Open items: unpaid/overdue invoices, reminders (dunning)" },
  { path: "/customers", what: "Customer list with search and filters; link to new customer" },
  { path: "/customers/new", what: "New customer form (name, contact, address, VAT id, price group)" },
  { path: "/customers/<id>", check: "/customers", what: "Customer detail/edit, invoices, account statement, e-mail/WhatsApp buttons" },
  { path: "/mail", what: "E-mail inbox info@ (read, reply)" },
  { path: "/mail/compose", what: "Write a new e-mail (to, subject, text, attachments)" },
  { path: "/whatsapp", what: "WhatsApp Web panel (you cannot operate inside it – only open it)" },
  { path: "/products", what: "Product list (search, category); link to new product" },
  { path: "/products/new", what: "New product form (names DE/NL, category, barcode, sizes/colors, prices, stock at creation)" },
  { path: "/products/import", what: "Import products from an Excel/CSV file (?file=<attached file id>&photos=<id>,<id>): column matching, check of every row, photos, import button" },
  { path: "/products/<id>", check: "/products", what: "Product detail/edit (photo field, prices, sizes/colors)" },
  { path: "/categories", what: "Categories" },
  { path: "/receive", what: "Goods receipt (incoming goods): supplier, items, quantity, purchase price, batch, best-before date; list of past receipts" },
  { path: "/stock", what: "Stock list per size/color (filters: category, low stock, expiry)" },
  { path: "/stock/<id>", check: "/stock", what: "Stock detail of one product variant: movements, inventory count" },
  { path: "/scan", what: "Barcode scanner (camera) – look up a product" },
  { path: "/write-offs", what: "Losses (damaged, expired, lost) with protocol" },
  { path: "/expenses", what: "Expenses (purchase invoices) by month" },
  { path: "/expenses/new", what: "New expense form: company, date, amount, VAT case, category, payment method, receipt photo" },
  { path: "/expenses/vendors", what: "Companies from expenses" },
  { path: "/suppliers", what: "Goods suppliers list; /suppliers/new = new supplier" },
  { path: "/reports", what: "Monthly/yearly profit & loss report" },
  { path: "/reports/export", what: "Monthly package for the tax advisor (DATEV)" },
  { path: "/insights", what: "Reorder suggestions, expiry risk, slow movers; /insights/order = order list per supplier" },
  { path: "/ask", what: "Ask questions about the business (AI)" },
  { path: "/shops", what: "Online shops (Shopify): status, protocol, product import, prices" },
  { path: "/design", what: "Design of invoices/offers PDF" },
  { path: "/settings", what: "Settings: company data and links to sub-settings" },
  { path: "/settings/mail", what: "Mailbox settings, signature, e-mail texts for invoices/offers" },
  { path: "/settings/carriers", what: "Shipping carriers" },
];

export function pageMapText(access: Access): string {
  return PAGES.filter((p) => canOpen(access, p.check ?? p.path)).map((p) => `${p.path} – ${p.what}`).join("\n");
}
