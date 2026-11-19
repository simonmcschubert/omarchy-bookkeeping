// Bookkeeping: the Invoices view (invoices and customers), and the invoice
// parts of the Overview and the entry form. The page (app.mjs) passes its
// helpers in `ui`: { state, h, card, change, render, toast, todayIso }.
// The rules live in invoices.mjs; the PDF is made by the server.

import { amountText, categoryById, dateText, euro, newId, nextNumber, parseAmount, parseDate } from "./books.mjs";
import { invoiceHtml } from "./invoice-html.mjs";
import {
  UNITS,
  cancelProblems,
  cancellationOf,
  customerById,
  customerInUse,
  customerProblems,
  deleteDraft,
  dueDate,
  incomeByCustomer,
  invoiceFileName,
  invoiceProblems,
  invoiceTotals,
  invoicesOfYear,
  issueInvoice,
  issuing,
  keepProblems,
  markPaid,
  markUnpaid,
  newInvoice,
  openInvoices,
  parseQuantity,
  paymentOf,
  quantityInput,
} from "./invoices.mjs";
import { invoiceXml } from "./invoice-xml.mjs";

/** The view's own state, kept on the page's state. */
function local(ui) {
  ui.state.invoices ??= {
    editing: null, // the draft in the form: a copy
    problems: [],
    report: null, // the check's result when an invoice did not pass
    open: null, // the issued invoice whose details are shown
    busy: false, // a PDF is being made
    customer: null, // the customer in the form: a copy, with `isNew`
    customerProblems: [],
    tools: null, // {ready, missing} from the server
    payDate: "",
  };
  return ui.state.invoices;
}

/** Whether an invoice or customer form is open, or a PDF is being made,
 *  also when another view is on show: an update's reload waits for it
 *  (update.mjs). */
export function editingInvoice(state) {
  const s = state.invoices;
  return Boolean(s && (s.editing || s.customer || s.busy));
}

async function loadTools(ui) {
  const s = local(ui);
  if (s.tools) return;
  s.tools = { ready: true, missing: [], loading: true };
  try {
    const response = await fetch("/api/invoices/tools");
    s.tools = await response.json();
  } catch {
    s.tools = { ready: false, missing: ["the server"] };
  }
  ui.render();
}

export function drawInvoices(ui, tab) {
  const { h } = ui;
  loadTools(ui);
  const tabs = h(
    "nav",
    { class: "tabs" },
    [
      ["invoices", "Invoices"],
      ["customers", "Customers"],
    ].map(([id, label]) => h("a", { href: id === "invoices" ? "#invoices" : `#invoices/${id}`, class: id === tab ? "active" : null, text: label })),
  );
  return [tabs, tab === "customers" ? drawCustomers(ui) : drawInvoiceList(ui)];
}

// ---- the list

function statusOf(ui, invoice) {
  const today = ui.todayIso();
  if (invoice.status === "draft") return { text: "Draft", class: "muted" };
  if (invoice.kind === "cancellation") return { text: `Cancels No. ${invoice.original?.number}`, class: "muted" };
  if (invoice.status === "cancelled") {
    const by = ui.state.data.invoices.find((i) => i.id === invoice.cancelledBy);
    return { text: `Cancelled${by ? ` by No. ${by.number}` : ""}`, class: "muted" };
  }
  if (invoice.status === "paid") {
    const entry = paymentOf(ui.state.data, invoice);
    return { text: `Paid${entry ? ` ${dateText(entry.date)}` : ""}`, class: "good-text" };
  }
  const due = dueDate(invoice);
  const late = Math.round((Date.parse(today) - Date.parse(due)) / 86400000);
  if (late > 0) return { text: `Overdue ${late} day${late === 1 ? "" : "s"}`, class: "bad-text" };
  return { text: `Sent, due ${dateText(due)}`, class: null };
}

