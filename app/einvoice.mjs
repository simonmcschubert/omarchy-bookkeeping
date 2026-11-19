// Received e-invoices on the page: the new expense one fills in, and the
// readable view of it. The server reads the file (einvoice_reader.py) and
// sends what it found; no DOM here, so node --test checks all of it.
// Amounts are whole cents; quantities and unit prices are decimal strings.

import { categoryById, dateText, euro, normalizeText, sortEntries } from "./books.mjs";

// Files a receipt may be: the server takes these (RECEIPT_TYPES).
export const RECEIPT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.xml";

// Names for the codes below come from the code lists named; 380, 381, 384
// and 389 are checked against the XRechnung 3.0.2 specification, the rest
// not yet one by one. An unknown code is shown as it is.

// Invoice type codes (BT-3, UNTDID 1001) that XRechnung and ZUGFeRD use.
const TYPES = {
  380: "Invoice",
  381: "Credit note",
  384: "Corrected invoice",
  389: "Self-billed invoice",
  326: "Partial invoice",
  386: "Prepayment invoice",
  261: "Self-billed credit note",
  387: "Hire invoice",
  575: "Insurer's invoice",
  751: "Invoice information for accounting",
  875: "Partial construction invoice",
  876: "Partial final construction invoice",
  877: "Final construction invoice",
};

// VAT category codes (BT-118, UNTDID 5305).
const VAT_CATEGORIES = {
  S: "VAT",
  Z: "Zero rate",
  E: "Exempt from VAT",
  AE: "Reverse charge",
  K: "Intra-community supply",
  G: "Export outside the EU",
  O: "Not subject to VAT",
  L: "IGIC (Canary Islands)",
  M: "IPSI (Ceuta and Melilla)",
};

// Payment means codes (BT-81, UNTDID 4461), the ones invoices use most.
const PAYMENT_MEANS = {
  1: "Not defined",
  10: "Cash",
  20: "Cheque",
  30: "Credit transfer",
  31: "Debit transfer",
  42: "Payment to bank account",
  48: "Bank card",
  49: "Direct debit",
  54: "Credit card",
  55: "Debit card",
  57: "Standing agreement",
  58: "SEPA credit transfer",
  59: "SEPA direct debit",
  68: "Online payment service",
  97: "Clearing between partners",
  ZZZ: "Mutually defined",
};

// Units of quantity (BT-130, UN/ECE Recommendation 20): singular, plural.
const UNITS = {
  C62: ["", ""],
  H87: ["piece", "pieces"],
  EA: ["piece", "pieces"],
  XPP: ["piece", "pieces"],
  SET: ["set", "sets"],
  LS: ["lump sum", "lump sums"],
  HUR: ["h", "h"],
  MIN: ["min", "min"],
  DAY: ["day", "days"],
  WEE: ["week", "weeks"],
  MON: ["month", "months"],
  ANN: ["year", "years"],
  KGM: ["kg", "kg"],
  GRM: ["g", "g"],
  TNE: ["t", "t"],
  MTR: ["m", "m"],
  CMT: ["cm", "cm"],
  KMT: ["km", "km"],
  MTK: ["m²", "m²"],
  MTQ: ["m³", "m³"],
  LTR: ["l", "l"],
  KWH: ["kWh", "kWh"],
  P1: ["%", "%"],
};

/** A receipt the readable view can show: one read as an e-invoice, or an
 *  XML file from before receipts remembered that (einvoice unset). */
export function hasInvoiceView(receipt) {
  if (!receipt) return false;
  return receipt.einvoice ?? /\.xml$/.test(receipt.file ?? "");
}

