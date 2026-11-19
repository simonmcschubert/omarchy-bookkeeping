import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptyData } from "../app/books.mjs";
import { decimalText, expenseFromInvoice, hasInvoiceView, ibanText, invoiceSummary, invoiceView, money } from "../app/einvoice.mjs";

// What the server read from the made-up samples (einvoice_samples.py
// writes this file; test_einvoice_reader.py keeps it up to date).
const readings = JSON.parse(readFileSync(new URL("./fixtures/einvoices/readings.json", import.meta.url), "utf8"));
const invoice = (name) => structuredClone(readings[name].invoice);

const expense = (date, text, category, extra = {}) => ({ id: `${date}-${text}`, kind: "expense", date, amount: 100, text, category, ref: "", receipt: null, ...extra });

test("numbers in German notation", () => {
  assert.equal(decimalText("1234.5678"), "1.234,5678");
  assert.equal(decimalText("4.990", 2), "4,99");
  assert.equal(decimalText("12", 2), "12,00");
  assert.equal(decimalText("6.000"), "6");
  assert.equal(decimalText("-0.5"), "−0,5");
  assert.equal(decimalText("007"), "7");
  assert.equal(money(6216), "62,16 €");
  assert.equal(money(-590, "USD"), "−5,90 USD");
  assert.equal(ibanText("DE09123456780001234567"), "DE09 1234 5678 0001 2345 67");
});

test("which receipts have a readable view", () => {
  assert.equal(hasInvoiceView({ file: "a.xml" }), true);
  assert.equal(hasInvoiceView({ file: "a.xml", einvoice: false }), false);
  assert.equal(hasInvoiceView({ file: "a.pdf", einvoice: true }), true);
  assert.equal(hasInvoiceView({ file: "a.pdf" }), false);
  assert.equal(hasInvoiceView(null), false);
});

test("an e-invoice fills in a new expense, but not the day it was paid", () => {
  const draft = expenseFromInvoice(emptyData(), invoice("xrechnung-ubl.xml"), "abc.xml");
  assert.equal(draft.text, "Beispiel Hosting GmbH");
  assert.equal(draft.amount, 2606);
  assert.equal(draft.ref, "BH-2025-0117");
  assert.equal(draft.category, null);
  assert.deepEqual(draft.dates, [
    { label: "Invoice date", date: "2025-01-15" },
    { label: "Due date", date: "2025-01-29" },
  ]);
  assert.deepEqual(draft.warnings, []);
  assert.equal(invoiceSummary(invoice("xrechnung-ubl.xml")), "Invoice BH-2025-0117 of 15.01.2025 · due 29.01.2025 · 26,06 €");

  // One line: the text says what it was for.
  assert.equal(expenseFromInvoice(emptyData(), invoice("xrechnung-cii.xml")).text, "Grafikbüro Max Mustermann: Logo-Entwurf, drei Varianten");
  assert.equal(expenseFromInvoice(emptyData(), invoice("zugferd-en16931.pdf")).amount, 6216);
});

test("a credit note becomes a refund", () => {
  const draft = expenseFromInvoice(emptyData(), invoice("xrechnung-ubl-credit-note.xml"));
  assert.equal(draft.amount, -590);
  assert.match(draft.notes.join(" "), /credit note/);
  // A corrected invoice with negative amounts (a Storno, type 384) keeps its sign.
  const storno = { ...invoice("xrechnung-ubl.xml"), type: "384", totals: { gross: -2606, payable: -2606 } };
  assert.equal(expenseFromInvoice(emptyData(), storno).amount, -2606);
});

test("the category of the last expense from the same supplier", () => {
  const data = emptyData();
  data.entries = [expense("2024-12-15", "Beispiel Hosting GmbH: Webhosting", "ex-1"), expense("2025-01-02", "beispiel hosting gmbh", "ex-21"), expense("2025-02-01", "Something else", "ex-82")];
  const draft = expenseFromInvoice(data, invoice("xrechnung-ubl.xml"));
  assert.equal(draft.category, "ex-21");
  assert.match(draft.notes.join(" "), /last expense from Beispiel Hosting GmbH, on 02\.01\.2025/);
});

test("the same invoice twice is pointed out", () => {
  const data = emptyData();
  data.entries = [expense("2025-01-20", "Beispiel Hosting GmbH", "ex-1", { ref: "BH-2025-0117", receipt: { file: "abc.xml", name: "x.xml" } })];
  assert.match(expenseFromInvoice(data, invoice("xrechnung-ubl.xml"), "abc.xml").warnings.join(" "), /receipt of "Beispiel Hosting GmbH" on 20\.01\.2025 already/);
  assert.match(expenseFromInvoice(data, invoice("xrechnung-ubl.xml"), "other.pdf").warnings.join(" "), /invoice no\. BH-2025-0117 is there already/);
  data.entries[0].text = "Another supplier";
  assert.deepEqual(expenseFromInvoice(data, invoice("xrechnung-ubl.xml"), "other.pdf").warnings, []);
});

