import assert from "node:assert/strict";
import test from "node:test";
import { emptyData, nextNumber, years } from "../app/books.mjs";
import {
  KLEINUNTERNEHMER,
  REGULAR,
  cancelProblems,
  cancellationOf,
  customerProblems,
  dueDate,
  forgetPayment,
  incomeByCustomer,
  invoiceFileName,
  invoiceProblems,
  invoiceTotals,
  issueInvoice,
  issuing,
  keepProblems,
  lineTotal,
  markPaid,
  markUnpaid,
  numberProblems,
  openInvoices,
  parseQuantity,
  quantityInput,
  quantityText,
  splitAddress,
  vatStatus,
} from "../app/invoices.mjs";
import { sampleData, sampleDraft } from "./fixtures/invoices.mjs";

/** Issues a draft as the page does once the server kept its PDF. */
function issue(data, draft, today = draft.date) {
  const issued = issuing(data, draft, nextNumber(data));
  return issueInvoice(data, issued, { pdf: { file: `${"a".repeat(64)}.pdf`, name: invoiceFileName(issued) }, validation: { valid: true }, today });
}

test("quantities and line amounts", () => {
  assert.equal(parseQuantity("1,5"), 1.5);
  assert.equal(parseQuantity("2"), 2);
  assert.equal(parseQuantity("0.25"), 0.25);
  assert.equal(parseQuantity("-1"), -1);
  assert.equal(parseQuantity(""), null);
  assert.equal(parseQuantity("abc"), null);
  // The form shows a quantity so that it reads back the same.
  for (const q of [1000, 1000.5, 0.25, -2]) assert.equal(parseQuantity(quantityInput(q)), q);
  assert.equal(quantityText(1000), "1.000");
  assert.equal(quantityText(-1.5), "−1,5");
  assert.equal(lineTotal({ quantity: 1.5, price: 8000 }), 12000);
  assert.equal(lineTotal({ quantity: 1.5, price: 12345 }), 18518); // 185,175 € rounds up
  assert.equal(lineTotal({ quantity: 0.333, price: 100 }), 33);
  assert.equal(lineTotal({ quantity: -1, price: 5000 }), -5000);
});

test("a Kleinunternehmer invoice: exempt, no VAT", () => {
  const totals = invoiceTotals(sampleDraft(sampleData()));
  assert.equal(totals.net, 102000);
  assert.equal(totals.tax, 0);
  assert.equal(totals.gross, 102000);
  assert.deepEqual(totals.breakdown, [{ category: "E", rate: 0, basis: 102000, tax: 0 }]);
});

test("with VAT, the breakdown has the rate and the tax (not offered yet)", () => {
  const totals = invoiceTotals({ vat: REGULAR, items: [{ quantity: 1, price: 10000 }, { quantity: 1, price: 999, vatRate: 7 }] });
  assert.deepEqual(totals.breakdown, [
    { category: "S", rate: 19, basis: 10000, tax: 1900 },
    { category: "S", rate: 7, basis: 999, tax: 70 },
  ]);
  assert.equal(totals.gross, 12969);
});

test("the VAT status is per year, Kleinunternehmer unless set", () => {
  const data = sampleData();
  assert.equal(vatStatus(data, 2026), KLEINUNTERNEHMER);
  data.vatStatus = { 2027: REGULAR };
  assert.equal(vatStatus(data, 2027), REGULAR);
  assert.equal(vatStatus(data, 2026), KLEINUNTERNEHMER);
  // The year of the service decides, and issuing a 2027 service is not built.
  const problems = invoiceProblems(data, sampleDraft(data, { date: "2027-01-05", service: { from: "2027-01-04", to: "" } }));
  assert.match(problems.join(" "), /not built yet/);
  assert.deepEqual(invoiceProblems(data, sampleDraft(data, { date: "2027-01-05", service: { from: "2026-12-20", to: "" } })), []);
  // A period: its end decides, the day the service was completed.
  assert.match(invoiceProblems(data, sampleDraft(data, { date: "2027-01-05", service: { from: "2026-12-15", to: "2027-01-04" } })).join(" "), /2027 charges VAT/);
});

test("addresses split for the e-invoice", () => {
  assert.deepEqual(splitAddress("Musterstraße 12\n10115 Berlin"), { lines: ["Musterstraße 12"], postcode: "10115", city: "Berlin" });
  assert.deepEqual(splitAddress("z. Hd. Max\nRingstraße 1\nA-1010 Wien"), { lines: ["z. Hd. Max", "Ringstraße 1"], postcode: "1010", city: "Wien" });
  assert.deepEqual(splitAddress("PO Box 7\nSomewhere"), { lines: ["PO Box 7", "Somewhere"], postcode: "", city: "" });
});

