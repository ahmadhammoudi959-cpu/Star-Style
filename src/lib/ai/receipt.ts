import "server-only";
import { AiError, callClaude, type ContentBlock, type Message, type Tool } from "./client";
import { mapReceipt, type RawReceipt } from "./receipt-map";
import { EXPENSE_CATEGORIES } from "../accounts";
import { todayIso } from "../dates";

const TOOL: Tool = {
  name: "record_invoice",
  description: "Record the data read from one purchase invoice or receipt.",
  input_schema: {
    type: "object",
    properties: {
      is_invoice: { type: "boolean", description: "false if the document is not an invoice, receipt or bill" },
      vendor_name: { type: "string", description: "Company that issued the invoice (the seller), short legal name" },
      vendor_country: { type: "string", description: "ISO 3166-1 alpha-2 country of the seller, e.g. DE, IE, NL, US" },
      vendor_vat_id: { type: "string", description: "Seller's VAT ID (USt-IdNr.) exactly as printed, empty if none" },
      invoice_number: { type: "string", description: "Invoice / receipt number, empty if none" },
      invoice_date: { type: "string", description: "Invoice date as YYYY-MM-DD" },
      currency: { type: "string", description: "ISO 4217 currency code of the totals, e.g. EUR" },
      total_gross: { type: "number", description: "Total amount payable including VAT" },
      total_net: { type: "number", description: "Total without VAT (0 if not shown)" },
      total_vat: { type: "number", description: "VAT amount charged on the invoice (0 if none)" },
      vat_rate_percent: { type: "number", description: "Main VAT rate in percent, e.g. 19, 7, 21, 0" },
      reverse_charge: { type: "boolean", description: "true if the invoice says reverse charge / tax liability of the recipient / Steuerschuldnerschaft des Leistungsempfängers / VAT exempt intra-community supply" },
      is_goods: { type: "boolean", description: "true for physical goods (products, stock, packaging), false for services (ads, software, fees, consulting, shipping service)" },
      category: { type: "string", enum: EXPENSE_CATEGORIES, description: "GOODS = products bought for resale; ADVERTISING = ads (Meta, Google, TikTok); MARKETING = agency/design; SHOP_FEES = shop platform or payment provider fees; SHIPPING = parcel/shipping costs; PACKAGING; SOFTWARE; PHONE_INTERNET; RENT; STORE_SUPPLIES = office/store supplies; VEHICLE = fuel, car repair; INSURANCE; BANK_FEES; CONSULTING = tax advisor, lawyer; OTHER" },
      already_paid: { type: "boolean", description: "true if the document shows it is already paid (receipt, 'bezahlt', card/PayPal charged, direct debit executed)" },
      payment_method: { type: "string", enum: ["CASH", "BANK", "CARD", "ONLINE", "UNKNOWN"] },
      notes: { type: "string", description: "Very short note (max 1 sentence, German) only if something is unclear or unusual, otherwise empty" },
    },
    required: ["is_invoice", "vendor_name", "vendor_country", "vendor_vat_id", "invoice_number", "invoice_date", "currency", "total_gross", "total_net", "total_vat", "vat_rate_percent", "reverse_charge", "is_goods", "category", "already_paid", "payment_method", "notes"],
    additionalProperties: false,
  },
};

const SYSTEM = `You read purchase invoices and receipts for "Start Style Friseurbedarf", a barber and hairdresser supply wholesaler in Datteln, Germany.
Start Style is always the BUYER (recipient); the vendor is the company that issued the document.
Read the numbers exactly as printed. Never guess numbers that are not visible: use 0 or an empty string instead.
Amounts are plain decimal numbers (e.g. 1234.56), dates are YYYY-MM-DD. Always answer by calling the record_invoice tool.`;

/**
 * Beleg lesen. Ohne erzwungenes Werkzeug: claude-sonnet-5-5 lehnt tool_choice "tool"/"any" ab (400, 06.11.2026) –
 * darum tool_choice "auto" + strict (Eingabe passt genau zum Schema) und die Anweisung im Prompt.
 * Kennt ein Modell/Gateway "strict" nicht → ohne strict. Antwortet das Modell nur mit Text → einmal neu fragen.
 */
export async function readReceipt(data: Buffer, mime: string, opts: { fetchImpl?: typeof fetch } = {}) {
  const b64 = data.toString("base64");
  const doc: ContentBlock = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
    : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
  const messages: Message[] = [{ role: "user", content: [doc, { type: "text", text: "Read this document and record it with the record_invoice tool." }] }];
  const call = (strict: boolean) =>
    callClaude({ system: SYSTEM, tools: [strict ? { ...TOOL, strict: true } : TOOL], tool_choice: { type: "auto" }, messages }, opts);
  let strict = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await call(strict);
    } catch (e) {
      if (!(strict && e instanceof AiError && e.code === "badRequest" && /strict/i.test(e.message))) throw e;
      strict = false;
      res = await call(false);
    }
    const use = res.content.find((c) => c.type === "tool_use") as Extract<ContentBlock, { type: "tool_use" }> | undefined;
    if (use) return mapReceipt(use.input as RawReceipt, todayIso());
  }
  throw new Error("noToolUse");
}
