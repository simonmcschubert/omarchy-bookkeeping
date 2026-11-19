// Bookkeeping: customers and invoices. No DOM here, so node --test checks
// it. Amounts are whole cents; dates are ISO strings. See CONTEXT.md.
//
// An invoice is a draft until it is issued: then it gets the next running
// number, its PDF (a ZUGFeRD e-invoice, made by the server and checked
// before it is kept) and copies of the seller's and the buyer's details as
// they were that day. From then on it can't change: it is paid, or it is
// cancelled by a cancellation invoice (Stornorechnung) with a number of its
// own. Marking it paid adds the income entry on the day the money came
// (Zuflussprinzip), with the invoice PDF as its receipt.

import { categoryById, entryProblems, newId, nextNumber, parseDate } from "./books.mjs";

// The note a Kleinunternehmer's invoice carries instead of the VAT, in the
// wording Simon has always used. Since 2025, § 34a Satz 1 Nr. 5 UStDV asks
// for "einem Hinweis darauf, dass für die Lieferung oder sonstige Leistung
// die Steuerbefreiung für Kleinunternehmer gilt (§ 19 des Gesetzes)", and
// UStAE 14.7a Abs. 1 takes any wording "wenn sie die Steuerfreiheit für
// Kleinunternehmer eindeutig bezeichnet". Not confirmed: the BMF names no
// wording, and this sentence names § 19 but says "no VAT charged" rather
// than "exempt".
export const KLEINUNTERNEHMER_NOTE = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";

export const KLEINUNTERNEHMER = "kleinunternehmer";
export const REGULAR = "regular"; // charges VAT (Regelbesteuerung): not built yet

// Units of quantity: UN/ECE Recommendation 20 codes, as EN 16931 wants
// them (BT-130), with the German words for the invoice.
export const UNITS = [
  { code: "H87", label: "piece", one: "Stück", many: "Stück" },
  { code: "HUR", label: "hour", one: "Std.", many: "Std." },
  { code: "DAY", label: "day", one: "Tag", many: "Tage" },
  { code: "LS", label: "flat rate", one: "pauschal", many: "pauschal" },
];

export const DEFAULT_TERMS = 14; // days to pay

/** The VAT status of a year: Kleinunternehmer unless Settings say it
 *  charges VAT. The year of the service decides, as it is the supply that
 *  is taxed or exempt (Leistungszeitpunkt), not the invoice: for a period,
 *  its end, as a service counts as done when completed (UStAE 13.1 Abs. 3). */
export function vatStatus(data, year) {
  return data.vatStatus?.[year] === REGULAR ? REGULAR : KLEINUNTERNEHMER;
}

// ---- customers

export function customerById(data, id) {
  return (data.customers ?? []).find((c) => c.id === id) ?? null;
}

export function customerProblems(customer) {
  const problems = [];
  if (!String(customer.name ?? "").trim()) problems.push("Enter the customer's name.");
  if (!String(customer.address ?? "").trim()) problems.push("Enter the customer's address: an invoice needs it (§ 14 Abs. 4 UStG).");
  if (!/^[A-Z]{2}$/.test(customer.country ?? "")) problems.push("Enter the country as a two-letter code, such as DE.");
  const email = String(customer.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push("That email address looks wrong.");
  return problems;
}

/** Whether a customer is on an invoice or an entry, so it can't go. */
export function customerInUse(data, id) {
  return (data.invoices ?? []).some((i) => i.customer === id) || data.entries.some((e) => e.customer === id);
}

/**
 * An address as typed ("Straße 1\n10115 Berlin") split for the e-invoice:
 * the street lines, and the postcode and city from the line that has them.
 * A line it can't read stays a street line.
 */
export function splitAddress(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/^(?:[A-Z]{1,2}[- ])?(\d{4,5})\s+(.+)$/);
    if (match) return { lines: lines.filter((_, j) => j !== i), postcode: match[1], city: match[2] };
  }
  return { lines, postcode: "", city: "" };
}

// ---- amounts

/** "1,5" or "1.5" as a number of up to three decimals; null if none. */
export function parseQuantity(text) {
  if (typeof text === "number") return Number.isFinite(text) ? Math.round(text * 1000) / 1000 : null;
  let s = String(text ?? "").trim();
  if (!s) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  return Math.round(Number(s) * 1000) / 1000;
}

const QUANTITY = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 3 });

/** "1,5", "1.000", "−2" */
export function quantityText(quantity) {
  return QUANTITY.format(quantity ?? 0).replace("-", "−");
}

/** "1000,5" for the form: no thousands dots, which parseQuantity would
 *  read as a decimal point. */