test("what keeps a draft from being issued", () => {
  const data = sampleData();
  assert.deepEqual(invoiceProblems(data, sampleDraft(data)), []);
  data.business.iban = "";
  data.business.taxNumber = "";
  assert.match(invoiceProblems(data, sampleDraft(data))[0], /Steuernummer, IBAN in Settings/);
  const fresh = sampleData();
  const problems = invoiceProblems(fresh, sampleDraft(fresh, { customer: null, items: [{ text: "", quantity: 1, unit: "H87", price: -100 }], terms: 400, service: { from: "2026-11-10", to: "2026-11-01" } }));
  assert.deepEqual(problems, [
    "Choose a customer.",
    "The service period ends before it starts.",
    "Line 1: say what it is.",
    "Line 1: the price can't be negative. For a discount, enter a negative quantity.",
    "Enter the days to pay, 0 to 365.",
  ]);
  assert.deepEqual(customerProblems({ name: "x", address: "", country: "Deutschland", email: "nope" }).length, 3);
});

test("issuing takes the next running number and copies seller and buyer", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  assert.equal(nextNumber(data), 42);
  const invoice = issue(data, data.invoices[0]);
  assert.equal(invoice.number, 42);
  assert.equal(invoice.status, "sent");
  assert.equal(invoice.vat, KLEINUNTERNEHMER);
  assert.equal(invoice.buyer.name, "Beispielverein e. V.");
  assert.equal(invoice.seller.taxNumber, "12/345/67890");
  assert.equal(invoice.pdf.name, "Rechnung-42.pdf");
  // The next income or invoice gets 43, though 42 is not paid yet.
  assert.equal(nextNumber(data), 43);
  // A later change of the customer leaves the issued invoice as it was.
  data.customers[0].name = "Umbenannt e. V.";
  assert.equal(data.invoices[0].buyer.name, "Beispielverein e. V.");
  assert.ok(years(data, new Date("2026-11-19")).includes(2026));
});

test("paid: the income entry on the day of payment, with the PDF as receipt", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  const invoice = issue(data, data.invoices[0]);
  assert.deepEqual(markPaid(data, invoice.id, "05.01.2027"), []);
  const entry = data.entries.at(-1);
  assert.equal(entry.date, "2027-01-05"); // Zuflussprinzip: the year the money came
  assert.equal(entry.amount, 102000);
  assert.equal(entry.number, 42);
  assert.equal(entry.category, "in-3");
  assert.equal(entry.customer, "c1");
  assert.equal(entry.invoice, invoice.id);
  assert.deepEqual(entry.receipt, invoice.pdf);
  assert.equal(invoice.status, "paid");
  assert.match(markPaid(data, invoice.id, "06.01.2027")[0], /Only a sent invoice/);
  assert.deepEqual(markUnpaid(data, invoice.id), []);
  assert.equal(invoice.status, "sent");
  assert.equal(data.entries.length, 1);
});

test("a closed year takes no payment, and deleting the entry reopens the invoice", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  const invoice = issue(data, data.invoices[0]);
  data.closed = [2026];
  assert.match(markPaid(data, invoice.id, "20.11.2026")[0], /closed/);
  data.closed = [];
  markPaid(data, invoice.id, "20.11.2026");
  const entryId = invoice.paid.entry;
  data.closed = [2026];
  assert.match(markUnpaid(data, invoice.id)[0], /closed/);
  data.closed = [];
  data.entries = data.entries.filter((e) => e.id !== entryId);
  forgetPayment(data, entryId);
  assert.equal(invoice.status, "sent");
  assert.equal(invoice.paid, undefined);
});

test("cancelling: a cancellation invoice with its own number, counted negative", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  const invoice = issue(data, data.invoices[0]);
  assert.deepEqual(cancelProblems(data, invoice), []);
  const storno = issue(data, cancellationOf(data, invoice, "2026-11-20"));
  assert.equal(storno.number, 43);
  assert.equal(storno.kind, "cancellation");
  assert.deepEqual(storno.original, { number: 42, date: "2026-11-19" });
  assert.equal(invoiceTotals(storno).gross, -102000);
  assert.equal(storno.pdf.name, "Stornorechnung-43.pdf");
  assert.equal(invoice.status, "cancelled");
  assert.equal(invoice.cancelledBy, storno.id);
  assert.match(cancelProblems(data, storno)[0], /can't be cancelled/);
  assert.match(cancelProblems(data, invoice)[0], /Only an issued invoice/);
  // Neither counts as open.
  assert.equal(openInvoices(data, "2026-12-31").rows.length, 0);
});