function drawInvoiceList(ui) {
  const { h, card, state } = ui;
  const s = local(ui);
  const invoices = invoicesOfYear(state.data, state.year);
  const editingId = s.editing && !s.editing.isNew ? s.editing.id : null;
  const toolbar = h(
    "div",
    { class: "toolbar" },
    h("span", { class: "muted", text: `Next number: ${nextNumber(state.data)}` }),
    h("span", { class: "spacer" }),
    h("button", { class: "primary", disabled: Boolean(s.editing), onclick: () => startInvoice(ui) }, "+ Invoice"),
  );
  const rows = invoices.flatMap((invoice) => {
    if (invoice.id === editingId) return [h("tr", { class: "editing" }, h("td", { colspan: 6 }, editor(ui)))];
    const status = statusOf(ui, invoice);
    const customer = invoice.buyer?.name ?? customerById(state.data, invoice.customer)?.name ?? "";
    const open = s.open === invoice.id;
    const row = h(
      "tr",
      { class: `entry clickable ${open ? "open" : ""}`, onclick: () => (invoice.status === "draft" ? editInvoice(ui, invoice) : toggleOpen(ui, invoice.id)) },
      h("td", { class: "muted nowrap", text: invoice.number ? `#${invoice.number}` : "–" }),
      h("td", { class: "nowrap", text: dateText(invoice.date) }),
      h("td", {}, customer || h("span", { class: "risk-text", text: "No customer" }), h("span", { class: "sub", text: invoice.items?.[0]?.text?.split("\n")[0] ?? "" })),
      h("td", { class: "num", text: euro(invoiceTotals(invoice).gross) }),
      h("td", { class: status.class, text: status.text }),
      h("td", { class: "nowrap" }, invoice.pdf ? h("a", { href: `/api/receipts/${invoice.pdf.file}`, target: "_blank", rel: "noopener", title: invoice.pdf.name, onclick: (e) => e.stopPropagation(), text: "PDF" }) : h("span", { class: "muted", text: "–" })),
    );
    return open ? [row, h("tr", { class: "details" }, h("td", { colspan: 6 }, details(ui, invoice)))] : [row];
  });
  const table = invoices.length
    ? h(
        "table",
        { class: "entries invoices" },
        h("thead", {}, h("tr", {}, h("th", { text: "No." }), h("th", { text: "Date" }), h("th", { text: "Customer" }), h("th", { class: "num", text: "Amount" }), h("th", { text: "Status" }), h("th", { text: "PDF" }))),
        h("tbody", {}, rows),
      )
    : h("p", { class: "muted", text: `No invoices in ${state.year}.` });
  return [toolsNotice(ui), card(null, toolbar, s.editing?.isNew ? editor(ui) : null, table)];
}

function toolsNotice(ui) {
  const tools = local(ui).tools;
  if (!tools || tools.ready || tools.loading) return null;
  return ui.h("p", { class: "notice", text: `Making invoice PDFs needs ${tools.missing.join(", ")}. Run setup to install them (see the README). Drafts work without them.` });
}

function toggleOpen(ui, id) {
  const s = local(ui);
  s.open = s.open === id ? null : id;
  s.problems = [];
  s.report = null;
  s.payDate = dateText(ui.todayIso());
  ui.render();
}

// ---- the draft form

function startInvoice(ui) {
  const s = local(ui);
  const today = ui.todayIso();
  s.editing = { ...newInvoice(ui.state.data, today), isNew: true };
  s.problems = [];
  s.report = null;
  ui.render();
}

function editInvoice(ui, invoice) {
  const s = local(ui);
  if (s.busy) return; // keeping the PDF closes the form
  s.editing = structuredClone(invoice);
  s.problems = [];
  s.report = null;
  ui.render();
}

/** The draft as typed, with numbers read: what is saved and checked. */
function readDraft(e) {
  const { isNew, ...draft } = e;
  return {
    ...draft,
    date: parseDate(e.date) ?? e.date,
    service: { from: parseDate(e.service.from) ?? e.service.from, to: e.service.to ? (parseDate(e.service.to) ?? e.service.to) : "" },
    terms: Number.isInteger(Number(e.terms)) && String(e.terms).trim() !== "" ? Number(e.terms) : e.terms,
    items: e.items.map((item) => ({
      text: String(item.text ?? "").trim(),
      quantity: typeof item.quantity === "number" ? item.quantity : (parseQuantity(item.quantity) ?? item.quantity),
      unit: item.unit,
      price: typeof item.price === "number" ? item.price : (parseAmount(item.price) ?? item.price),
    })),
    note: String(e.note ?? "").trim(),
  };
}