test("other currencies, paid invoices, reverse charge and self-billing", () => {
  const usd = { ...invoice("xrechnung-ubl.xml"), currency: "USD" };
  const draft = expenseFromInvoice(emptyData(), usd);
  assert.equal(draft.amount, null);
  assert.match(draft.warnings[0], /in USD \(26,06 USD\): enter the euros/);

  // Paid by card, say: the total is what was paid, once.
  const paid = { ...invoice("xrechnung-ubl.xml"), totals: { gross: 2606, prepaid: 2606, payable: 0 } };
  assert.equal(expenseFromInvoice(emptyData(), paid).amount, 2606);
  assert.match(expenseFromInvoice(emptyData(), paid).warnings[0], /paid in full already \(26,06 €\).*unless that payment is booked already/);
  assert.equal(invoiceSummary(paid), "Invoice BH-2025-0117 of 15.01.2025 · 26,06 €, paid");
  // Nothing to pay, but nothing prepaid either: no amount to guess.
  const nothing = { ...invoice("xrechnung-ubl.xml"), totals: { gross: 2606, payable: 0 } };
  assert.equal(expenseFromInvoice(emptyData(), nothing).amount, null);
  assert.equal(invoiceSummary(nothing), "Invoice BH-2025-0117 of 15.01.2025 · due 29.01.2025 · 0,00 €");
  const noPayable = { ...invoice("xrechnung-ubl.xml"), totals: { gross: 2606, prepaid: 1000 } };
  assert.equal(invoiceSummary(noPayable), "Invoice BH-2025-0117 of 15.01.2025 · due 29.01.2025 · 26,06 €");

  const reverse = { ...invoice("xrechnung-ubl.xml"), vat: [{ category: "AE", rate: "0", base: 2190, amount: 0 }] };
  assert.match(expenseFromInvoice(emptyData(), reverse).warnings[0], /§ 13b Abs\. 5/);

  assert.match(expenseFromInvoice(emptyData(), { ...invoice("xrechnung-ubl.xml"), type: "389" }).warnings[0], /self-billed invoice.*income, not an expense/);
  const own = emptyData();
  own.business.name = "Beispiel Hosting GmbH";
  assert.match(expenseFromInvoice(own, invoice("xrechnung-ubl.xml")).warnings[0], /your own business/);
});

test("the readable view of a ZUGFeRD invoice", () => {
  const v = invoiceView(invoice("zugferd-en16931.pdf"));
  assert.equal(v.title, "Invoice 2025-10442");
  assert.equal(v.source, "EN 16931 · CII syntax · inside a ZUGFeRD / Factur-X PDF");
  assert.deepEqual(v.parties[0].lines.slice(0, 5), ["Bürobedarf Beispiel GmbH", "Papierweg 5", "12345 Musterstadt", "DE", "USt-IdNr. DE999999998"]);
  assert.deepEqual(v.facts, [
    ["Invoice date", "20.11.2025"],
    ["Due", "04.12.2025"],
    ["Delivered", "18.11.2025"],
  ]);
  assert.deepEqual(v.lines[0], { position: "1", name: "Druckerpapier A4, 500 Blatt", description: "", quantity: "5 pieces", price: "4,99 €", vat: "19 %", amount: "24,95 €" });
  assert.deepEqual(
    v.totals.map((row) => [row.label, row.amount, Boolean(row.strong)]),
    [
      ["Lines", "49,85 €", false],
      ["Charge: Versand", "4,90 €", false],
      ["Net", "54,75 €", false],
      ["VAT 19 % of 29,85 €", "5,67 €", false],
      ["VAT 7 % of 24,90 €", "1,74 €", false],
      ["Total", "62,16 €", true],
    ],
  );
  assert.deepEqual(v.payment.slice(0, 2), [
    ["Pay by", "SEPA credit transfer"],
    ["IBAN", "DE09 1234 5678 0001 2345 67"],
  ]);
});

test("the readable view of an invoice without VAT", () => {
  const v = invoiceView(invoice("xrechnung-cii.xml"));
  assert.equal(v.source, "XRechnung 3.0 · CII syntax · XML file");
  assert.ok(v.parties[0].lines.includes("Steuernummer 12/345/67890"));
  assert.equal(v.lines[0].quantity, "6 h");
  assert.equal(v.lines[0].price, "45,00 €");
  assert.deepEqual(v.totals[1], { label: "Exempt from VAT of 270,00 €", amount: "0,00 €", detail: "Kleinunternehmer gemäß § 19 UStG" });
  assert.deepEqual(v.notes, ["Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."]);

  const credit = invoiceView(invoice("xrechnung-ubl-credit-note.xml"));
  assert.equal(credit.credit, true);
  assert.equal(credit.title, "Credit note BH-G-2025-0004");
  assert.deepEqual(credit.facts.find(([label]) => label === "Corrects invoice"), ["Corrects invoice", "BH-2025-0117"]);
  assert.equal(credit.lines[0].quantity, "15 days");
});

test("prepaid amounts and a price per base quantity", () => {
  const v = invoiceView({
    ...invoice("xrechnung-ubl.xml"),
    lines: [{ id: "1", name: "Papier", quantity: "2000", unit: "H87", price: "9.50", priceBase: "1000", net: 1900 }],
    totals: { lines: 1900, net: 1900, vat: 361, gross: 2261, prepaid: 1000, payable: 1261 },
  });
  assert.equal(v.lines[0].price, "9,50 € per 1.000 pieces");
  assert.deepEqual(
    v.totals.slice(-3).map((row) => [row.label, row.amount, Boolean(row.strong)]),
    [
      ["Total", "22,61 €", false],
      ["Paid already", "−10,00 €", false],
      ["To pay", "12,61 €", true],
    ],
  );
});
