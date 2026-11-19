// Bookkeeping: the invoice data inside the ZUGFeRD PDF (factur-x.xml): a
// UN/CEFACT Cross Industry Invoice (CII) in the EN 16931 profile (COMFORT
// in ZUGFeRD 1), as ZUGFeRD 2.5.2 / Factur-X 1.09.2 (FeRD, 04.08.2026)
// describe it. No DOM here, so node --test checks it; the Mustang validator
// checks every invoice before it is kept (invoice_pdf.py).
//
// The comments name the EN 16931 business terms (BT-…) and groups (BG-…).
// The elements come in the order the CII schema wants. FeRD's official
// sample E13_01_Kleinunternehmer_ohneUStId (ZUGFeRD 2.5.2) has the same
// shape for a Kleinunternehmer without a VAT ID.

import { KLEINUNTERNEHMER, KLEINUNTERNEHMER_NOTE, dueDate, invoiceTotals, splitAddress } from "./invoices.mjs";

export const GUIDELINE = "urn:cen.eu:en16931:2017"; // BT-24: the EN 16931 profile, no suffix

// A Kleinunternehmer's supplies are tax-exempt (§ 19 Abs. 1 UStG), so their
// VAT category is E (exempt), rate 0, with the reason as text (BT-120).
// The wording is KoSIT's (XRechnung 3.0.2, section 13.3) and FeRD's (sample
// E13). There is no exemption reason code (BT-121) for it: the EU's VATEX
// list has none for Germany.
export const EXEMPTION_REASON = "Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG";
// BT-33, the seller's additional legal information, as in FeRD's sample.
export const KLEINUNTERNEHMER_INFO = "Kleinunternehmer gemäß § 19 UStG";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value) {
  // Control characters other than tab and newline are not allowed in XML.
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Cents as "1234.50": XML decimals have a point and no thousands. */
export function amountXml(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function quantityXml(quantity) {
  return String(Math.round(quantity * 1000) / 1000);
}

function dateXml(iso, type = "udt") {
  return `<${type}:DateTimeString format="102">${iso.replaceAll("-", "")}</${type}:DateTimeString>`;
}

function el(name, content) {
  return content == null || content === "" ? "" : `<${name}>${content}</${name}>`;
}

function text(name, value) {
  return el(name, escapeXml(value));
}

/**
 * BT-3: 380 is an invoice. A cancellation invoice (Stornorechnung) is 384,
 * a corrected invoice, with negative amounts and the cancelled invoice in
 * BG-3, as in FeRD's samples E20 and X16. The BMF has not fixed a type
 * for it (letter of 15.10.2026, Rn. 20 f.): any is fine when the original
 * and the correction together are clear.
 */
export function typeCode(invoice) {
  return invoice.kind === "cancellation" ? "384" : "380";
}

function address(party) {
  const a = splitAddress(party.address);
  const [one, two, ...rest] = a.lines;
  return el(
    "ram:PostalTradeAddress",
    [
      text("ram:PostcodeCode", a.postcode),
      text("ram:LineOne", one),
      text("ram:LineTwo", two),
      text("ram:LineThree", rest.join(", ")),
      text("ram:CityName", a.city),
      text("ram:CountryID", party.country || "DE"),
    ].join(""),
  );
}

function email(party) {
  return party.email ? `<ram:URIUniversalCommunication><ram:URIID schemeID="EM">${escapeXml(party.email)}</ram:URIID></ram:URIUniversalCommunication>` : "";
}

function taxRegistration(scheme, id) {
  return id ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="${scheme}">${escapeXml(id)}</ram:ID></ram:SpecifiedTaxRegistration>` : "";
}

/**
 * The seller. EN 16931 rule BR-CO-26 wants an identifier the buyer can
 * tell the seller by: BT-29, a register number (BT-30) or the VAT ID
 * (BT-31). A Steuernummer (BT-32) alone does not count, so without a VAT
 * ID it also goes in BT-29, as in FeRD's sample E13.
 */
function seller(party, kleinunternehmer) {
  return el(
    "ram:SellerTradeParty",
    [
      party.vatId ? "" : text("ram:ID", party.taxNumber), // BT-29
      text("ram:Name", party.name), // BT-27
      kleinunternehmer ? text("ram:Description", KLEINUNTERNEHMER_INFO) : "", // BT-33
      address(party), // BG-5
      email(party), // BT-34
      taxRegistration("FC", party.taxNumber), // BT-32: Steuernummer
      taxRegistration("VA", party.vatId), // BT-31: USt-IdNr.
    ].join(""),
  );
}

function buyer(party) {
  return el("ram:BuyerTradeParty", [text("ram:Name", party.name), address(party), email(party), taxRegistration("VA", party.vatId)].join("")); // BT-44, BG-8, BT-49, BT-48
}

function tradeTax({ category, rate }, totals) {
  return el(
    "ram:ApplicableTradeTax",
    [
      totals ? el("ram:CalculatedAmount", amountXml(totals.tax)) : "", // BT-117
      "<ram:TypeCode>VAT</ram:TypeCode>",
      totals && category === "E" ? text("ram:ExemptionReason", EXEMPTION_REASON) : "", // BT-120
      totals ? el("ram:BasisAmount", amountXml(totals.basis)) : "", // BT-116
      el("ram:CategoryCode", category), // BT-118, BT-151
      el("ram:RateApplicablePercent", String(rate)), // BT-119, BT-152
    ].join(""),
  );
}

/** A line. The item net price (BT-146) may not be negative (BR-27): a
 *  cancellation or a discount has a negative quantity instead. */
function line(item, index, quantitySign) {
  const [name, ...more] = String(item.text).split(/\r?\n/);
  return el(
    "ram:IncludedSupplyChainTradeLineItem",
    [
      el("ram:AssociatedDocumentLineDocument", el("ram:LineID", String(index + 1))), // BT-126
      el("ram:SpecifiedTradeProduct", text("ram:Name", name.trim()) + text("ram:Description", more.join(" ").trim())), // BT-153, BT-154
      el("ram:SpecifiedLineTradeAgreement", el("ram:NetPriceProductTradePrice", el("ram:ChargeAmount", amountXml(item.price)))), // BT-146
      el("ram:SpecifiedLineTradeDelivery", `<ram:BilledQuantity unitCode="${escapeXml(item.unit)}">${quantityXml(quantitySign * item.quantity)}</ram:BilledQuantity>`), // BT-129, BT-130
      el("ram:SpecifiedLineTradeSettlement", tradeTax(item.vat) + el("ram:SpecifiedTradeSettlementLineMonetarySummation", el("ram:LineTotalAmount", amountXml(item.amount)))), // BT-131
    ].join(""),
  );
}

function dateText(iso) {
  return iso.split("-").reverse().join(".");
}

/** The CII XML of an issued invoice: it has its number, seller and buyer. */
export function invoiceXml(invoice) {
  const totals = invoiceTotals(invoice);
  const cancellation = invoice.kind === "cancellation";
  const original = cancellation ? (invoice.original ?? {}) : null;
  const kleinunternehmer = (invoice.vat ?? KLEINUNTERNEHMER) === KLEINUNTERNEHMER;
  const notes = [
    cancellation ? `Stornorechnung zur Rechnung Nr. ${original.number} vom ${dateText(original.date)}` : "",
    kleinunternehmer ? KLEINUNTERNEHMER_NOTE : "",
    invoice.note ?? "",
  ].filter((n) => n.trim());
  // The service's date (BT-72: the day it "was made or completed"), and for
  // a service over days its period too (BG-14).
  const service = invoice.service ?? {};
  const period = service.to && service.to !== service.from;
  const s = invoice.seller;
  const due = dueDate(invoice);
  const settlement = [
    cancellation ? "" : text("ram:PaymentReference", `Rechnung ${invoice.number}`), // BT-83
    "<ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>", // BT-5
    // BG-16: SEPA credit transfer (58) to the IBAN (BT-84, rule BR-61).
    cancellation ? "" : el("ram:SpecifiedTradeSettlementPaymentMeans", "<ram:TypeCode>58</ram:TypeCode>" + el("ram:PayeePartyCreditorFinancialAccount", text("ram:IBANID", s.iban.replace(/\s+/g, "").toUpperCase()) + text("ram:AccountName", s.name))),
    ...totals.breakdown.map((g) => tradeTax(g, g)), // BG-23
    period ? el("ram:BillingSpecifiedPeriod", el("ram:StartDateTime", dateXml(service.from)) + el("ram:EndDateTime", dateXml(service.to))) : "", // BG-14
    cancellation
      ? el("ram:SpecifiedTradePaymentTerms", text("ram:Description", `Die Rechnung Nr. ${original.number} ist storniert: bitte nicht zahlen.`))
      : el("ram:SpecifiedTradePaymentTerms", text("ram:Description", invoice.terms ? `Zahlbar ohne Abzug bis ${dateText(due)}.` : "Zahlbar sofort ohne Abzug.") + el("ram:DueDateDateTime", dateXml(due))), // BT-20, BT-9
    el(
      "ram:SpecifiedTradeSettlementHeaderMonetarySummation",
      [
        el("ram:LineTotalAmount", amountXml(totals.net)), // BT-106
        el("ram:TaxBasisTotalAmount", amountXml(totals.net)), // BT-109
        `<ram:TaxTotalAmount currencyID="EUR">${amountXml(totals.tax)}</ram:TaxTotalAmount>`, // BT-110
        el("ram:GrandTotalAmount", amountXml(totals.gross)), // BT-112
        el("ram:DuePayableAmount", amountXml(totals.gross)), // BT-115
      ].join(""),
    ),
    // BG-3: the cancelled invoice, its number (BT-25) and date (BT-26).
    original ? el("ram:InvoiceReferencedDocument", text("ram:IssuerAssignedID", original.number) + el("ram:FormattedIssueDateTime", dateXml(original.date, "qdt"))) : "",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
<rsm:ExchangedDocumentContext>${el("ram:GuidelineSpecifiedDocumentContextParameter", el("ram:ID", GUIDELINE))}</rsm:ExchangedDocumentContext>
<rsm:ExchangedDocument>${[
    text("ram:ID", invoice.number), // BT-1
    el("ram:TypeCode", typeCode(invoice)), // BT-3
    el("ram:IssueDateTime", dateXml(invoice.date)), // BT-2
    ...notes.map((n) => el("ram:IncludedNote", text("ram:Content", n))), // BT-22
  ].join("")}</rsm:ExchangedDocument>
<rsm:SupplyChainTradeTransaction>
${totals.lines.map((item, i) => line(item, i, cancellation ? -1 : 1)).join("\n")}
${el("ram:ApplicableHeaderTradeAgreement", seller(s, kleinunternehmer) + buyer(invoice.buyer))}
${el("ram:ApplicableHeaderTradeDelivery", el("ram:ActualDeliverySupplyChainEvent", el("ram:OccurrenceDateTime", dateXml(period ? service.to : service.from))))}
${el("ram:ApplicableHeaderTradeSettlement", settlement.join(""))}
</rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
}
