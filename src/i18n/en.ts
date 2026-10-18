import type { Dict } from "./de";

const en: Dict = {
  app: { name: "Star Style", tagline: "Stock · Sales · Invoices" },
  common: {
    save: "Save", cancel: "Cancel", back: "Back", add: "Add", edit: "Edit",
    delete: "Delete", search: "Search …", actions: "Actions", yes: "Yes", no: "No", none: "—",
    required: "Required", saved: "Saved", error: "Something went wrong", all: "All",
    date: "Date", note: "Note", qty: "Qty", total: "Total", optional: "optional", logout: "Log out",
    active: "Active", inactive: "Inactive", details: "Details", close: "Close", remove: "Remove",
    language: "Language", nothingYet: "Nothing here yet", confirm: "Confirm",
  },
  nav: {
    home: "Home", products: "Products", receive: "Goods in", stock: "Stock", writeOffs: "Losses",
    suppliers: "Suppliers", settings: "Settings", sales: "Sales", reports: "Reports", expenses: "Expenses",
  },
  home: {
    greeting: "Hello", subtitle: "What would you like to do?",
    sell: "Sell", sellHint: "Quote or invoice",
    receive: "Goods in", receiveHint: "Book a new delivery",
    loss: "Expense / loss", lossHint: "Breakage, expiry, costs",
    reports: "Reports", reportsHint: "Sales & profit",
    stockValue: "Stock value", lowStock: "Low stock", expiring: "Expiring soon", articles: "products",
    alerts: "Alerts", noAlerts: "All good – no alerts.", comingSoon: "Coming in stage 2",
  },
  login: {
    title: "Sign in", email: "Email", password: "Password", submit: "Sign in", invalid: "Wrong email or password.",
  },
  setup: {
    title: "First-time setup", intro: "Create your account and enter the company details. This happens only once.",
    account: "Your account", name: "Name", company: "Company", companyName: "Company name", vatId: "VAT ID",
    street: "Street and no.", zip: "Postcode", city: "City", submit: "Set up and start",
    passwordHint: "At least 10 characters", alreadyDone: "Setup is already complete.",
  },
  product: {
    title: "Products", new: "New product", edit: "Edit product", sku: "Product no.",
    nameDe: "Name (German)", nameNl: "Name (Dutch)", descDe: "Description (German)", descNl: "Description (Dutch)",
    category: "Category", supplier: "Supplier", vat: "VAT", purchase: "Purchase price (net)", wholesale: "Wholesale price (net)",
    retail: "Retail price (net)", tracksExpiry: "Has expiry date", shops: "Visible in", brandShop: "Brand shop",
    generalShop: "General shop", variants: "Variants", size: "Size", color: "Colour", barcode: "Barcode (EAN)",
    minStock: "Min. stock", stock: "Stock", addVariant: "Add variant", noVariantsHint: "No size/colour? Leave one row empty.",
    skuTaken: "This product number already exists.", barcodeTaken: "This barcode is already used.", duplicateVariant: "Same size/colour twice.",
    variantHasStock: "A variant with stock cannot be removed.", empty: "No products yet. Add the first one.", margin: "Margin", reserved: "reserved", available: "available",
  },
  receive: {
    title: "Goods in", new: "New delivery", supplier: "Supplier", supplierInvoice: "Supplier invoice / note no.",
    lines: "Lines", pickProduct: "Find product (name, no., barcode)", unitCost: "Unit cost (net)", batchNo: "Batch",
    expiry: "Best before", addLine: "Add line", submit: "Book goods in", booked: "Goods booked in",
    expiryRequired: "This product needs an expiry date.", history: "Recent deliveries", number: "No.",
    items: "Lines", value: "Value",
  },
  stock: {
    title: "Stock", movements: "Movements", value: "Stock value (cost)", low: "below minimum", filterLow: "Low stock only",
    type: { RECEIPT: "Goods in", SALE: "Sale", RETURN: "Return", WRITE_OFF: "Loss", ADJUSTMENT: "Stocktake", CANCEL: "Cancellation" },
    adjust: "Stocktake correction", counted: "Counted quantity", adjustReason: "Reason", adjusted: "Stock corrected",
    avgCost: "Avg. cost", batches: "Batches", expiresIn: "expires in {d} days", expired: "expired",
  },
  writeOff: {
    title: "Losses & write-offs", new: "Record loss", reason: "Reason",
    reasons: { BREAKAGE: "Breakage", DAMAGE: "Damage", EXPIRED: "Expired", LOSS: "Loss / shrinkage", OTHER: "Other" },
    photo: "Photo", submit: "Book loss", booked: "Loss booked", notEnough: "Not enough stock", protocol: "Report",
    value: "Value (cost)",
  },
  supplier: {
    title: "Suppliers", new: "New supplier", name: "Name", contact: "Contact person", email: "Email", phone: "Phone",
    country: "Country", vatId: "VAT ID", empty: "No suppliers yet.",
  },
  settings: {
    title: "Settings", company: "Company details", bank: "Bank", invoice: "Invoices", owner: "Owner",
    taxNumber: "Tax number", bankName: "Bank", iban: "IBAN", bic: "BIC", paymentDays: "Payment term (days)",
    offerDays: "Quote valid (days)", footer: "Invoice footer", website: "Website",
  },
};
export default en;