test("a cancellation is not kept when its invoice was paid while its PDF was made", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  const invoice = issue(data, data.invoices[0]);
  const storno = issuing(data, cancellationOf(data, invoice, "2026-11-20"), nextNumber(data));
  assert.deepEqual(keepProblems(data, storno), []);
  // Paid meanwhile: the payment takes no number, so only this check stops it.
  assert.deepEqual(markPaid(data, invoice.id, "20.11.2026"), []);
  assert.match(keepProblems(data, storno)[0], /Refunds of paid invoices are not built yet/);
  // Its number taken meanwhile.
  const next = issuing(data, sampleDraft(data, { id: "inv2" }), nextNumber(data));
  issue(data, sampleDraft(data, { id: "inv3" }));
  assert.match(keepProblems(data, next)[0], /was taken meanwhile/);
});

test("paid before the invoice date: a prepayment counts on the day it came", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  const invoice = issue(data, data.invoices[0]);
  assert.deepEqual(markPaid(data, invoice.id, "01.11.2026"), []);
  assert.equal(data.entries.at(-1).date, "2026-11-01");
});

test("an issued invoice owns its number: no other income takes it", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  const invoice = issue(data, data.invoices[0]);
  const income = { id: "manual", kind: "income", date: "2026-11-20", amount: 5000, text: "x", category: "in-3", number: invoice.number, ref: "", receipt: null };
  assert.match(numberProblems(data, income)[0], /No. 42 is the number of invoice 42, which is open: mark it paid in Invoices instead. The next free number is 43/);
  assert.deepEqual(numberProblems(data, { ...income, number: 43 }), []);
  // Its own payment keeps the number, also when edited later.
  markPaid(data, invoice.id, "20.11.2026");
  assert.deepEqual(numberProblems(data, data.entries.at(-1)), []);
});

test("a paid invoice is not cancelled here", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data)];
  const invoice = issue(data, data.invoices[0]);
  markPaid(data, invoice.id, "20.11.2026");
  assert.match(cancelProblems(data, invoice)[0], /Refunds of paid invoices are not built yet/);
});

test("open invoices: sent and unpaid, and which are overdue", () => {
  const data = sampleData();
  data.invoices = [sampleDraft(data, { id: "a", date: "2026-10-01", terms: 14 }), sampleDraft(data, { id: "b", customer: "c2", date: "2026-11-15", terms: 14 }), sampleDraft(data, { id: "draft" })];
  issue(data, data.invoices[0]);
  issue(data, data.invoices[1]);
  assert.equal(dueDate(data.invoices[0]), "2026-10-15");
  const open = openInvoices(data, "2026-11-19");
  assert.deepEqual(
    open.rows.map((r) => [r.invoice.id, r.overdueDays]),
    [
      ["a", 35],
      ["b", 0],
    ],
  );
  assert.equal(open.total, 204000);
  assert.deepEqual(open.overdue, { count: 1, total: 102000 });
  markPaid(data, "a", "19.11.2026");
  assert.equal(openInvoices(data, "2026-11-19").overdue.count, 0);
});

test("income by customer, entries without one last", () => {
  const data = sampleData();
  data.entries.push(
    { id: "e1", kind: "income", date: "2026-02-01", amount: 30000, text: "x", category: "in-3", customer: "c1" },
    { id: "e2", kind: "income", date: "2026-03-01", amount: 50000, text: "x", category: "in-3", customer: "c2" },
    { id: "e3", kind: "income", date: "2026-04-01", amount: 90000, text: "x", category: "in-3" },
    { id: "e4", kind: "income", date: "2026-05-01", amount: 10000, text: "x", category: "in-3", customer: "c1" },
    { id: "e5", kind: "expense", date: "2026-05-01", amount: 7000, text: "x", category: "ex-1", customer: "c1" },
  );
  assert.deepEqual(
    incomeByCustomer(data, 2026).map((r) => [r.name, r.amount]),
    [
      ["Muster Design GmbH", 50000],
      ["Beispielverein e. V.", 40000],
      ["No customer", 90000],
    ],
  );
});

test("a file without customers or invoices still works", () => {
  const data = emptyData(); // no invoices, customers or vatStatus fields
  assert.equal(nextNumber(data), 1);
  assert.deepEqual(openInvoices(data, "2026-11-19"), { rows: [], total: 0, overdue: { count: 0, total: 0 } });
  assert.deepEqual(incomeByCustomer(data, 2026), []);
  assert.equal(vatStatus(data, 2026), KLEINUNTERNEHMER);
});