/** "1.234,5678" from "1234.5678"; at least minFraction decimals. */
export function decimalText(value, minFraction = 0) {
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(String(value ?? ""));
  if (!match) return String(value ?? "");
  const [, sign, whole, fraction = ""] = match;
  const digits = fraction.replace(/0+$/, "").padEnd(minFraction, "0");
  const grouped = (whole.replace(/^0+(?=\d)/, "") || "0").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign ? "−" : ""}${grouped}${digits ? `,${digits}` : ""}`;
}

/** "1.234,56 €", or "1.234,56 USD" in another currency. */
export function money(cents, currency = "EUR") {
  const text = euro(cents);
  return currency && currency !== "EUR" ? text.replace(/ €$/, ` ${currency}`) : text;
}

/** "DE09 1234 5678 0001 2345 67" */
export function ibanText(iban) {
  return String(iban ?? "")
    .replace(/\s+/g, "")
    .replace(/(.{4})(?=.)/g, "$1 ");
}

export function typeName(code) {
  return TYPES[code] ?? `Document type ${code}`;
}

function quantityText(quantity, unit) {
  if (quantity == null) return "";
  const [one, many] = UNITS[unit] ?? [unit ?? "", unit ?? ""];
  const name = Number(quantity) === 1 ? one : many;
  return `${decimalText(quantity)}${name ? ` ${name}` : ""}`;
}

/** Paid in full already, by card, say: nothing left to pay, and a
 *  prepaid amount. */
function paidInFull(totals) {
  return totals.payable === 0 && Boolean(totals.prepaid);
}

/** What the invoice is about, in one line: number, date, due, amount. */
export function invoiceSummary(invoice) {
  const t = invoice.totals ?? {};
  const paid = paidInFull(t);
  const amount = paid ? t.gross : (t.payable ?? t.gross);
  return [
    `${typeName(invoice.type)} ${invoice.number ?? "without number"}${invoice.issueDate ? ` of ${dateText(invoice.issueDate)}` : ""}`,
    invoice.dueDate && !paid ? `due ${dateText(invoice.dueDate)}` : null,
    amount != null ? `${money(amount, invoice.currency)}${paid ? ", paid" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The latest expense whose text starts with the supplier's name. */
function lastFrom(data, supplier) {
  const key = normalizeText(supplier);
  if (!key) return null;
  return sortEntries(data.entries.filter((e) => e.kind === "expense" && normalizeText(e.text).startsWith(key)))[0] ?? null;
}

/**
 * The new expense an e-invoice fills in: text, amount and invoice number,
 * and the category of the last expense from the same supplier. The date
 * stays empty: an expense counts on the day it is paid (Zuflussprinzip),
 * which the invoice can't know. notes and warnings say what to check.
 */
export function expenseFromInvoice(data, invoice, receiptFile) {
  const notes = [];
  const warnings = [...(invoice.warnings ?? [])];
  const supplier = invoice.seller?.name ?? "";
  const t = invoice.totals ?? {};

  // What is still to pay; an invoice paid in full shows 0 there, so then
  // its total is what was paid. Any other 0 leaves the amount to type.
  const paid = paidInFull(t);
  const due = paid ? t.gross : (t.payable ?? t.gross ?? null);
  let amount = null;
  if (due && invoice.currency === "EUR") amount = invoice.credit ? -due : due;
  else if (due && invoice.currency) {
    warnings.push(`The invoice is in ${invoice.currency} (${money(due, invoice.currency)}): enter the euros that left your account.`);
  }
  if (paid) {
    warnings.push(`The invoice says it is paid in full already (${money(t.prepaid, invoice.currency)}): book it on the day it was paid, unless that payment is booked already.`);
  } else if (t.prepaid) notes.push(`${money(t.prepaid, invoice.currency)} of it is paid already: the amount is what is left to pay.`);
  if (invoice.credit) notes.push("A credit note: it goes in as a refund, a negative expense.");
  if ((invoice.vat ?? []).some((v) => v.category === "AE")) {
    warnings.push("Reverse charge: you, the buyer, owe the VAT on this to the tax office, as a Kleinunternehmer too (§ 13b Abs. 5, § 18 Abs. 4a UStG).");
  }
  const business = normalizeText(data.business?.name);
  if (invoice.type === "389" || invoice.type === "261" || (business && normalizeText(supplier) === business)) {
    warnings.push(`You may be the seller here (${invoice.type === "389" || invoice.type === "261" ? "a self-billed invoice, issued by the buyer" : "the supplier is your own business"}): then this is income, not an expense.`);
  }

  const lines = invoice.lines ?? [];
  const text = lines.length === 1 && lines[0].name && supplier ? `${supplier}: ${lines[0].name}` : supplier || lines[0]?.name || "";

  let category = null;
  const previous = lastFrom(data, supplier);
  if (previous && categoryById(data, previous.category)?.kind === "expense") {
    category = previous.category;
    notes.push(`Category as for the last expense from ${supplier}, on ${dateText(previous.date)}.`);
  }

  const sameFile = receiptFile && data.entries.find((e) => e.receipt?.file === receiptFile);
  if (sameFile) {
    warnings.push(`This file is the receipt of "${sameFile.text}" on ${dateText(sameFile.date)} already.`);
  } else if (invoice.number) {
    const key = normalizeText(supplier);
    const sameNumber = data.entries.find((e) => e.kind === "expense" && e.ref === invoice.number && (!key || normalizeText(e.text).includes(key)));
    if (sameNumber) warnings.push(`An expense with invoice no. ${invoice.number} is there already: "${sameNumber.text}" on ${dateText(sameNumber.date)}.`);
  }

  const dates = [
    invoice.issueDate ? { label: "Invoice date", date: invoice.issueDate } : null,
    invoice.dueDate && invoice.dueDate !== invoice.issueDate ? { label: "Due date", date: invoice.dueDate } : null,
  ].filter(Boolean);
  return { text, amount, ref: invoice.number ?? "", category, notes, warnings, dates };
}

function partyLines(party = {}) {
  return [
    party.name,
    party.tradingName && party.tradingName !== party.name ? party.tradingName : null,
    ...(party.address ?? []),
    party.vatId ? `USt-IdNr. ${party.vatId}` : null,
    party.taxNumber ? `Steuernummer ${party.taxNumber}` : null,
    party.contact,
    party.phone,
    party.email,
  ].filter(Boolean);
}

function rateText(rate, category) {
  if (rate != null) return `${decimalText(rate)} %`;
  return category ?? "";
}

/**
 * The e-invoice in readable form, as text for the page to lay out: who
 * sent it to whom, its dates, lines, VAT and totals, and how to pay.
 */
export function invoiceView(invoice) {
  const currency = invoice.currency;
  const m = (cents) => money(cents, currency);
  const unitPrice = (price) => `${decimalText(price, 2)} ${currency && currency !== "EUR" ? currency : "€"}`;
  const t = invoice.totals ?? {};
  const period = invoice.periodStart || invoice.periodEnd ? `${dateText(invoice.periodStart) || "…"} – ${dateText(invoice.periodEnd) || "…"}` : null;

  const facts = [
    ["Invoice date", dateText(invoice.issueDate)],
    ["Due", dateText(invoice.dueDate)],
    ["Delivered", dateText(invoice.deliveryDate)],
    ["Period", period],
    ["Corrects invoice", invoice.precedingInvoice],
    ["Buyer reference", invoice.buyerReference],
    ["Order", invoice.orderReference],
    ["Currency", currency && currency !== "EUR" ? currency : null],
  ].filter(([, value]) => value);

  const lines = (invoice.lines ?? []).map((line) => ({
    position: line.id ?? "",
    name: line.name ?? "",
    description: line.description ?? "",
    quantity: quantityText(line.quantity, line.unit),
    price:
      line.price != null
        ? `${unitPrice(line.price)}${line.priceBase && Number(line.priceBase) !== 1 ? ` per ${quantityText(line.priceBase, line.unit)}` : ""}`
        : "",
    vat: rateText(line.vatRate, line.vatCategory),
    amount: line.net != null ? m(line.net) : "",
  }));

  const totals = [];
  const add = (label, cents, extra = {}) => cents != null && totals.push({ label, amount: m(cents), ...extra });
  const hasExtras = (invoice.allowances ?? []).length > 0;
  if (hasExtras || (t.lines != null && t.lines !== t.net)) add("Lines", t.lines);
  for (const a of invoice.allowances ?? []) {
    add(`${a.charge ? "Charge" : "Allowance"}${a.reason ? `: ${a.reason}` : ""}`, a.charge ? a.amount : a.amount == null ? null : -a.amount);
  }
  add("Net", t.net);
  for (const v of invoice.vat ?? []) {
    const name = VAT_CATEGORIES[v.category] ?? `VAT category ${v.category ?? "?"}`;
    const label = `${name}${v.rate != null && !(v.category === "E" && Number(v.rate) === 0) ? ` ${decimalText(v.rate)} %` : ""}${v.base != null ? ` of ${m(v.base)}` : ""}`;
    add(label, v.amount ?? 0, v.reason ? { detail: v.reason } : {});
  }
  if (!(invoice.vat ?? []).length) add("VAT", t.vat);
  add("Total", t.gross, { strong: !t.prepaid && !t.rounding });
  if (t.prepaid) add("Paid already", -t.prepaid);
  if (t.rounding) add("Rounding", t.rounding);
  if (t.prepaid || t.rounding || t.gross == null) add("To pay", t.payable, { strong: true });

  const p = invoice.payment ?? {};
  const payment = [
    ["Pay by", p.means ? (PAYMENT_MEANS[p.means] ?? `Code ${p.means}`) : null],
    ["IBAN", p.iban ? ibanText(p.iban) : null],
    ["BIC", p.bic],
    ["Account holder", p.accountName],
    ["Reference", p.reference],
    ["Terms", p.terms],
  ].filter(([, value]) => value);

  const source = [invoice.format, invoice.syntax ? `${invoice.syntax} syntax` : null, invoice.container === "pdf" ? "inside a ZUGFeRD / Factur-X PDF" : "XML file"]
    .filter(Boolean)
    .join(" · ");

  return {
    title: `${typeName(invoice.type)} ${invoice.number ?? ""}`.trim(),
    source,
    credit: Boolean(invoice.credit),
    parties: [
      { label: invoice.credit ? "From (supplier, giving the credit)" : "From (supplier)", lines: partyLines(invoice.seller) },
      { label: "To (buyer)", lines: partyLines(invoice.buyer) },
    ],
    facts,
    lines,
    totals,
    payment,
    notes: invoice.notes ?? [],
    warnings: invoice.warnings ?? [],
  };
}