function editor(ui) {
  const { h, state } = ui;
  const s = local(ui);
  const e = s.editing;
  const data = state.data;
  let previewTimer = null;
  const preview = h("iframe", { class: "invoice-preview", title: "Preview of the invoice", sandbox: "allow-same-origin" });
  preview.addEventListener("load", () => {
    const doc = preview.contentDocument;
    if (doc?.documentElement) preview.style.height = `${doc.documentElement.scrollHeight}px`;
  });
  const total = h("strong", {});
  const lineAmounts = [];
  const update = () => {
    const draft = readDraft(e);
    const ok = (item) => typeof item.quantity === "number" && typeof item.price === "number";
    draft.items.forEach((item, i) => (lineAmounts[i].textContent = ok(item) ? euro(invoiceTotals({ items: [item] }).gross) : "–"));
    total.textContent = draft.items.every(ok) ? euro(invoiceTotals(draft).gross) : "–";
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => (preview.srcdoc = previewHtml(ui, draft)), 250);
  };
  const set = (apply) => (event) => {
    apply(event.target.value);
    update();
  };
  const customers = [...(data.customers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const incomeCategories = data.categories.filter((c) => c.kind === "income").sort((a, b) => a.account - b.account);
  const customerForm = s.customer?.forInvoice ? customerEditor(ui) : null;
  const items = h(
    "table",
    { class: "compact lines" },
    h("thead", {}, h("tr", {}, h("th", { text: "What" }), h("th", { class: "num", text: "Quantity" }), h("th", { text: "Unit" }), h("th", { class: "num", text: "Price (€)" }), h("th", { class: "num", text: "Amount" }), h("th"))),
    h(
      "tbody",
      {},
      e.items.map((item, i) => {
        lineAmounts[i] = h("span", {});
        return h(
          "tr",
          {},
          h("td", { class: "line-text" }, h("textarea", { rows: 1 + (String(item.text).match(/\n/g)?.length ?? 0), "aria-label": `Line ${i + 1}: what`, placeholder: "Workshop, 2 days", value: item.text, oninput: set((v) => (item.text = v)) })),
          h("td", { class: "num" }, h("input", { class: "qty", inputmode: "decimal", "aria-label": `Line ${i + 1}: quantity`, value: typeof item.quantity === "number" ? quantityInput(item.quantity) : item.quantity, oninput: set((v) => (item.quantity = v)) })),
          h("td", {}, h("select", { "aria-label": `Line ${i + 1}: unit`, onchange: set((v) => (item.unit = v)) }, UNITS.map((u) => h("option", { value: u.code, selected: u.code === item.unit, text: u.label })))),
          h("td", { class: "num" }, h("input", { class: "price", inputmode: "decimal", "aria-label": `Line ${i + 1}: price`, placeholder: "120,00", value: typeof item.price === "number" ? amountText(item.price) : item.price, oninput: set((v) => (item.price = v)) })),
          h("td", { class: "num" }, lineAmounts[i]),
          h("td", {}, e.items.length > 1 ? h("button", { type: "button", class: "link danger", onclick: () => (e.items.splice(i, 1), ui.render()) }, "Remove") : null),
        );
      }),
    ),
  );
  const report = s.report ? validationBlock(ui, s.report) : null;
  const form = h(
    "form",
    {
      class: "editor",
      onsubmit: (event) => {
        event.preventDefault();
        issue(ui);
      },
      onkeydown: (event) => event.key === "Escape" && event.target.tagName !== "TEXTAREA" && cancelEdit(ui),
    },
    h("div", { class: "editor-head" }, h("h3", { text: e.isNew ? "New invoice" : "Edit draft" })),
    h(
      "div",
      { class: "form-grid" },
      h(
        "label",
        { class: "wide" },
        "Customer",
        h(
          "span",
          { class: "with-button" },
          h(
            "select",
            { name: "customer", onchange: (event) => ((e.customer = event.target.value || null), update()) },
            h("option", { value: "", selected: !e.customer, text: customers.length ? "Choose…" : "No customers yet" }),
            customers.map((c) => h("option", { value: c.id, selected: c.id === e.customer, text: c.name })),
          ),
          h("button", { type: "button", onclick: () => startCustomer(ui, true) }, "New customer"),
        ),
      ),
      h("label", {}, "Invoice date", h("input", { name: "date", value: dateText(parseDate(e.date) ?? "") || e.date, placeholder: "TT.MM.JJJJ", oninput: set((v) => (e.date = v)) })),
      h("label", {}, "Pay within (days)", h("input", { name: "terms", inputmode: "numeric", value: e.terms, oninput: set((v) => (e.terms = v)) })),
      h("label", {}, "Service date", h("input", { name: "from", value: dateText(parseDate(e.service.from) ?? "") || e.service.from, placeholder: "TT.MM.JJJJ", oninput: set((v) => (e.service.from = v)) })),
      h("label", {}, "Service until (for a period)", h("input", { name: "to", value: dateText(parseDate(e.service.to) ?? "") || e.service.to, placeholder: "optional", oninput: set((v) => (e.service.to = v)) })),
      h(
        "label",
        { class: "wide" },
        "Counts as income on",
        h(
          "select",
          { name: "category", onchange: set((v) => (e.category = v)) },
          incomeCategories.map((c) => h("option", { value: c.id, selected: c.id === e.category, text: `${c.account} · ${c.name}` })),
        ),
      ),
    ),
    customerForm,
    items,
    h("div", { class: "lines-foot" }, h("button", { type: "button", onclick: () => (e.items.push({ text: "", quantity: 1, unit: "H87", price: "" }), ui.render()) }, "+ Line"), h("span", { class: "spacer" }), h("span", { class: "muted", text: "Total" }), total),
    h("label", {}, "Note on the invoice (optional)", h("textarea", { name: "note", rows: 2, value: e.note, placeholder: "Vielen Dank für den Auftrag!", oninput: set((v) => (e.note = v)) })),
    s.problems.length ? h("ul", { class: "problems" }, s.problems.map((p) => h("li", { text: p }))) : null,
    report,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", type: "submit", disabled: s.busy || !local(ui).tools?.ready }, s.busy ? "Making the PDF and checking it…" : "Issue invoice…"),
      h("button", { type: "button", disabled: s.busy, onclick: () => saveDraft(ui) }, "Save draft"),
      h("button", { type: "button", disabled: s.busy, onclick: () => cancelEdit(ui) }, "Cancel"),
      e.isNew ? null : h("button", { type: "button", class: "danger push", disabled: s.busy, onclick: () => removeDraft(ui, e.id) }, "Delete draft"),
    ),
    h("p", { class: "muted small", text: "Issuing gives it the next number, makes the PDF (a ZUGFeRD e-invoice) and checks it. After that it can't change: it is paid, or cancelled by a cancellation invoice." }),
    h("div", { class: "preview-head" }, h("h3", { text: "Preview" }), h("span", { class: "muted small", text: "As the PDF will look, with the next number." })),
    preview,
  );
  // Fill in the amounts and the preview once the form is on the page.
  queueMicrotask(update);
  return form;
}

