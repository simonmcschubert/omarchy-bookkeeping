import assert from "node:assert/strict";
import test from "node:test";
import { nextNumber } from "../app/books.mjs";
import { invoiceHtml } from "../app/invoice-html.mjs";
import { EXEMPTION_REASON, GUIDELINE, amountXml, escapeXml, invoiceXml } from "../app/invoice-xml.mjs";
import { KLEINUNTERNEHMER_NOTE, cancellationOf, issuing } from "../app/invoices.mjs";
import { sampleData, sampleDraft } from "./fixtures/invoices.mjs";

function issued(extra = {}) {
  const data = sampleData();
  return issuing(data, sampleDraft(data, extra), nextNumber(data));
}

/** The text of the first element of that name, or null. */
function value(xml, name) {
  const match = xml.match(new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`));
  return match ? match[1] : null;
}

/** Asserts the elements come in this order. */
function inOrder(xml, names) {
  let at = -1;
  for (const name of names) {
    const next = xml.indexOf(`<${name}`, at + 1);
    assert.ok(next > at, `${name} after the one before`);
    at = next;
  }
}

test("XML amounts and escaping", () => {
  assert.equal(amountXml(102000), "1020.00");
  assert.equal(amountXml(-5), "-0.05");
  assert.equal(amountXml(0), "0.00");
  assert.equal(escapeXml(`A & B <c> "d" 'e'\u0001`), "A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;");
});

test("the CII XML of a Kleinunternehmer invoice (EN 16931)", () => {
  const xml = invoiceXml(issued());
  assert.equal(value(xml, "ram:ID"), GUIDELINE);
  assert.equal(GUIDELINE, "urn:cen.eu:en16931:2017");
  assert.equal(value(xml, "ram:TypeCode"), "380");
  assert.match(xml, /<ram:IssueDateTime><udt:DateTimeString format="102">20261119<\/udt:DateTimeString>/);
  assert.ok(xml.includes(`<ram:Content>${KLEINUNTERNEHMER_NOTE}</ram:Content>`));
  // Lines: name, price, quantity with unit, category E at 0 %, amount.
  assert.match(xml, /<ram:BilledQuantity unitCode="DAY">2<\/ram:BilledQuantity>/);
  assert.match(xml, /<ram:BilledQuantity unitCode="HUR">1.5<\/ram:BilledQuantity>/);
  assert.match(xml, /<ram:LineTotalAmount>900.00<\/ram:LineTotalAmount>/);
  assert.equal((xml.match(/<ram:CategoryCode>E<\/ram:CategoryCode>/g) ?? []).length, 3);
  // The seller: Steuernummer as BT-29 and BT-32 (BR-CO-26), § 19 in BT-33.
  assert.match(xml, /<ram:SellerTradeParty><ram:ID>12\/345\/67890<\/ram:ID><ram:Name>Erika Musterfrau<\/ram:Name><ram:Description>Kleinunternehmer gemäß § 19 UStG<\/ram:Description>/);
  assert.match(xml, /<ram:ID schemeID="FC">12\/345\/67890<\/ram:ID>/);
  assert.match(xml, /<ram:PostcodeCode>10115<\/ram:PostcodeCode><ram:LineOne>Musterstraße 12<\/ram:LineOne><ram:CityName>Berlin<\/ram:CityName><ram:CountryID>DE<\/ram:CountryID>/);
  // Delivery date and period, payment by SEPA transfer, VAT breakdown.
  assert.match(xml, /<ram:OccurrenceDateTime><udt:DateTimeString format="102">20261114</);
  assert.match(xml, /<ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString format="102">20261103</);
  assert.match(xml, /<ram:TypeCode>58<\/ram:TypeCode><ram:PayeePartyCreditorFinancialAccount><ram:IBANID>DE02120300000000202051<\/ram:IBANID>/);
  assert.equal(value(xml, "ram:ExemptionReason"), EXEMPTION_REASON);
  assert.equal(EXEMPTION_REASON, "Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG");
  assert.equal(value(xml, "ram:CalculatedAmount"), "0.00");
  assert.equal(value(xml, "ram:GrandTotalAmount"), "1020.00");
  assert.equal(value(xml, "ram:DuePayableAmount"), "1020.00");
  assert.match(xml, /<ram:DueDateDateTime><udt:DateTimeString format="102">20261203</);
  assert.doesNotMatch(xml, /InvoiceReferencedDocument/);
  // The schema's order.
  inOrder(xml, ["rsm:ExchangedDocumentContext", "rsm:ExchangedDocument", "ram:IncludedSupplyChainTradeLineItem", "ram:ApplicableHeaderTradeAgreement", "ram:ApplicableHeaderTradeDelivery", "ram:ApplicableHeaderTradeSettlement"]);
  inOrder(xml, ["ram:PaymentReference", "ram:InvoiceCurrencyCode", "ram:SpecifiedTradeSettlementPaymentMeans", "ram:ApplicableTradeTax><ram:CalculatedAmount", "ram:BillingSpecifiedPeriod", "ram:SpecifiedTradePaymentTerms", "ram:SpecifiedTradeSettlementHeaderMonetarySummation"]);
});

test("with a VAT ID, the seller is told by it; buyers abroad keep their country", () => {
  const data = sampleData();
  data.business.vatId = "DE123456789";
  data.customers[0] = { ...data.customers[0], address: "Ringstraße 1\nA-1010 Wien", country: "AT", vatId: "ATU12345678" };
  const xml = invoiceXml(issuing(data, sampleDraft(data, { service: { from: "2026-11-18", to: "" } }), 42));
  assert.match(xml, /<ram:SellerTradeParty><ram:Name>/);
  assert.match(xml, /<ram:ID schemeID="VA">DE123456789<\/ram:ID>/);
  assert.match(xml, /<ram:ID schemeID="VA">ATU12345678<\/ram:ID>/);
  assert.match(xml, /<ram:PostcodeCode>1010<\/ram:PostcodeCode><ram:LineOne>Ringstraße 1<\/ram:LineOne><ram:CityName>Wien<\/ram:CityName><ram:CountryID>AT<\/ram:CountryID>/);
  assert.doesNotMatch(xml, /BillingSpecifiedPeriod/);
});

test("the XML of a cancellation invoice: 384, negative, with the original", () => {
  const data = sampleData();
  const original = { ...issuing(data, sampleDraft(data), 42), status: "sent" };
  const storno = issuing(data, cancellationOf(data, original, "2026-11-20"), 43);
  const xml = invoiceXml(storno);
  assert.equal(value(xml, "ram:TypeCode"), "384");
  assert.match(xml, /<ram:BilledQuantity unitCode="DAY">-2<\/ram:BilledQuantity>/);
  assert.match(xml, /<ram:ChargeAmount>450.00<\/ram:ChargeAmount>/); // BR-27: never negative
  assert.equal(value(xml, "ram:GrandTotalAmount"), "-1020.00");
  assert.match(xml, /<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>42<\/ram:IssuerAssignedID><ram:FormattedIssueDateTime><qdt:DateTimeString format="102">20261119</);
  assert.doesNotMatch(xml, /PaymentMeans|PaymentReference|DueDateDateTime/);
});

test("the page shows what § 14 Abs. 4 UStG asks for", () => {
  const html = invoiceHtml(issued({ note: "Danke <für> alles & mehr" }));
  for (const text of [
    "Erika Musterfrau", // Nr. 1: seller
    "Musterstraße 12<br>10115 Berlin",
    "Beispielverein e. V.<br>Hauptstraße 5<br>20095 Hamburg", // Nr. 1: buyer
    "<dt>Steuernummer</dt><dd>12/345/67890</dd>", // Nr. 2
    "<dt>Rechnungsdatum</dt><dd>19.11.2026</dd>", // Nr. 3
    "<dt>Rechnungsnummer</dt><dd>42</dd>", // Nr. 4
    "2 Tage", // Nr. 5: quantity and kind
    "1,5 Std.",
    "<dt>Leistungszeitraum</dt><dd>03.11.2026 – 14.11.2026</dd>", // Nr. 6
    "1.020,00 €", // Nr. 7
    KLEINUNTERNEHMER_NOTE, // Nr. 8: the exemption
    "bis zum <strong>03.12.2026</strong>",
    "IBAN DE02 1203 0000 0000 2020 51",
    "Danke &lt;für&gt; alles &amp; mehr",
  ]) {
    assert.ok(html.includes(text), text);
  }
  assert.doesNotMatch(html, /Entwurf|class="invoice draft"/);
  // The page's CSP allows no inline styles or scripts.
  assert.doesNotMatch(html, /<script|style=|<style/);
});

test("a single service date, a draft, and a cancellation page", () => {
  const data = sampleData();
  const single = issuing(data, sampleDraft(data, { service: { from: "2026-11-18", to: "" }, terms: 0 }), 42);
  const html = invoiceHtml(single, { draft: true });
  assert.ok(html.includes("<dt>Leistungsdatum</dt><dd>18.11.2026</dd>"));
  assert.ok(html.includes('class="invoice draft"'));
  assert.ok(html.includes("Rechnungsbetrag sofort ohne Abzug"));
  const storno = invoiceHtml(issuing(data, cancellationOf(data, { ...single, status: "sent" }, "2026-11-20"), 43));
  assert.ok(storno.includes("<h1>Stornorechnung Nr. 43</h1>"));
  assert.ok(storno.includes("Die Rechnung Nr. 42 vom 19.11.2026 wird hiermit in voller Höhe storniert."));
  assert.ok(storno.includes("−1.020,00 €"));
  // Its quantities are negative too, as in its XML: −2 × 450,00 € = −900,00 €.
  assert.ok(storno.includes("−2 Tage"));
  assert.ok(storno.includes("−1,5 Std."));
  assert.ok(storno.includes("450,00 €"));
  assert.ok(storno.includes("−900,00 €"));
  assert.doesNotMatch(storno, /Bitte überweisen/);
});
