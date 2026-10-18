/**
 * Strukturierte E-Rechnung nach EN 16931 im CII-Format (ZUGFeRD 2.x / Factur-X, Profil EN16931).
 * Wird als factur-x.xml in die Rechnungs-PDF eingebettet.
 */

export type EInvoiceData = {
  number: string; typeCode: "380" | "381"; issueDate: string; deliveryDate: string; dueDate: string | null;
  notes: string[];
  seller: { name: string; street: string; zip: string; city: string; country: string; vatId: string; taxNumber: string; email: string; iban: string; bic: string; bankName: string };
  buyer: { id: string; name: string; street: string; zip: string; city: string; country: string; vatId: string };
  taxMode: "DOMESTIC" | "EU_REVERSE_CHARGE" | "EU_PENDING_VATID" | "EU_B2C" | "EXPORT";
  lines: { position: number; name: string; sku: string; ean: string | null; qty: number; unitPriceCents: number; netCents: number; vatRateBp: number; netUnitPrice?: string }[];
  vatBreakdown: { rateBp: number; netCents: number; vatCents: number }[];
  netCents: number; vatCents: number; grossCents: number;
  paymentTermsText: string;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const amt = (c: number) => (c / 100).toFixed(2);
const pct = (bp: number) => (bp / 100).toFixed(2);
const d8 = (iso: string) => iso.replace(/-/g, "");

function category(mode: EInvoiceData["taxMode"], rateBp: number) {
  if (mode === "EU_REVERSE_CHARGE") return { code: "K", reason: "Innergemeinschaftliche Lieferung", reasonCode: "VATEX-EU-IC" };
  if (mode === "EXPORT") return { code: "G", reason: "Ausfuhrlieferung", reasonCode: "VATEX-EU-G" };
  if (rateBp === 0) return { code: "Z", reason: "", reasonCode: "" };
  return { code: "S", reason: "", reasonCode: "" };
}

export function buildCiiXml(d: EInvoiceData): string {
  // Bei Storno (381) werden die Beträge positiv übertragen – die Art „Gutschrift/Storno“ ergibt sich aus dem Typcode.
  const sign = d.typeCode === "381" ? -1 : 1;
  const A = (c: number) => amt(c * sign);
  const lines = d.lines.map((l) => {
    const qty = l.qty * sign;
    const gross = qty * l.unitPriceCents;
    const allowance = l.netUnitPrice ? 0 : gross - l.netCents * sign;
    const cat = category(d.taxMode, l.vatRateBp);
    return `
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${l.position}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        ${l.ean ? `<ram:GlobalID schemeID="0160">${esc(l.ean)}</ram:GlobalID>` : ""}
        ${l.sku ? `<ram:SellerAssignedID>${esc(l.sku)}</ram:SellerAssignedID>` : ""}
        <ram:Name>${esc(l.name)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${l.netUnitPrice ?? amt(l.unitPriceCents)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">${qty}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>${cat.code}</ram:CategoryCode><ram:RateApplicablePercent>${pct(l.vatRateBp)}</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        ${allowance > 0 ? `<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator><ram:ActualAmount>${amt(allowance)}</ram:ActualAmount><ram:Reason>Rabatt</ram:Reason></ram:SpecifiedTradeAllowanceCharge>` : ""}
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${A(l.netCents)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  }).join("");

  const taxes = d.vatBreakdown.map((g) => {
    const cat = category(d.taxMode, g.rateBp);
    return `
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${A(g.vatCents)}</ram:CalculatedAmount><ram:TypeCode>VAT</ram:TypeCode>
        ${cat.reason ? `<ram:ExemptionReason>${cat.reason}</ram:ExemptionReason>` : ""}
        <ram:BasisAmount>${A(g.netCents)}</ram:BasisAmount><ram:CategoryCode>${cat.code}</ram:CategoryCode>
        ${cat.reasonCode ? `<ram:ExemptionReasonCode>${cat.reasonCode}</ram:ExemptionReasonCode>` : ""}
        <ram:RateApplicablePercent>${pct(g.rateBp)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`;
  }).join("");

  const s = d.seller, b = d.buyer;
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${esc(d.number)}</ram:ID><ram:TypeCode>${d.typeCode}</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${d8(d.issueDate)}</udt:DateTimeString></ram:IssueDateTime>
    ${d.notes.map((n) => `<ram:IncludedNote><ram:Content>${esc(n)}</ram:Content></ram:IncludedNote>`).join("")}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>${lines}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${esc(s.name)}</ram:Name>
        <ram:PostalTradeAddress><ram:PostcodeCode>${esc(s.zip)}</ram:PostcodeCode><ram:LineOne>${esc(s.street)}</ram:LineOne><ram:CityName>${esc(s.city)}</ram:CityName><ram:CountryID>${s.country}</ram:CountryID></ram:PostalTradeAddress>
        ${s.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${esc(s.email)}</ram:URIID></ram:URIUniversalCommunication>` : ""}
        ${s.taxNumber ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${esc(s.taxNumber)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
        ${s.vatId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(s.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:ID>${esc(b.id)}</ram:ID><ram:Name>${esc(b.name)}</ram:Name>
        <ram:PostalTradeAddress><ram:PostcodeCode>${esc(b.zip)}</ram:PostcodeCode><ram:LineOne>${esc(b.street)}</ram:LineOne><ram:CityName>${esc(b.city)}</ram:CityName><ram:CountryID>${b.country}</ram:CountryID></ram:PostalTradeAddress>
        ${b.vatId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${esc(b.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent><ram:OccurrenceDateTime><udt:DateTimeString format="102">${d8(d.deliveryDate)}</udt:DateTimeString></ram:OccurrenceDateTime></ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      ${s.iban ? `<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${esc(s.iban)}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>${s.bic ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${esc(s.bic)}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>` : ""}</ram:SpecifiedTradeSettlementPaymentMeans>` : ""}${taxes}
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>${esc(d.paymentTermsText)}</ram:Description>
        ${d.dueDate ? `<ram:DueDateDateTime><udt:DateTimeString format="102">${d8(d.dueDate)}</udt:DateTimeString></ram:DueDateDateTime>` : ""}
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${A(d.netCents)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${A(d.netCents)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${A(d.vatCents)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${A(d.grossCents)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${A(d.grossCents)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}