/** The draft as it would be issued now, for the preview. */
function previewHtml(ui, draft) {
  const data = ui.state.data;
  const shown = issuing(data, { ...draft, items: draft.items.map((i) => ({ ...i, quantity: typeof i.quantity === "number" ? i.quantity : 0, price: typeof i.price === "number" ? i.price : 0 })) }, nextNumber(data));
  if (!parseDate(shown.date)) shown.date = ui.todayIso();
  if (!parseDate(shown.service.from)) shown.service = { from: shown.date, to: "" };
  if (shown.service.to && !parseDate(shown.service.to)) shown.service.to = "";
  shown.terms = Number.isInteger(shown.terms) ? shown.terms : 0;
  return invoiceHtml(shown, { draft: true });
}

function cancelEdit(ui) {
  const s = local(ui);
  if (s.busy) return; // its PDF is being made: keeping it closes the form
  s.editing = null;
  s.customer = null;
  s.problems = [];
  s.report = null;
  ui.render();
}

function saveDraft(ui) {
  const s = local(ui);
  const draft = { ...readDraft(s.editing), status: "draft" };
  if (!parseDate(draft.date)) {
    s.problems = ["Enter the invoice date, such as 15.01.2025."];
    ui.render();
    return;
  }
  s.editing = null;
  s.problems = [];
  ui.state.year = Number(draft.date.slice(0, 4));
  ui.change((data) => {
    data.invoices ??= [];
    const at = data.invoices.findIndex((i) => i.id === draft.id);
    if (at >= 0) data.invoices[at] = draft;
    else data.invoices.push(draft);
  });
  ui.toast("Draft saved");
}

function removeDraft(ui, id) {
  if (!confirm("Delete this draft?")) return;
  local(ui).editing = null;
  ui.change((data) => deleteDraft(data, id));
  ui.toast("Draft deleted");
}

/** Asks the server for the PDF of an invoice being issued; returns the
 *  server's answer as {ok, body}. */
async function makePdf(issued) {
  const response = await fetch("/api/invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html: invoiceHtml(issued), xml: invoiceXml(issued), title: `${issued.kind === "cancellation" ? "Stornorechnung" : "Rechnung"} ${issued.number}` }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = { error: response.statusText };
  }
  return { ok: response.ok, status: response.status, body };
}

/** What is kept of the check: enough to show it again. */
function keptValidation(ui, report) {
  return {
    valid: report.valid,
    pdfa: report.pdfa,
    profile: report.profile,
    validator: report.validator,
    checked: ui.todayIso(),
    messages: report.messages.map(({ level, text }) => ({ level, text })),
  };
}

