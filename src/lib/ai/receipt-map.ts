/**
 * Ergebnis der Beleg-Erkennung → Vorschlag für das Ausgaben-Formular.
 * Rein und getestet: Hier wird die Steuerlogik entschieden, NICHT von der KI.
 */
import { EU_COUNTRIES, EXPENSE_CATEGORIES, type ExpenseCategory, type ExpenseTaxCase, type PayMethod } from "../accounts";
import { addDaysIso } from "../dates";

export type RawReceipt = {
  is_invoice?: boolean; vendor_name?: string; vendor_country?: string; vendor_vat_id?: string; invoice_number?: string; invoice_date?: string;
  currency?: string; total_gross?: number; total_net?: number; total_vat?: number; vat_rate_percent?: number;
  reverse_charge?: boolean; is_goods?: boolean; category?: string; already_paid?: boolean; payment_method?: string; notes?: string;
};

export type ReceiptSuggestion = {
  vendorName: string; vendorCountry: string; vendorVatId: string; invoiceNo: string; date: string;
  category: ExpenseCategory; taxCase: ExpenseTaxCase; vatRateBp: number; amount: string;
  paid: boolean; paymentMethod: PayMethod | ""; note: string;
  warnings: { code: "notInvoice" | "foreignCurrency" | "foreignVat" | "importVat" | "dateGuessed" | "rateUnusual" | "amountMissing"; detail?: string }[];
};

const euro = (v: number) => v.toFixed(2).replace(".", ",");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function mapReceipt(x: RawReceipt, today: string): ReceiptSuggestion {
  const warnings: ReceiptSuggestion["warnings"] = [];
  if (x.is_invoice === false) warnings.push({ code: "notInvoice" });

  const vatId = (x.vendor_vat_id ?? "").replace(/[\s.-]/g, "").toUpperCase();
  let country = (x.vendor_country ?? "").trim().toUpperCase().slice(0, 2);
  const prefix = vatId.slice(0, 2) === "EL" ? "GR" : vatId.slice(0, 2);
  if (/^[A-Z]{2}$/.test(prefix) && (prefix === "DE" || EU_COUNTRIES.includes(prefix))) country = prefix; // USt-IdNr. ist verlässlicher als die Adresse
  if (!/^[A-Z]{2}$/.test(country)) country = "DE";

  let date = (x.invoice_date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > addDaysIso(today, 7) || date < addDaysIso(today, -400)) {
    if (x.invoice_date) warnings.push({ code: "dateGuessed", detail: x.invoice_date });
    date = today;
  }

  const category: ExpenseCategory = EXPENSE_CATEGORIES.includes(x.category as ExpenseCategory) ? (x.category as ExpenseCategory) : x.is_goods ? "GOODS" : "OTHER";
  const gross = num(x.total_gross), net = num(x.total_net) || (num(x.total_vat) ? gross - num(x.total_vat) : 0), vat = num(x.total_vat);
  const rate = num(x.vat_rate_percent) || (net > 0 && vat > 0 ? Math.round((vat / net) * 100) : 0);
  const eu = EU_COUNTRIES.includes(country);
  const goods = x.is_goods ?? category === "GOODS";

  let taxCase: ExpenseTaxCase, vatRateBp = 1900, amount = 0;
  if (country === "DE") {
    if (vat > 0) {
      taxCase = "DOMESTIC";
      vatRateBp = Math.abs(rate - 7) <= 1 ? 700 : 1900;
      if (Math.abs(rate - 7) > 1 && Math.abs(rate - 19) > 1) warnings.push({ code: "rateUnusual", detail: String(rate) });
      amount = gross || net + vat;
    } else {
      taxCase = "NO_VAT"; vatRateBp = 0; amount = gross || net;
    }
  } else if (eu) {
    if (vat > 0 && !x.reverse_charge) {
      // ausländische MwSt. ist in Deutschland nicht als Vorsteuer abziehbar
      taxCase = "NO_VAT"; vatRateBp = 0; amount = gross || net + vat;
      warnings.push({ code: "foreignVat", detail: rate ? `${rate} %` : undefined });
    } else {
      taxCase = goods ? "EU_GOODS" : "EU_SERVICE"; vatRateBp = 1900; amount = net || gross;
    }
  } else {
    if (goods) { taxCase = "NO_VAT"; vatRateBp = 0; amount = gross || net; warnings.push({ code: "importVat" }); }
    else { taxCase = "NON_EU_SERVICE"; vatRateBp = 1900; amount = net || gross; }
  }

  const currency = (x.currency ?? "EUR").toUpperCase();
  let amountStr = amount > 0 ? euro(amount) : "";
  if (currency !== "EUR" && amount > 0) { warnings.push({ code: "foreignCurrency", detail: `${amount.toFixed(2)} ${currency}` }); amountStr = ""; }
  if (!amountStr && currency === "EUR") warnings.push({ code: "amountMissing" });

  const pm = x.payment_method as PayMethod;
  return {
    vendorName: (x.vendor_name ?? "").trim().slice(0, 120), vendorCountry: country, vendorVatId: vatId, invoiceNo: (x.invoice_number ?? "").trim().slice(0, 60),
    date, category, taxCase, vatRateBp, amount: amountStr,
    paid: Boolean(x.already_paid), paymentMethod: ["CASH", "BANK", "CARD", "ONLINE"].includes(pm) ? pm : "",
    note: (x.notes ?? "").trim().slice(0, 300), warnings,
  };
}