export function quantityInput(quantity) {
  return String(quantity ?? "").replace(".", ",");
}

function roundHalfAway(value) {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** A line's amount in cents: quantity × unit price, rounded to the cent. */
export function lineTotal(item) {
  const thousandths = Math.round((Number(item.quantity) || 0) * 1000);
  return roundHalfAway((thousandths * (Number(item.price) || 0)) / 1000);
}

/** The VAT of a line: category and rate. A Kleinunternehmer's supplies are
 *  tax-exempt (E, 0 %). With VAT, the standard rate unless the line says. */
export function lineVat(invoice, item) {
  if ((invoice.vat ?? KLEINUNTERNEHMER) === KLEINUNTERNEHMER) return { category: "E", rate: 0 };
  const rate = Number.isFinite(item.vatRate) ? item.vatRate : 19;
  return { category: rate === 0 ? "Z" : "S", rate };
}

/**
 * An invoice's amounts: each line, the VAT breakdown by category and rate
 * (EN 16931 BG-23), net, VAT and gross. A cancellation invoice counts its
 * lines negative: it takes the cancelled amounts back.
 */
export function invoiceTotals(invoice) {
  const sign = invoice.kind === "cancellation" ? -1 : 1;
  const lines = (invoice.items ?? []).map((item) => ({ ...item, amount: sign * lineTotal(item), vat: lineVat(invoice, item) }));
  const groups = new Map();
  for (const line of lines) {
    const key = `${line.vat.category}|${line.vat.rate}`;
    const group = groups.get(key) ?? { category: line.vat.category, rate: line.vat.rate, basis: 0, tax: 0 };
    group.basis += line.amount;
    groups.set(key, group);
  }
  const breakdown = [...groups.values()].map((g) => ({ ...g, tax: roundHalfAway((g.basis * g.rate) / 100) }));
  const net = lines.reduce((t, l) => t + l.amount, 0);
  const tax = breakdown.reduce((t, g) => t + g.tax, 0);
  return { lines, breakdown, net, tax, gross: net + tax };
}

// ---- dates

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The day the invoice is due: its date plus the payment terms. */
export function dueDate(invoice) {
  return addDays(invoice.date, Number(invoice.terms) || 0);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
}

/** The year whose VAT status applies: the service's, else the invoice's. */
export function serviceYear(invoice) {
  return Number((invoice.service?.to || invoice.service?.from || invoice.date || "0000").slice(0, 4));
}

// ---- drafts

export function newInvoice(data, today) {
  const category = categoryById(data, "in-3") ?? data.categories.find((c) => c.kind === "income");
  return {
    id: newId(),
    kind: "invoice",
    status: "draft",
    number: null,
    customer: null,
    date: today,
    service: { from: today, to: "" },
    items: [{ text: "", quantity: 1, unit: "H87", price: 0 }],
    terms: DEFAULT_TERMS,
    note: "",
    category: category?.id ?? null,
  };
}

/** The business details an invoice shows, as they are now. */
export function sellerOf(data) {
  const b = data.business ?? {};
  const text = (key) => String(b[key] ?? "").trim();
  return { name: text("name"), address: text("address"), country: "DE", taxNumber: text("taxNumber"), vatId: text("vatId"), iban: text("iban"), email: text("email") };
}

export function buyerOf(customer) {
  const text = (key) => String(customer?.[key] ?? "").trim();
  return { name: text("name"), address: text("address"), country: text("country") || "DE", email: text("email"), vatId: text("vatId") };
}

/** Problems that keep a draft from being issued; empty when fine. */
export function invoiceProblems(data, invoice) {
  const problems = [];
  const seller = sellerOf(data);
  const missing = [
    [seller.name, "name"],
    [seller.address, "address"],
    [seller.taxNumber || seller.vatId, "Steuernummer"],
    [seller.iban, "IBAN"],
  ]
    .filter(([value]) => !value)
    .map(([, label]) => label);
  if (missing.length) problems.push(`Add your ${missing.join(", ")} in Settings › Business.`);
  const customer = customerById(data, invoice.customer);
  if (!customer) problems.push("Choose a customer.");
  else if (customerProblems(customer).length) problems.push(`Complete the customer: ${customerProblems(customer).join(" ")}`);
  if (!parseDate(invoice.date)) problems.push("Enter the invoice date, such as 15.01.2025.");
  const from = parseDate(invoice.service?.from);
  const to = invoice.service?.to ? parseDate(invoice.service.to) : null;
  if (!from) problems.push("Enter the date of the service (Leistungsdatum).");
  if (invoice.service?.to && !to) problems.push("Enter the end of the service period as a date, or leave it empty.");
  if (from && to && to < from) problems.push("The service period ends before it starts.");
  const items = invoice.items ?? [];
  if (!items.length) problems.push("Add a line.");
  items.forEach((item, i) => {
    if (!String(item.text ?? "").trim()) problems.push(`Line ${i + 1}: say what it is.`);
    if (!Number.isFinite(item.quantity) || item.quantity === 0) problems.push(`Line ${i + 1}: enter a quantity.`);
    if (!Number.isInteger(item.price)) problems.push(`Line ${i + 1}: enter a price, such as 120,00.`);
    // EN 16931 rule BR-27: the unit price may not be negative.
    else if (item.price < 0) problems.push(`Line ${i + 1}: the price can't be negative. For a discount, enter a negative quantity.`);
    if (!UNITS.some((u) => u.code === item.unit)) problems.push(`Line ${i + 1}: choose a unit.`);
  });
  if (!problems.some((p) => p.startsWith("Line")) && items.length && invoiceTotals(invoice).gross <= 0) problems.push("The total must be more than 0 €.");
  if (!Number.isInteger(invoice.terms) || invoice.terms < 0 || invoice.terms > 365) problems.push("Enter the days to pay, 0 to 365.");
  const category = categoryById(data, invoice.category);
  if (!category || category.kind !== "income") problems.push("Choose the income category it counts on when paid.");
  if (from && vatStatus(data, serviceYear(invoice)) !== KLEINUNTERNEHMER) {
    problems.push(`${serviceYear(invoice)} charges VAT (Settings › Business): invoices with VAT are not built yet.`);
  }
  return problems;
}

/**
 * The draft as it is issued: with its number, the VAT status of its year
 * and copies of the seller and the buyer. Nothing is saved: the server
 * makes and checks the PDF first (issueInvoice keeps it after that).
 */
export function issuing(data, invoice, number) {
  return {
    ...structuredClone(invoice),
    number,
    vat: vatStatus(data, serviceYear(invoice)),
    seller: sellerOf(data),
    buyer: invoice.buyer ?? buyerOf(customerById(data, invoice.customer)),
  };
}

/** Keeps an issued invoice with its PDF and the check's result. */
export function issueInvoice(data, issued, { pdf, validation, today }) {
  data.invoices ??= [];
  const invoice = { ...issued, status: "sent", sent: today, pdf, validation };
  const at = data.invoices.findIndex((i) => i.id === invoice.id);
  if (at >= 0) data.invoices[at] = invoice;
  else data.invoices.push(invoice);
  if (invoice.kind === "cancellation") {
    const original = data.invoices.find((i) => i.id === invoice.cancels);
    if (original) {
      original.status = "cancelled";
      original.cancelledBy = invoice.id;
    }
  }
  return invoice;
}

/** Why an invoice whose PDF was just made can't be kept after all, as the
 *  data may change while the PDF is made: its number was taken, or the
 *  invoice a cancellation cancels was paid or cancelled meanwhile. */
export function keepProblems(data, issued) {
  if (nextNumber(data) !== issued.number) return [`Number ${issued.number} was taken meanwhile (another window?). Issue it again.`];
  if (issued.kind !== "cancellation") return [];
  const original = (data.invoices ?? []).find((i) => i.id === issued.cancels);
  return original ? cancelProblems(data, original) : ["The invoice it cancels is gone."];
}

/** The cancellation invoice (Stornorechnung) of an issued, unpaid
 *  invoice: same buyer and lines, counted negative, with a number of its
 *  own and the original's number and date for reference. */
export function cancellationOf(data, original, today) {
  return {
    id: newId(),
    kind: "cancellation",
    status: "draft",
    number: null,
    cancels: original.id,
    original: { number: original.number, date: original.date },
    customer: original.customer,
    date: today,
    service: { ...original.service },
    items: structuredClone(original.items),
    terms: 0,
    note: "",
    category: original.category,
    buyer: structuredClone(original.buyer),
  };
}

export function cancelProblems(data, invoice) {
  if (invoice.kind !== "invoice") return ["A cancellation invoice can't be cancelled."];
  if (invoice.status === "paid") return ["It is paid: mark it unpaid first. Refunds of paid invoices are not built yet."];
  if (invoice.status !== "sent") return ["Only an issued invoice that is not paid can be cancelled."];
  return [];
}

export function deleteDraft(data, id) {
  data.invoices = (data.invoices ?? []).filter((i) => !(i.id === id && i.status === "draft"));
}

// ---- payment

/** The income entry that paid an invoice, if any. */
export function paymentOf(data, invoice) {
  return invoice.paid?.entry ? (data.entries.find((e) => e.id === invoice.paid.entry) ?? null) : null;
}

/** The income entry an invoice becomes when paid on that day. */
export function paymentEntry(invoice, date) {
  const first = String(invoice.items?.[0]?.text ?? "").split("\n")[0];
  return {
    id: newId(),
    kind: "income",
    date,
    amount: invoiceTotals(invoice).gross,
    text: [invoice.buyer?.name, first].filter(Boolean).join(": "),
    category: invoice.category,
    number: invoice.number,
    ref: "",
    receipt: invoice.pdf ?? null,
    invoice: invoice.id,
    customer: invoice.customer ?? undefined,
  };
}

/** Marks a sent invoice paid on that day: adds its income entry. Returns
 *  the problems instead when it can't (such as a closed year). */
export function markPaid(data, id, date) {
  const invoice = (data.invoices ?? []).find((i) => i.id === id);
  if (!invoice || invoice.status !== "sent" || invoice.kind !== "invoice") return ["Only a sent invoice can be marked paid."];
  const day = parseDate(date);
  if (!day) return ["Enter the day the money came, such as 15.01.2025."];
  const entry = paymentEntry(invoice, day);
  if (entry.customer === undefined) delete entry.customer;
  const problems = entryProblems(data, entry);
  if (problems.length) return problems;
  data.entries.push(entry);
  invoice.status = "paid";
  invoice.paid = { entry: entry.id };
  return [];
}

/** Takes a payment back: removes its entry, the invoice is open again. */
export function markUnpaid(data, id) {
  const invoice = (data.invoices ?? []).find((i) => i.id === id);
  if (!invoice || invoice.status !== "paid") return ["It is not marked paid."];
  const entry = paymentOf(data, invoice);
  if (entry && (data.closed ?? []).includes(Number(entry.date.slice(0, 4)))) {
    return [`${entry.date.slice(0, 4)} is closed. Reopen it on the EÜR page first.`];
  }
  data.entries = data.entries.filter((e) => e.id !== entry?.id);
  invoice.status = "sent";
  delete invoice.paid;
  return [];
}

/** When an entry that paid an invoice is deleted, the invoice is open again. */
export function forgetPayment(data, entryId) {
  for (const invoice of data.invoices ?? []) {
    if (invoice.paid?.entry === entryId) {
      invoice.status = "sent";
      delete invoice.paid;
    }
  }
}

// ---- open invoices and analytics

/** Sent invoices not paid yet, oldest due first, and which are overdue. */
export function openInvoices(data, today) {
  const rows = (data.invoices ?? [])
    .filter((i) => i.kind === "invoice" && i.status === "sent")
    .map((invoice) => {
      const due = dueDate(invoice);
      return { invoice, due, amount: invoiceTotals(invoice).gross, overdueDays: Math.max(0, daysBetween(due, today)) };
    })
    .sort((a, b) => a.due.localeCompare(b.due) || a.invoice.number - b.invoice.number);
  const overdue = rows.filter((r) => r.overdueDays > 0);
  const sum = (list) => list.reduce((t, r) => t + r.amount, 0);
  return { rows, total: sum(rows), overdue: { count: overdue.length, total: sum(overdue) } };
}

/** Income of a year by customer, largest first; entries without one last. */
export function incomeByCustomer(data, year) {
  const totals = new Map();
  for (const entry of data.entries) {
    if (entry.kind !== "income" || !entry.date.startsWith(String(year))) continue;
    const key = entry.customer ?? "";
    totals.set(key, (totals.get(key) ?? 0) + entry.amount);
  }
  return [...totals]
    .map(([id, amount]) => ({ id, name: id ? (customerById(data, id)?.name ?? "Removed customer") : "No customer", amount }))
    .sort((a, b) => (a.id === "") - (b.id === "") || b.amount - a.amount);
}

/** "Rechnung-124.pdf", "Stornorechnung-125.pdf" */
export function invoiceFileName(invoice) {
  return `${invoice.kind === "cancellation" ? "Stornorechnung" : "Rechnung"}-${invoice.number}.pdf`;
}

/** A year's invoices: drafts first, then newest first. */
export function invoicesOfYear(data, year) {
  return (data.invoices ?? [])
    .filter((i) => i.date.startsWith(String(year)))
    .sort((a, b) => (b.status === "draft") - (a.status === "draft") || b.date.localeCompare(a.date) || (b.number ?? 0) - (a.number ?? 0));
}