/** Issues an invoice or a cancellation: the number, the PDF, the check,
 *  and only when it passed, keeps it. Returns the issued invoice or null. */
async function issueWithPdf(ui, issued, onProblem, onKept) {
  const s = local(ui);
  s.busy = true; // until it is saved or not kept: the form stays as it is
  ui.render();
  try {
    let result;
    try {
      // Counted as sending, its answer too: an update's restart waits for
      // it (update.mjs), and the save below follows with no wait between.
      result = await ui.sent(makePdf(issued));
    } catch (error) {
      result = { ok: false, status: 0, body: { error: error.message } };
    }
    if (result.status === 422) {
      onProblem(["The e-invoice did not pass the check, so it was not kept. What the validator found:"], result.body.validation);
      return null;
    }
    if (!result.ok) {
      onProblem([`No PDF: ${result.body.error ?? "the server did not answer"}`], null);
      return null;
    }
    const problems = keepProblems(ui.state.data, issued);
    if (problems.length) {
      onProblem(problems, null);
      return null;
    }
    const pdf = { file: result.body.file, name: invoiceFileName(issued) };
    const validation = keptValidation(ui, result.body.validation);
    await ui.change((data) => {
      issueInvoice(data, issued, { pdf, validation, today: ui.todayIso() });
    });
    // A save that met a change from another window shows that version
    // instead: this one is issued only if its own PDF is in it.
    const kept = (ui.state.data.invoices ?? []).find((i) => i.id === issued.id);
    if (kept?.pdf?.file !== pdf.file) {
      const elsewhere = kept && kept.status !== "draft" ? kept : null;
      onProblem([elsewhere ? `Not issued here: another window issued it meanwhile, as No. ${elsewhere.number}.` : "Not issued: the data changed in another window meanwhile. Issue it again."], null, elsewhere);
      return null;
    }
    onKept();
    return issued;
  } finally {
    s.busy = false;
    ui.render();
  }
}

async function issue(ui) {
  const s = local(ui);
  const draft = readDraft(s.editing);
  s.report = null;
  s.problems = invoiceProblems(ui.state.data, draft);
  if (s.problems.length) {
    ui.render();
    return;
  }
  const number = nextNumber(ui.state.data);
  const issued = issuing(ui.state.data, draft, number);
  const total = euro(invoiceTotals(issued).gross);
  if (!confirm(`Issue invoice No. ${number} to ${issued.buyer.name} for ${total}, dated ${dateText(issued.date)}?\n\nAfter that it can't be changed, only cancelled.`)) {
    ui.render();
    return;
  }
  const done = await issueWithPdf(
    ui,
    issued,
    (problems, report, elsewhere) => {
      if (elsewhere) {
        // Issued in another window: show that one instead of the form.
        s.editing = null;
        s.open = elsewhere.id;
        ui.state.year = Number(elsewhere.date.slice(0, 4));
      } else if (!s.editing.isNew && !ui.state.data.invoices?.some((i) => i.id === s.editing.id)) {
        s.editing.isNew = true; // its draft was deleted in another window
      }
      s.problems = problems;
      s.report = report;
      ui.render();
    },
    () => {
      s.editing = null;
      s.open = issued.id;
      s.payDate = dateText(ui.todayIso());
      ui.state.year = Number(issued.date.slice(0, 4));
    },
  );
  if (!done) return;
  ui.toast(`Invoice ${done.number} issued: the PDF passed the check`);
}

// ---- an issued invoice

function validationBlock(ui, v) {
  const { h } = ui;
  const errors = v.messages.filter((m) => m.level === "error");
  const warnings = v.messages.filter((m) => m.level !== "error");
  const what = `ZUGFeRD ${v.profile === "urn:cen.eu:en16931:2017" ? "EN 16931" : (v.profile ?? "?")}, PDF/A-${v.pdfa ?? "?"}`;
  return h(
    "div",
    { class: `validation ${v.valid ? "valid" : "invalid"}` },
    h("strong", { class: v.valid ? "good-text" : "bad-text", text: v.valid ? `Valid e-invoice: ${what}` : `Not valid: ${what}` }),
    h("span", { class: "muted small", text: ` · checked by ${v.validator}${v.checked ? ` on ${dateText(v.checked)}` : ""}` }),
    errors.length || warnings.length
      ? h(
          "ul",
          { class: "messages" },
          [...errors, ...warnings].map((m) => h("li", { class: m.level === "error" ? "bad-text" : "risk-text" }, `${m.level === "error" ? "Error" : "Warning"}: ${m.text}`)),
        )
      : null,
  );
}

function details(ui, invoice) {
  const { h, state } = ui;
  const s = local(ui);
  const data = state.data;
  const entry = paymentOf(data, invoice);
  const parts = [];
  const facts = [
    ["Issued", dateText(invoice.sent ?? invoice.date)],
    invoice.kind === "invoice" ? ["Due", dateText(dueDate(invoice))] : ["Cancels", `No. ${invoice.original?.number} of ${dateText(invoice.original?.date)}`],
    ["Customer", invoice.buyer?.name ?? ""],
    invoice.kind === "invoice" ? ["Counts on", categoryById(data, invoice.category)?.name ?? "–"] : null,
  ].filter(Boolean);
  parts.push(h("dl", { class: "paths" }, facts.flatMap(([k, v]) => [h("dt", { class: "muted", text: k }), h("dd", { text: v })])));
  if (invoice.pdf) parts.push(h("p", {}, "PDF: ", h("a", { href: `/api/receipts/${invoice.pdf.file}`, target: "_blank", rel: "noopener", text: invoice.pdf.name })));
  if (invoice.validation) parts.push(validationBlock(ui, invoice.validation));
  if (invoice.status === "sent" && invoice.kind === "invoice") {
    parts.push(
      h(
        "form",
        {
          class: "inline-form",
          onsubmit: (event) => {
            event.preventDefault();
            if (!s.busy) pay(ui, invoice, s.payDate);
          },
        },
        h("label", { class: "inline" }, "Paid on", h("input", { name: "paid", value: s.payDate, placeholder: "TT.MM.JJJJ", "aria-label": "Day the money came", oninput: (e) => (s.payDate = e.target.value) })),
        h("button", { class: "primary", type: "submit", disabled: s.busy }, "Mark paid"),
        h("span", { class: "spacer" }),
        h("button", { type: "button", class: "danger", disabled: s.busy, onclick: () => cancelInvoice(ui, invoice) }, s.busy ? "Making the cancellation…" : "Cancel invoice…"),
      ),
      h("p", { class: "muted small", text: "Marking it paid adds the income on that day, with this PDF as its receipt." }),
    );
  }
  if (invoice.status === "paid") {
    parts.push(
      h(
        "div",
        { class: "inline-form" },
        h("span", { text: entry ? `Paid on ${dateText(entry.date)}: income No. ${entry.number ?? "–"} of ${euro(entry.amount)} in Entries.` : "Paid." }),
        h("button", { type: "button", onclick: () => unpay(ui, invoice) }, "Mark unpaid"),
      ),
    );
  }
  if (invoice.status === "cancelled") {
    const by = data.invoices.find((i) => i.id === invoice.cancelledBy);
    if (by) parts.push(h("p", { class: "muted", text: `Cancelled by cancellation invoice No. ${by.number} of ${dateText(by.date)}.` }));
  }
  if (s.problems.length && !s.editing) parts.push(h("ul", { class: "problems" }, s.problems.map((p) => h("li", { text: p }))));
  if (s.report && !s.editing) parts.push(validationBlock(ui, s.report));
  return h("div", { class: "invoice-details" }, parts);
}

/** Applies a rule that returns its problems: tried on a copy first, so
 *  when it refuses, nothing changes and nothing is saved. */
function apply(ui, rule) {
  const problems = rule(structuredClone(ui.state.data));
  local(ui).problems = problems;
  if (problems.length) ui.render();
  else ui.change((data) => void rule(data));
  return !problems.length;
}

function pay(ui, invoice, date) {
  if (apply(ui, (data) => markPaid(data, invoice.id, date))) {
    ui.toast(`Invoice ${invoice.number} paid: added to the income of ${parseDate(date).slice(0, 4)}`);
  }
}

function unpay(ui, invoice) {
  if (!confirm(`Mark invoice ${invoice.number} unpaid? Its income entry is removed.`)) return;
  if (apply(ui, (data) => markUnpaid(data, invoice.id))) ui.toast(`Invoice ${invoice.number} is open again`);
}

async function cancelInvoice(ui, invoice) {
  const s = local(ui);
  const problems = cancelProblems(ui.state.data, invoice);
  if (problems.length) {
    s.problems = problems;
    ui.render();
    return;
  }
  const number = nextNumber(ui.state.data);
  if (!confirm(`Cancel invoice ${invoice.number}?\n\nA cancellation invoice (Stornorechnung) No. ${number} is made over the same amount, checked and kept, and invoice ${invoice.number} counts as cancelled.`)) return;
  s.problems = [];
  s.report = null;
  const draft = cancellationOf(ui.state.data, invoice, ui.todayIso());
  const issued = { ...issuing(ui.state.data, draft, number), vat: invoice.vat };
  const done = await issueWithPdf(
    ui,
    issued,
    (p, report) => {
      s.problems = p;
      s.report = report;
      ui.render();
    },
    () => {
      s.open = issued.id;
      ui.state.year = Number(issued.date.slice(0, 4));
    },
  );
  if (!done) return;
  ui.toast(`Invoice ${invoice.number} cancelled by No. ${done.number}`);
}

// ---- customers

function startCustomer(ui, forInvoice = false) {
  const s = local(ui);
  s.customer = { isNew: true, forInvoice, id: newId(), name: "", address: "", country: "DE", email: "", vatId: "" };
  s.customerProblems = [];
  ui.render();
  document.querySelector(".customer-form input[name=name]")?.focus();
}

function customerEditor(ui) {
  const { h } = ui;
  const s = local(ui);
  const c = s.customer;
  const set = (key) => (event) => (c[key] = event.target.value);
  return h(
    "div",
    {
      class: "editor customer-form",
      onkeydown: (event) => {
        if (event.key === "Enter" && event.target.tagName === "INPUT") {
          event.preventDefault();
          saveCustomer(ui);
        }
      },
    },
    h("h3", { text: c.isNew ? "New customer" : "Edit customer" }),
    h(
      "div",
      { class: "form-grid" },
      h("label", { class: "wide" }, "Name", h("input", { name: "name", value: c.name, placeholder: "Beispiel GmbH", oninput: set("name") })),
      h("label", {}, "Country", h("input", { name: "country", value: c.country, maxlength: 2, placeholder: "DE", oninput: (e) => (c.country = e.target.value.toUpperCase()) })),
      h("label", { class: "wide" }, "Address", h("textarea", { name: "address", rows: 3, value: c.address, placeholder: "Straße 1\n10115 Berlin", oninput: set("address") })),
      h("label", {}, "Email (optional)", h("input", { name: "email", value: c.email, oninput: set("email") })),
      h("label", {}, "USt-IdNr. (optional)", h("input", { name: "vatId", value: c.vatId, placeholder: "DE123456789", oninput: set("vatId") })),
    ),
    s.customerProblems.length ? h("ul", { class: "problems" }, s.customerProblems.map((p) => h("li", { text: p }))) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "primary", onclick: () => saveCustomer(ui) }, "Save customer"),
      h("button", { type: "button", onclick: () => ((s.customer = null), ui.render()) }, "Cancel"),
      c.isNew || customerInUse(ui.state.data, c.id) ? null : h("button", { type: "button", class: "danger push", onclick: () => removeCustomer(ui, c.id) }, "Delete"),
    ),
  );
}

function saveCustomer(ui) {
  const s = local(ui);
  const { isNew, forInvoice, ...fields } = s.customer;
  const customer = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]));
  s.customerProblems = customerProblems(customer);
  if (s.customerProblems.length) {
    ui.render();
    return;
  }
  s.customer = null;
  if (forInvoice && s.editing) s.editing.customer = customer.id;
  ui.change((data) => {
    data.customers ??= [];
    const at = data.customers.findIndex((x) => x.id === customer.id);
    if (at >= 0) data.customers[at] = customer;
    else data.customers.push(customer);
  });
  ui.toast("Customer saved");
}

function removeCustomer(ui, id) {
  if (!confirm("Delete this customer?")) return;
  local(ui).customer = null;
  ui.change((data) => {
    data.customers = (data.customers ?? []).filter((c) => c.id !== id);
  });
}

function drawCustomers(ui) {
  const { h, card, state } = ui;
  const s = local(ui);
  const customers = [...(state.data.customers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map();
  for (const invoice of state.data.invoices ?? []) if (invoice.kind === "invoice" && invoice.status !== "draft") counts.set(invoice.customer, (counts.get(invoice.customer) ?? 0) + 1);
  const editingId = s.customer && !s.customer.isNew && !s.customer.forInvoice ? s.customer.id : null;
  const rows = customers.map((c) =>
    c.id === editingId
      ? h("tr", { class: "editing" }, h("td", { colspan: 5 }, customerEditor(ui)))
      : h(
          "tr",
          { class: "clickable", onclick: () => ((s.customer = structuredClone(c)), (s.customerProblems = []), ui.render()) },
          h("td", {}, c.name, h("span", { class: "sub", text: c.address.split("\n").join(", ") + (c.country !== "DE" ? `, ${c.country}` : "") })),
          h("td", { text: c.email || "" }),
          h("td", { text: c.vatId || "" }),
          h("td", { class: "num", text: counts.get(c.id) ?? 0 }),
        ),
  );
  return [
    card(
      null,
      h("div", { class: "toolbar" }, h("span", { class: "muted", text: "Name and address go on the invoice; income by customer shows on the Overview." }), h("span", { class: "spacer" }), h("button", { class: "primary", disabled: Boolean(s.customer), onclick: () => startCustomer(ui) }, "+ Customer")),
      s.customer?.isNew && !s.customer.forInvoice ? customerEditor(ui) : null,
      customers.length
        ? h("table", { class: "entries" }, h("thead", {}, h("tr", {}, h("th", { text: "Customer" }), h("th", { text: "Email" }), h("th", { text: "USt-IdNr." }), h("th", { class: "num", text: "Invoices" }))), h("tbody", {}, rows))
        : h("p", { class: "muted", text: "No customers yet." }),
    ),
  ];
}

// ---- on the Overview and in the entry form

/** Sent invoices not paid yet, and which of them are overdue. */
export function openInvoicesCard(ui) {
  const { h, card } = ui;
  const open = openInvoices(ui.state.data, ui.todayIso());
  if (!open.rows.length) return card("Open invoices", h("p", { class: "muted", text: "None: every invoice sent is paid." }));
  const summary = `${euro(open.total)} in ${open.rows.length} invoice${open.rows.length === 1 ? "" : "s"}`;
  return card(
    null,
    h(
      "div",
      { class: "card-head" },
      h("h2", { text: "Open invoices" }),
      h("span", { class: "open-total", text: summary }),
      open.overdue.count ? h("span", { class: "bad-text", text: `${open.overdue.count} overdue: ${euro(open.overdue.total)}` }) : h("span", { class: "good-text", text: "none overdue" }),
    ),
    h(
      "table",
      { class: "compact" },
      h(
        "tbody",
        {},
        open.rows.map((r) =>
          h(
            "tr",
            { class: "clickable", title: "Open the invoice", onclick: () => showInvoice(ui, r.invoice) },
            h("td", { class: "muted nowrap", text: `#${r.invoice.number}` }),
            h("td", { text: r.invoice.buyer?.name ?? "" }),
            h("td", { class: `nowrap ${r.overdueDays ? "bad-text" : "muted"}`, text: r.overdueDays ? `due ${dateText(r.due)}, ${r.overdueDays} day${r.overdueDays === 1 ? "" : "s"} overdue` : `due ${dateText(r.due)}` }),
            h("td", { class: "num", text: euro(r.amount) }),
          ),
        ),
      ),
    ),
  );
}

/** Opens an invoice in the Invoices view. */
function showInvoice(ui, invoice) {
  const s = local(ui);
  s.open = invoice.id;
  s.problems = [];
  s.report = null;
  s.payDate = dateText(ui.todayIso());
  ui.state.year = Number(invoice.date.slice(0, 4));
  location.hash = "#invoices";
}

/** The year's income by customer, as bars. */
export function customerIncomeCard(ui) {
  const { h, card, state } = ui;
  const rows = incomeByCustomer(state.data, state.year);
  if (!rows.length) return card("Income by customer", h("p", { class: "muted", text: "Nothing this year." }));
  const max = Math.max(...rows.map((r) => Math.abs(r.amount)));
  return card(
    "Income by customer",
    h(
      "div",
      { class: "bars" },
      rows.map((row) =>
        h(
          "div",
          { class: "bar-row" },
          h("span", { class: row.id ? null : "muted", text: row.name }),
          h("span", { class: "num", text: euro(row.amount) }),
          h("div", { class: "meter" }, h("i", { style: { width: `${(Math.abs(row.amount) / max) * 100}%` } })),
        ),
      ),
    ),
  );
}

/** The customer field of the income form. */
export function customerField(ui, entry) {
  const { h } = ui;
  const customers = [...(ui.state.data.customers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return h(
    "label",
    {},
    "Customer",
    h(
      "select",
      { name: "customer", onchange: (e) => (entry.customer = e.target.value || undefined) },
      h("option", { value: "", selected: !entry.customer, text: customers.length ? "None" : "No customers yet" }),
      customers.map((c) => h("option", { value: c.id, selected: c.id === entry.customer, text: c.name })),
    ),
  );
}
