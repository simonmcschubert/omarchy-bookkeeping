// Bookkeeping: the page. Holds the data file in memory, draws the views and
// saves the whole file after each change (PUT /api/data with the revision
// it was read at, so two windows never overwrite each other unseen).

import {
  MONTHS,
  amountText,
  categoryById,
  categoryTotals,
  dateText,
  emptyData,
  entryProblems,
  euer,
  euro,
  groupById,
  homeOfficeRate,
  isClosed,
  isComputedGroup,
  lineFor,
  newId,
  nextNumber,
  parseAmount,
  parseDate,
  profitByYear,
  revenueLimit,
  sortEntries,
  normalizeText,
  unreadable,
  upgradeData,
  yearTotals,
  years,
} from "./books.mjs";
import { aveurCard, drawAssets, printAssets, startAssetFromEntry } from "./assets-view.mjs";
import { applyImport, planImport, readTable } from "./import.mjs";
import { backupState } from "./backup.mjs";
import { RECEIPT_ACCEPT, expenseFromInvoice, hasInvoiceView, invoiceSummary, invoiceView } from "./einvoice.mjs";
import { startUpdates } from "./update.mjs";

const VIEWS = [
  ["overview", "Overview"],
  ["entries", "Entries"],
  ["assets", "Assets"],
  ["euer", "EÜR"],
  ["settings", "Settings"],
];
const SETTINGS_TABS = [
  ["categories", "Categories"],
  ["import", "Import"],
  ["business", "Business"],
  ["backup", "Backup"],
  ["updates", "Updates"],
];

const state = {
  data: null,
  revision: null,
  paths: {},
  year: new Date().getFullYear(),
  filter: "all",
  search: "",
  editing: null, // the entry in the form: a copy, with `isNew` when new
  editorProblems: [],
  tables: [], // import: files read, before they are imported
  formYear: null, // Settings › Categories: the form whose line numbers are shown
  backup: null, // GET /api/backup: the last copy to another computer
  saving: Promise.resolve(),
};

// ---- DOM helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    // Through the CSSOM: the page's CSP blocks style attributes.
    else if (key === "style") Object.assign(el.style, value);
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked" || key === "selected" || key === "disabled") el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const SVG = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) el.setAttribute(key, value);
  for (const child of children.flat()) if (child != null) el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return el;
}

function card(title, ...children) {
  return h("section", { class: "card" }, title ? h("h2", { text: title }) : null, ...children);
}

function toast(message, kind = "") {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), kind === "bad" ? 8000 : 3000);
}

// ---- loading and saving

async function load() {
  const response = await fetch("/api/data");
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  const problem = unreadable(body.data);
  if (problem) throw new Error(problem);
  state.revision = body.revision;
  state.paths = { file: body.file, backups: body.backups, receipts: body.receipts };
  state.data = upgradeData(body.data ?? emptyData());
}

/** The backup's status. Drawn again only when it changed, such as after a
 *  copy made while the window was open. */
async function loadBackup() {
  try {
    const response = await fetch("/api/backup");
    const body = await response.json();
    if (JSON.stringify(body) === JSON.stringify(state.backup)) return false;
    state.backup = body;
    return true;
  } catch {
    return false;
  }
}

// Saves and receipt uploads on their way to the server: an update's restart
// waits for them (saving in update.mjs).
let sending = 0;
function sent(promise) {
  sending++;
  return promise.finally(() => sending--);
}

/** Applies a change to the data, draws it and saves the file. */
function change(update) {
  const draft = structuredClone(state.data);
  state.data = update(draft) ?? draft;
  render();
  state.saving = sent(state.saving.then(save));
  return state.saving;
}

async function save() {
  try {
    const response = await fetch("/api/data", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision: state.revision, data: state.data }),
    });
    const body = await response.json();
    if (response.status === 409) {
      // Saved by a newer version in another window: this page can't open it.
      // Reloaded, it gets that version's code, or says why it can't.
      if (unreadable(body.data)) {
        location.reload();
        return;
      }
      state.revision = body.revision;
      state.data = upgradeData(body.data ?? emptyData());
      toast("Changed in another window: showing that version. Make the last change again.", "bad");
      render();
      return;
    }
    if (!response.ok) throw new Error(body.error || response.statusText);
    state.revision = body.revision;
  } catch (error) {
    toast(`Not saved: ${error.message}`, "bad");
  }
}

/** Saves a receipt file. The server also reads it as an e-invoice: the
 *  reading says what it found (status invoice, plain or problem). */
async function uploadAndRead(file) {
  const types = { "text/xml": "application/xml", "": guessType(file.name) };
  const type = types[file.type] ?? file.type;
  const response = await sent(fetch("/api/receipts", { method: "POST", headers: { "Content-Type": type }, body: file }));
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || response.statusText);
  const reading = body.einvoice ?? { status: "plain" };
  const receipt = { file: body.file, name: file.name };
  // Remembered for the readable view: an XML file may be no e-invoice.
  if (reading.status === "invoice" || body.file.endsWith(".xml")) receipt.einvoice = reading.status === "invoice";
  return { receipt, reading };
}

/** Saves a receipt file: { file, name }, for a form that only keeps it. */
async function uploadReceipt(file) {
  return (await uploadAndRead(file)).receipt;
}

function guessType(name) {
  const ext = name.toLowerCase().split(".").pop();
  return { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", xml: "application/xml" }[ext] ?? "application/octet-stream";
}

// ---- routing

function route() {
  const [view = "overview", tab] = location.hash.slice(1).split("/");
  return { view: VIEWS.some(([id]) => id === view) ? view : "overview", tab: tab || "categories" };
}

window.addEventListener("hashchange", () => {
  state.editing = null;
  render();
  loadBackup().then((changed) => changed && render());
});

// ---- drawing

function render() {
  const { view, tab } = route();
  const nav = document.getElementById("nav");
  nav.replaceChildren(...VIEWS.map(([id, label]) => h("a", { href: `#${id}`, class: id === view ? "active" : null, text: label })));
  drawYearPicker(view);
  const main = document.getElementById("main");
  const scroll = window.scrollY;
  const views = { overview: drawOverview, entries: drawEntries, assets: () => drawAssets(ui()), euer: drawEuer, settings: () => drawSettings(tab) };
  main.replaceChildren(h("div", {}, views[view]()));
  window.scrollTo(0, scroll);
}

/** What the views in other modules get to draw and change with. */
function ui() {
  return { h, card, segmented, state, change, render, toast, uploadReceipt };
}

function drawYearPicker(view) {
  const el = document.getElementById("year");
  if (view === "settings") {
    el.replaceChildren();
    return;
  }
  const options = years(state.data).map((y) => h("option", { value: y, selected: y === state.year, text: y }));
  el.replaceChildren(
    h("label", { class: "inline" }, h("span", { class: "sr-only", text: "Year" }), h("select", { onchange: (e) => setYear(Number(e.target.value)) }, options)),
  );
}

function setYear(year) {
  state.year = year;
  state.editing = null;
  render();
}

// ---- Overview

function drawOverview() {
  const t = yearTotals(state.data, state.year);
  const limit = revenueLimit(state.year + 1);
  const share = t.revenue / limit;
  const yearly = [t.homeOffice ? `${euro(t.homeOffice)} home office` : null, t.assets.writeOff ? `${euro(t.assets.writeOff)} AfA, GWG` : null].filter(Boolean);
  const tiles = h(
    "div",
    { class: "tiles" },
    tile("Income", euro(t.income), t.assets.sales ? `incl. ${euro(t.assets.sales)} assets sold` : `${countOf("income")} entries`),
    tile("Expenses", euro(t.expenses), yearly.length ? `incl. ${yearly.join(", ")}` : `${countOf("expense")} entries`),
    tile("Profit", euro(t.profit), "income − expenses", t.profit < 0 ? "bad-text" : null),
    h(
      "div",
      { class: "tile" },
      h("span", { class: "tile-label", text: "Revenue limit" }),
      h("span", { class: "tile-value", text: `${Math.round(share * 100)} %` }),
      h("div", { class: `meter ${share > 0.9 ? "bad" : share > 0.75 ? "risk" : ""}` }, h("i", { style: { width: `${Math.min(share, 1) * 100}%` } })),
      h("span", { class: "tile-detail", text: `of ${euro(limit, { round: true })}: up to this, ${state.year + 1} stays without VAT (§ 19 UStG)` }),
    ),
  );
  const perYear = profitByYear(state.data);
  const backup = backupState(state.backup?.status ?? null, state.revision);
  return [
    backup.warning ? h("p", { class: "notice" }, `${backup.warning} `, h("a", { href: "#settings/backup", text: "Settings › Backup" })) : null,
    tiles,
    card("Profit per year", yearChart(perYear), h("p", { class: "muted small", text: "Click a year to see it." })),
    card(`${state.year} by month`, monthChart(t.months), yearlyNote(t)),
    h("div", { class: "columns" }, categoryCard("Income by category", "income"), categoryCard("Expenses by category", "expense")),
  ];
}

/** What counts for the whole year, not in a month. */
function yearlyNote(t) {
  const parts = [
    t.homeOffice ? `home office ${euro(t.homeOffice)}` : null,
    t.assets.writeOff ? `AfA and GWG ${euro(t.assets.writeOff)}` : null,
    t.assets.remaining ? `book value of assets gone ${euro(t.assets.remaining)}` : null,
    t.assets.sales ? `income from assets sold ${euro(t.assets.sales)}` : null,
  ].filter(Boolean);
  return parts.length ? h("p", { class: "muted small", text: `Plus for the whole year: ${parts.join(" · ")}` }) : null;
}

function countOf(kind) {
  return state.data.entries.filter((e) => e.kind === kind && e.date.startsWith(String(state.year))).length;
}

function tile(label, value, detail, valueClass) {
  return h(
    "div",
    { class: "tile" },
    h("span", { class: "tile-label", text: label }),
    h("span", { class: `tile-value ${valueClass ?? ""}`, text: value }),
    h("span", { class: "tile-detail", text: detail }),
  );
}

function categoryCard(title, kind) {
  const rows = categoryTotals(state.data, state.year, kind);
  if (!rows.length) return card(title, h("p", { class: "muted", text: "Nothing this year." }));
  const max = Math.max(...rows.map((r) => Math.abs(r.amount)));
  return card(
    title,
    h(
      "div",
      { class: "bars" },
      rows.map((row) =>
        h(
          "div",
          { class: "bar-row" },
          h("span", { text: row.name }),
          h("span", { class: "num", text: euro(row.amount) }),
          h("div", { class: "meter" }, h("i", { style: { width: `${(Math.abs(row.amount) / max) * 100}%` } })),
        ),
      ),
    ),
  );
}

function niceMax(value) {
  if (value <= 0) return 100;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= value) * power;
  return step;
}

function yearChart(rows) {
  const width = 1000;
  const height = 220;
  const left = 64;
  const bottom = 24;
  const top = 18;
  const values = rows.map((r) => r.profit);
  const maxValue = niceMax(Math.max(0, ...values) / 100) * 100;
  const minValue = Math.min(0, ...values) < 0 ? -niceMax(-Math.min(...values) / 100) * 100 : 0;
  const y = (v) => top + ((maxValue - v) / (maxValue - minValue || 1)) * (height - top - bottom);
  const slot = (width - left) / Math.max(rows.length, 1);
  const barWidth = Math.min(48, slot * 0.6);
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart", role: "img", "aria-label": "Profit per year" });
  for (const v of [maxValue, maxValue / 2, 0, minValue].filter((v, i, a) => a.indexOf(v) === i)) {
    svg.append(s("line", { x1: left, x2: width, y1: y(v), y2: y(v), class: v === 0 ? "axis" : "grid" }));
    svg.append(s("text", { x: left - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, euro(v, { round: true })));
  }
  rows.forEach((row, i) => {
    const x = left + i * slot + (slot - barWidth) / 2;
    const y0 = y(0);
    const y1 = y(row.profit);
    const bar = s(
      "rect",
      {
        x,
        y: Math.min(y0, y1),
        width: barWidth,
        height: Math.max(Math.abs(y1 - y0), row.profit ? 1 : 0),
        rx: 3,
        class: `bar ${row.profit < 0 ? "negative" : ""} ${row.year === state.year ? "current" : ""}`,
      },
      s("title", {}, `${row.year}: income ${euro(row.income)}, expenses ${euro(row.expenses)}, profit ${euro(row.profit)}`),
    );
    const hit = s("rect", { x: left + i * slot, y: 0, width: slot, height, class: "hit" });
    const group = s("g", { class: "year-bar", tabindex: 0, role: "button", "aria-label": `${row.year}: profit ${euro(row.profit)}` }, bar, hit);
    group.addEventListener("click", () => setYear(row.year));
    group.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && setYear(row.year));
    svg.append(group);
    const label = rows.length > 14 && i % 2 && row.year !== state.year ? "" : String(row.year);
    svg.append(s("text", { x: x + barWidth / 2, y: height - 6, "text-anchor": "middle", class: `tick ${row.year === state.year ? "strong" : ""}` }, label));
  });
  return svg;
}

function monthChart(months) {
  const width = 1000;
  const height = 200;
  const left = 64;
  const bottom = 24;
  const top = 12;
  const max = niceMax(Math.max(0, ...months.flatMap((m) => [m.income, m.expenses])) / 100) * 100;
  const y = (v) => top + ((max - Math.max(v, 0)) / max) * (height - top - bottom);
  const slot = (width - left) / 12;
  const barWidth = Math.min(22, slot * 0.32);
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, class: "chart", role: "img", "aria-label": "Income and expenses by month" });
  for (const v of [max, max / 2, 0]) {
    svg.append(s("line", { x1: left, x2: width, y1: y(v), y2: y(v), class: v === 0 ? "axis" : "grid" }));
    svg.append(s("text", { x: left - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, euro(v, { round: true })));
  }
  months.forEach((m, i) => {
    const x = left + i * slot + slot / 2;
    const title = `${MONTHS[i]}: income ${euro(m.income)}, expenses ${euro(m.expenses)}`;
    svg.append(s("rect", { x: x - barWidth - 1, y: y(m.income), width: barWidth, height: y(0) - y(m.income), rx: 2, class: "bar income" }, s("title", {}, title)));
    svg.append(s("rect", { x: x + 1, y: y(m.expenses), width: barWidth, height: y(0) - y(m.expenses), rx: 2, class: "bar expense" }, s("title", {}, title)));
    svg.append(s("text", { x, y: height - 6, "text-anchor": "middle", class: "tick" }, MONTHS[i].slice(0, 3)));
  });
  const legend = h(
    "div",
    { class: "legend" },
    h("span", {}, h("i", { class: "swatch income" }), "Income"),
    h("span", {}, h("i", { class: "swatch expense" }), "Expenses"),
  );
  return [legend, svg];
}

// ---- Entries

function drawEntries() {
  const closed = isClosed(state.data, state.year);
  const search = normalizeText(state.search);
  const entries = sortEntries(
    state.data.entries.filter(
      (e) =>
        e.date.startsWith(String(state.year)) &&
        (state.filter === "all" || e.kind === state.filter) &&
        (!search || normalizeText(`${e.text} ${e.ref ?? ""} ${e.number ?? ""} ${categoryById(state.data, e.category)?.name ?? ""}`).includes(search)),
    ),
  );
  const toolbar = h(
    "div",
    { class: "toolbar" },
    segmented(
      [
        ["all", "All"],
        ["income", "Income"],
        ["expense", "Expenses"],
      ],
      state.filter,
      (value) => {
        state.filter = value;
        render();
      },
    ),
    h("input", {
      type: "search",
      placeholder: "Search",
      value: state.search,
      "aria-label": "Search entries",
      oninput: (e) => {
        state.search = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const input = document.querySelector(".toolbar input[type=search]");
        input.focus();
        input.setSelectionRange(pos, pos);
      },
    }),
    h("span", { class: "spacer" }),
    h("button", { class: "primary", disabled: closed, onclick: () => startEntry("income") }, "+ Income"),
    h("button", { class: "primary", disabled: closed, onclick: () => startEntry("expense") }, "+ Expense"),
    filePicker("Expense from file…", "A receipt or e-invoice (PDF, photo, XRechnung or ZUGFeRD) becomes a new expense. Or drop the file on the page."),
  );
  const income = entries.filter((e) => e.kind === "income").reduce((t, e) => t + e.amount, 0);
  const expenses = entries.filter((e) => e.kind === "expense").reduce((t, e) => t + e.amount, 0);
  const editingId = state.editing && !state.editing.isNew ? state.editing.id : null;
  const rows = entries.map((entry) => {
    if (entry.id === editingId) return h("tr", { class: "editing" }, h("td", { colspan: 6 }, editor()));
    const category = categoryById(state.data, entry.category);
    const group = groupById(state.data, category?.group);
    const line = lineFor(group, state.year);
    return h(
      "tr",
      { class: `entry ${closed ? "" : "clickable"}`, onclick: closed ? null : () => editEntry(entry) },
      h("td", { class: "nowrap", text: dateText(entry.date) }),
      h("td", { class: "muted nowrap", text: entry.kind === "income" && entry.number ? `#${entry.number}` : "" }),
      h("td", {}, entry.text, entry.ref ? h("span", { class: "sub", text: `Invoice ${entry.ref}` }) : null),
      h(
        "td",
        {},
        category ? `${category.name}` : h("span", { class: "risk-text", text: "No category" }),
        h("span", { class: "sub", text: group ? `${line ? `Line ${line.line} · ` : ""}${group.label}` : category ? "Not linked to an EÜR line" : "" }),
      ),
      h("td", { class: `num ${entry.kind === "income" ? "good-text" : ""}`, text: signed(entry) }),
      h("td", { class: "nowrap" }, receiptLink(entry)),
    );
  });
  const table = entries.length
    ? h(
        "table",
        { class: "entries" },
        h("thead", {}, h("tr", {}, h("th", { text: "Date" }), h("th", { text: "No." }), h("th", { text: "What" }), h("th", { text: "Category" }), h("th", { class: "num", text: "Amount" }), h("th", { text: "Receipt" }))),
        h("tbody", {}, rows),
        h(
          "tfoot",
          {},
          h("tr", {}, h("td", { colspan: 4, class: "muted", text: `${entries.length} entries` }), h("td", { class: "num" }, h("span", { class: "good-text", text: `+${euro(income)}` }), h("br"), `−${euro(expenses)}`), h("td")),
        ),
      )
    : h("p", { class: "muted", text: state.data.entries.length ? "No entries here." : "No entries yet. Add one, drop a receipt or e-invoice on the page, or import the old spreadsheets in Settings › Import." });
  return [
    closed ? h("p", { class: "notice", text: `${state.year} is closed: its entries can't be changed. Reopen it on the EÜR page.` }) : null,
    card(null, toolbar, state.editing?.isNew ? editor() : null, table),
  ];
}

/** "+150,00 €" for income, "−5,15 €" for an expense; a refund flips it. */
function signed(entry) {
  const value = entry.kind === "income" ? entry.amount : -entry.amount;
  return `${value >= 0 ? "+" : "−"}${euro(Math.abs(value))}`;
}

function receiptLink(entry) {
  if (!entry.receipt) return h("span", { class: "muted", text: "–" });
  const link = h("a", { href: `/api/receipts/${entry.receipt.file}`, target: "_blank", rel: "noopener", title: entry.receipt.name, onclick: (e) => e.stopPropagation(), text: entry.receipt.file.split(".").pop().toUpperCase() });
  if (!hasInvoiceView(entry.receipt)) return link;
  const view = h("button", { type: "button", class: "link", title: "Show the e-invoice in readable form", onclick: (e) => (e.stopPropagation(), showInvoice(entry.receipt)) }, "E-invoice");
  return h("span", { class: "receipt-links" }, view, link);
}

function segmented(options, value, onChange) {
  return h(
    "div",
    { class: "segmented", role: "group" },
    options.map(([id, label]) => h("button", { type: "button", class: id === value ? "on" : null, "aria-pressed": String(id === value), onclick: () => onChange(id) }, label)),
  );
}

function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function startEntry(kind, fields = {}) {
  const date = state.year === new Date().getFullYear() ? todayIso() : `${state.year}-12-31`;
  const category = state.data.categories.find((c) => c.kind === kind)?.id ?? null;
  state.editing = {
    isNew: true,
    id: newId(),
    kind,
    date,
    amount: null,
    text: "",
    category,
    ref: "",
    receipt: null,
    number: kind === "income" ? nextNumber(state.data) : undefined,
    // Not saved: tell what was chosen from what the form started with.
    defaultDate: date,
    defaultCategory: category,
    ...fields,
  };
  state.editorProblems = [];
  render();
  document.querySelector(`.editor input[name=${state.editing.date ? "amount" : "date"}]`)?.focus();
}

// ---- receipt files and e-invoices

/** A button that picks a file for a new expense, as + Expense replaces
 *  the form that is open. */
function filePicker(label, title) {
  const input = h("input", {
    type: "file",
    accept: RECEIPT_ACCEPT,
    hidden: true,
    onchange: (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      if (file) addFile(file, { fresh: true });
    },
  });
  return h("span", {}, h("button", { type: "button", title, onclick: () => input.click() }, label), input);
}

/**
 * A dropped or picked file. With the form open (and not fresh), it becomes
 * the receipt of that entry, and an e-invoice fills in a new expense where
 * nothing was typed. Otherwise it starts a new expense: an e-invoice fills
 * it in and leaves the date empty, for the day it was paid; any other file
 * just becomes its receipt. A file that is no e-invoice, or a broken one,
 * says so.
 */
async function addFile(file, { fresh = false, note = null } = {}) {
  const before = state.editing;
  const target = fresh ? null : before; // the form the file is for; none: a new expense
  toast(`Reading ${file.name}…`);
  let upload;
  try {
    upload = await uploadAndRead(file);
  } catch (error) {
    toast(`Not added: ${error.message}`, "bad");
    return;
  }
  // The form may have closed or changed while the file was read: then the
  // file belongs to none of what is open now.
  if (state.editing !== before || (!target && route().view !== "entries")) {
    toast(`${file.name} was not added: the form changed while it was read. Add it again.`, "bad");
    return;
  }
  const { receipt, reading } = upload;
  const invoice = reading.status === "invoice" ? reading.invoice : null;
  const opened = !target;
  if (opened) startEntry("expense", invoice ? { date: "", category: null } : {});
  const e = state.editing;
  e.receipt = receipt;
  e.fromFile = { name: file.name, reading, notes: [], warnings: [reading.status === "problem" ? reading.message : null, note].filter(Boolean), dates: [] };
  if (invoice && e.isNew && e.kind === "expense") {
    const draft = expenseFromInvoice(state.data, invoice, receipt.file);
    // A field is free when empty, as the form started, or as an earlier
    // file filled it: what was typed or chosen stays. e.filled holds what
    // this file filled in, and nothing else.
    const previous = e.filled ?? {};
    const free = (key) => e[key] == null || String(e[key]).trim() === "" || (key in previous && e[key] === previous[key]);
    const filled = {};
    for (const key of ["text", "amount", "ref"]) if (free(key)) filled[key] = e[key] = draft[key];
    if (opened || e.category === e.defaultCategory || ("category" in previous && e.category === previous.category)) filled.category = e.category = draft.category;
    if (e.date === e.defaultDate) e.date = "";
    e.filled = filled;
    Object.assign(e.fromFile, { notes: draft.notes, warnings: [...draft.warnings, ...e.fromFile.warnings], dates: draft.dates });
  }
  render();
  if (opened) document.querySelector(`.editor input[name=${e.date ? "amount" : "date"}]`)?.focus();
  if (invoice) toast(`Read the e-invoice from ${invoice.seller?.name ?? "the supplier"}: check it, then save.`);
  else if (reading.status === "problem") toast("Not read as an e-invoice: kept as a plain receipt.", "bad");
  else toast(`${file.name} is the receipt.`);
}

/** In the form: what was read from the file, and what to check. */
function fileNote(e) {
  const f = e.fromFile;
  if (!f) return null;
  const invoice = f.reading.status === "invoice" ? f.reading.invoice : null;
  return h(
    "div",
    { class: `from-file ${f.warnings.length ? "warn" : ""}` },
    invoice
      ? h(
          "p",
          {},
          h("strong", { text: `E-invoice from ${invoice.seller?.name ?? "an unknown supplier"}` }),
          ` · ${invoiceSummary(invoice)} `,
          h("button", { type: "button", class: "link", onclick: () => showInvoice(e.receipt, f.reading) }, "Show the invoice"),
        )
      : null,
    f.warnings.map((w) => h("p", { class: "risk-text small", text: w })),
    f.notes.map((n) => h("p", { class: "muted small", text: n })),
    f.reading.status === "problem" ? h("p", { class: "muted small", text: "The file is kept as a plain receipt: fill in the expense yourself." }) : null,
    invoice && e.isNew && !e.date ? h("p", { class: "muted small", text: "Enter the day you paid it: an expense counts on the day of payment (Zuflussprinzip)." }) : null,
  );
}

/** Buttons under the date: the invoice's dates and today. */
function datePicks(e) {
  const dates = e.fromFile?.dates ?? [];
  if (!dates.length) return null;
  const pick = (date) => () => {
    e.date = date;
    render();
    document.querySelector(".editor input[name=amount]")?.focus();
  };
  return h(
    "span",
    { class: "date-picks" },
    [...dates, { label: "Today", date: todayIso() }].map((d) => h("button", { type: "button", class: "link", title: dateText(d.date), onclick: pick(d.date) }, d.label)),
  );
}

/** The e-invoice in readable form, in a dialog over the page. The XML
 *  itself is served as plain text only, so the page draws what the server
 *  read from it. */
async function showInvoice(receipt, reading) {
  if (!reading) {
    try {
      const response = await fetch(`/api/einvoice/${receipt.file}`);
      reading = await response.json();
      if (!response.ok) throw new Error(reading.error || response.statusText);
    } catch (error) {
      toast(`Can't show it: ${error.message}`, "bad");
      return;
    }
  }
  let dialog = document.getElementById("invoice-view");
  if (!dialog) {
    dialog = h("dialog", { id: "invoice-view", class: "invoice-view", "aria-labelledby": "invoice-view-title" });
    // A click on the backdrop closes it, as Escape does.
    dialog.addEventListener("click", (event) => event.target === dialog && dialog.close());
    document.body.append(dialog);
  }
  dialog.replaceChildren(invoiceSheet(reading, receipt, () => dialog.close()));
  if (!dialog.open) dialog.showModal();
  dialog.querySelector(".sheet-head button")?.focus();
}

function invoiceSheet(reading, receipt, close) {
  const fileLink = receipt?.file ? h("a", { href: `/api/receipts/${receipt.file}`, target: "_blank", rel: "noopener", text: receipt.file.endsWith(".xml") ? "Open the XML" : "Open the file" }) : null;
  const head = (title, sub) =>
    h("div", { class: "sheet-head" }, h("div", {}, h("h2", { id: "invoice-view-title", text: title }), sub ? h("p", { class: "muted small", text: sub }) : null), fileLink, h("button", { type: "button", onclick: close }, "Close"));
  if (reading.status !== "invoice") {
    const message = reading.message ?? "No e-invoice data in this file.";
    return h("div", { class: "sheet" }, head(receipt?.name ?? "Receipt"), h("p", { class: "notice", text: message }));
  }
  const v = invoiceView(reading.invoice);
  const list = (rows) => h("dl", { class: "facts" }, rows.flatMap(([label, value]) => [h("dt", { text: label }), h("dd", { text: value })]));
  const lines = v.lines.length
    ? h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "compact lines" },
          h("thead", {}, h("tr", {}, h("th", { text: "Pos." }), h("th", { text: "Item" }), h("th", { class: "num", text: "Quantity" }), h("th", { class: "num", text: "Unit price" }), h("th", { class: "num", text: "VAT" }), h("th", { class: "num", text: "Net" }))),
          h(
            "tbody",
            {},
            v.lines.map((line) =>
              h(
                "tr",
                {},
                h("td", { class: "muted", text: line.position }),
                h("td", {}, line.name, line.description ? h("span", { class: "sub pre", text: line.description }) : null),
                h("td", { class: "num", text: line.quantity }),
                h("td", { class: "num", text: line.price }),
                h("td", { class: "num", text: line.vat }),
                h("td", { class: "num", text: line.amount }),
              ),
            ),
          ),
        ),
      )
    : h("p", { class: "muted", text: "No invoice lines in this e-invoice." });
  const totals = h(
    "table",
    { class: "compact totals" },
    h(
      "tbody",
      {},
      v.totals.map((row) => h("tr", { class: row.strong ? "strong" : null }, h("td", {}, row.label, row.detail ? h("span", { class: "sub", text: row.detail }) : null), h("td", { class: "num", text: row.amount }))),
    ),
  );
  return h(
    "div",
    { class: "sheet" },
    head(v.title, v.source),
    v.warnings.length ? h("ul", { class: "problems" }, v.warnings.map((w) => h("li", { text: w }))) : null,
    v.credit ? h("p", { class: "notice", text: "A credit note: the supplier credits you this amount." }) : null,
    h("div", { class: "parties" }, v.parties.map((p) => h("div", { class: "party" }, h("h3", { text: p.label }), p.lines.map((line) => h("p", { text: line }))))),
    v.facts.length ? list(v.facts) : null,
    lines,
    totals,
    v.payment.length ? h("div", {}, h("h3", { text: "Payment" }), list(v.payment)) : null,
    v.notes.length ? h("div", { class: "notes" }, h("h3", { text: "Notes" }), v.notes.map((n) => h("p", { text: n }))) : null,
  );
}

/** Files dropped on the Entries page go to addFile. Elsewhere a drop does
 *  nothing, instead of the browser leaving the app to open the file. */
function setUpDrop() {
  const overlay = h("div", { class: "drop-overlay", hidden: true }, h("p"));
  document.body.append(overlay);
  let depth = 0;
  const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");
  const here = () => route().view === "entries";
  window.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth += 1;
    if (!here()) return;
    overlay.firstChild.textContent = state.editing ? "Drop to make it the receipt of the entry in the form" : "Drop to add an expense from it: PDF, photo or e-invoice";
    overlay.hidden = false;
  });
  window.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  window.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = here() ? "copy" : "none";
  });
  window.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const files = [...event.dataTransfer.files];
    if (here() && files.length) addFile(files[0], { note: files.length > 1 ? `One file at a time: only ${files[0].name} was added.` : null });
  });
}

function editEntry(entry) {
  state.editing = structuredClone(entry);
  state.editorProblems = [];
  render();
}

function editor() {
  const e = state.editing;
  const set = (key) => (event) => {
    e[key] = event.target.value;
  };
  const categories = state.data.categories.filter((c) => c.kind === e.kind).sort((a, b) => a.account - b.account);
  const receipt = e.receipt
    ? h(
        "span",
        { class: "receipt" },
        h("a", { href: `/api/receipts/${e.receipt.file}`, target: "_blank", rel: "noopener", text: e.receipt.name }),
        hasInvoiceView(e.receipt) && !e.fromFile ? h("button", { type: "button", class: "link", onclick: () => showInvoice(e.receipt) }, "Show the invoice") : null,
        h("button", { type: "button", class: "link danger", onclick: () => ((e.receipt = null), (e.fromFile = null), render()) }, "Remove"),
      )
    : h("input", {
        type: "file",
        accept: RECEIPT_ACCEPT,
        onchange: (event) => {
          const file = event.target.files[0];
          if (file) addFile(file);
        },
      });
  const paidDate = e.fromFile?.reading.status === "invoice" && e.kind === "expense";
  return h(
    "form",
    {
      class: "editor",
      onsubmit: (event) => {
        event.preventDefault();
        saveEntry();
      },
      onkeydown: (event) => event.key === "Escape" && cancelEdit(),
    },
    h("div", { class: "editor-head" }, h("h3", { text: e.isNew ? `New ${e.kind === "income" ? "income" : "expense"}` : `Edit ${e.kind === "income" ? "income" : "expense"}` })),
    fileNote(e),
    h(
      "div",
      { class: "form-grid" },
      h("label", {}, paidDate ? "Date paid" : "Date", h("input", { name: "date", value: dateText(parseDate(e.date) ?? "") || e.date, placeholder: "TT.MM.JJJJ", oninput: set("date"), required: true }), datePicks(e)),
      h("label", {}, "Amount (€)", h("input", { name: "amount", inputmode: "decimal", value: typeof e.amount === "number" ? amountText(e.amount) : (e.amount ?? ""), placeholder: "12,40", oninput: set("amount"), required: true })),
      h("label", { class: "wide" }, "What", h("input", { name: "text", value: e.text, placeholder: e.kind === "income" ? "Workshop, affiliate payout" : "Domain example.de", oninput: set("text"), required: true })),
      h(
        "label",
        { class: "wide" },
        "Category",
        h(
          "select",
          { name: "category", onchange: set("category") },
          e.category ? null : h("option", { value: "", selected: true, disabled: true, text: "Choose a category" }),
          categories.map((c) => h("option", { value: c.id, selected: c.id === e.category, text: `${c.account} · ${c.name}${c.group ? "" : " (no EÜR line)"}` })),
        ),
      ),
      e.kind === "income"
        ? h("label", {}, "No.", h("input", { name: "number", inputmode: "numeric", value: e.number ?? "", oninput: set("number") }))
        : null,
      h("label", {}, e.kind === "income" ? "Payer's invoice no." : "Invoice no.", h("input", { name: "ref", value: e.ref ?? "", oninput: set("ref") })),
      h("label", { class: "wide" }, "Receipt", receipt),
    ),
    state.editorProblems.length ? h("ul", { class: "problems" }, state.editorProblems.map((p) => h("li", { text: p }))) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", type: "submit" }, "Save"),
      h("button", { type: "button", onclick: cancelEdit }, "Cancel"),
      e.kind === "expense" ? h("button", { type: "button", title: "Something that lasts more than a year: written off as AfA or GWG instead", onclick: () => makeAsset(e) }, "Make it an asset") : null,
      e.isNew ? null : h("button", { type: "button", class: "danger push", onclick: () => deleteEntry(e.id) }, "Delete"),
    ),
  );
}

/** Opens the entry in the Assets view's form; saving it there takes the
 *  entry out. */
function makeAsset(entry) {
  startAssetFromEntry(entry, entry.isNew);
  state.editing = null;
  location.hash = "#assets";
}

function cancelEdit() {
  state.editing = null;
  render();
}

function saveEntry() {
  const e = state.editing;
  const entry = {
    id: e.id,
    kind: e.kind,
    date: parseDate(e.date) ?? e.date,
    amount: typeof e.amount === "number" ? e.amount : parseAmount(e.amount),
    text: String(e.text).trim(),
    category: e.category,
    ref: String(e.ref ?? "").trim(),
    receipt: e.receipt ?? null,
  };
  if (e.kind === "income") {
    const number = Number(e.number);
    entry.number = Number.isInteger(number) && number > 0 ? number : null;
  }
  const original = state.data.entries.find((x) => x.id === e.id);
  if (original?.imported) entry.imported = true;
  const problems = entryProblems(state.data, entry);
  if (original && isClosed(state.data, Number(original.date.slice(0, 4)))) problems.push("Its year is closed.");
  if (problems.length) {
    state.editorProblems = problems;
    render();
    return;
  }
  state.editing = null;
  state.year = Number(entry.date.slice(0, 4));
  change((data) => {
    const at = data.entries.findIndex((x) => x.id === entry.id);
    if (at >= 0) data.entries[at] = entry;
    else data.entries.push(entry);
  });
  toast("Saved");
}

function deleteEntry(id) {
  const entry = state.data.entries.find((x) => x.id === id);
  if (!entry || !confirm(`Delete "${entry.text}" (${euro(entry.amount)})?`)) return;
  state.editing = null;
  change((data) => {
    data.entries = data.entries.filter((x) => x.id !== id);
  });
  toast("Deleted");
}

// ---- EÜR

function lineLabel(line) {
  if (!line) return h("span", { class: "risk-text", text: "?" });
  return h("span", { class: line.carried ? "risk-text" : null, title: line.carried ? `Line number of the ${line.from} form: check it against the ${state.year} form` : null, text: line.line });
}

function drawEuer() {
  const r = euer(state.data, state.year);
  const closed = isClosed(state.data, state.year);
  const business = state.data.business ?? {};
  const carried = [...r.income, ...r.expenses, r.homeOffice].find((row) => row.line?.carried);
  const section = (title, rows, unlinked) => {
    const visible = rows.filter((row) => row.amount !== 0);
    const out = [h("tr", { class: "section" }, h("th", { colspan: 3, text: title }))];
    for (const row of visible) {
      out.push(h("tr", { class: "group" }, h("td", { class: "line" }, lineLabel(row.line)), h("td", { text: row.label }), h("td", { class: "num", text: euro(row.amount) })));
      for (const c of row.categories.filter((c) => c.amount !== 0)) {
        out.push(h("tr", { class: "category" }, h("td"), h("td", { text: c.account == null ? c.name : `${c.account} · ${c.name}` }), h("td", { class: "num muted", text: euro(c.amount) })));
      }
    }
    if (unlinked.length) {
      const amount = unlinked.reduce((t, e) => t + e.amount, 0);
      out.push(
        h(
          "tr",
          { class: "group warn" },
          h("td", { class: "line" }, h("span", { class: "risk-text", text: "!" })),
          h("td", {}, `Not linked to a line: ${unlinked.length} entries`, h("span", { class: "sub", text: "Link their categories to an EÜR line in Settings › Categories." })),
          h("td", { class: "num", text: euro(amount) }),
        ),
      );
    }
    if (!visible.length && !unlinked.length) out.push(h("tr", {}, h("td"), h("td", { class: "muted", text: "None" }), h("td")));
    return out;
  };
  const ho = r.homeOffice;
  const homeRow = ho.amount
    ? h(
        "tr",
        { class: "group" },
        h("td", { class: "line" }, lineLabel(ho.line)),
        h("td", {}, ho.label, h("span", { class: "sub", text: `${ho.days} days × ${euro(ho.rate.perDay)}${ho.capped ? `, capped at ${euro(ho.rate.max)}` : ""}` })),
        h("td", { class: "num", text: euro(ho.amount) }),
      )
    : null;
  const table = h(
    "table",
    { class: "euer" },
    h("thead", {}, h("tr", {}, h("th", { class: "line", text: "Line" }), h("th", { text: `Anlage EÜR ${state.year} · Kleinunternehmer` }), h("th", { class: "num", text: "Amount" }))),
    h(
      "tbody",
      {},
      section("Betriebseinnahmen", r.income, r.unlinked.income),
      h("tr", { class: "total" }, h("td"), h("td", { text: "Summe Einnahmen" }), h("td", { class: "num", text: euro(r.totalIncome) })),
      section("Betriebsausgaben", r.expenses, r.unlinked.expense),
      homeRow,
      h("tr", { class: "total" }, h("td"), h("td", { text: "Summe Ausgaben" }), h("td", { class: "num", text: euro(r.totalExpenses) })),
      h("tr", { class: "profit" }, h("td"), h("td", { text: r.profit < 0 ? "Verlust" : "Gewinn" }), h("td", { class: "num", text: euro(r.profit) })),
    ),
  );
  const t = yearTotals(state.data, state.year);
  const filed = r.filed;
  const checks = h(
    "ul",
    { class: "checks" },
    h("li", { class: t.uncategorized ? "risk-text" : "good-text", text: t.uncategorized ? `${t.uncategorized} entries without an EÜR line` : "Every entry has an EÜR line" }),
    h("li", { class: t.missingReceipts ? "muted" : "good-text", text: t.missingReceipts ? `${t.missingReceipts} entries without a receipt file` : "Every entry has a receipt file" }),
    t.assets.missingReceipts ? h("li", { class: "muted", text: `${t.assets.missingReceipts} assets bought without a receipt file` }) : null,
    carried ? h("li", { class: "risk-text", text: `Orange line numbers are from the ${carried.line.from} form: check them against the ${state.year} form, then set them in Settings › Categories.` }) : null,
    filed !== null
      ? h("li", { class: filed === r.profit ? "good-text" : "risk-text", text: filed === r.profit ? `Matches the profit filed: ${euro(filed)}` : `Filed ${euro(filed)}: ${euro(r.profit - filed)} apart` })
      : null,
  );
  const head = h(
    "div",
    { class: "card-head" },
    h("h2", { text: `Gewinnermittlung nach § 4 Abs. 3 EStG · ${state.year}` }),
    h("button", { onclick: () => window.print() }, "Print / PDF"),
    closed
      ? h("button", { onclick: () => toggleClosed(false) }, "Reopen year")
      : h("button", { onclick: () => toggleClosed(true), title: "After filing: no more changes to this year's entries" }, "Close year"),
  );
  const who = [business.name, business.taxNumber ? `Steuernummer ${business.taxNumber}` : null].filter(Boolean).join(" · ");
  return [
    card(null, head, who ? h("p", { class: "muted", text: who }) : null, closed ? h("p", { class: "notice", text: "Closed: entries of this year can't be changed." }) : null, table, checks),
    aveurCard(ui()),
    h("div", { class: "columns no-print" }, homeOfficeCard(closed), filedCard(r, closed)),
    printList("Einnahmen", "income"),
    printList("Ausgaben", "expense"),
    printAssets(ui()),
  ];
}

/** The year's entries of one kind, only on paper: the EÜR's record. */
function printList(title, kind) {
  const entries = state.data.entries.filter((e) => e.kind === kind && e.date.startsWith(String(state.year))).sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? 0) - (b.number ?? 0));
  if (!entries.length) return null;
  const total = entries.reduce((t, e) => t + e.amount, 0);
  return h(
    "section",
    { class: "print-only" },
    h("h2", { text: `${title} ${state.year}` }),
    h(
      "table",
      { class: "compact" },
      h("thead", {}, h("tr", {}, h("th", { text: "Datum" }), h("th", { class: "num", text: "Betrag" }), h("th", { text: "Text" }), h("th", { text: kind === "income" ? "Nr." : "Rechnungsnr." }), h("th", { text: kind === "income" ? "Rechnungsnr. extern" : "" }), h("th", { class: "num", text: "Konto" }))),
      h(
        "tbody",
        {},
        entries.map((e) =>
          h(
            "tr",
            {},
            h("td", { text: dateText(e.date) }),
            h("td", { class: "num", text: euro(e.amount) }),
            h("td", { text: e.text }),
            h("td", { text: kind === "income" ? (e.number ?? "") : (e.ref ?? "") }),
            h("td", { text: kind === "income" ? (e.ref ?? "") : "" }),
            h("td", { class: "num", text: categoryById(state.data, e.category)?.account ?? "" }),
          ),
        ),
      ),
      h("tfoot", {}, h("tr", {}, h("td", { text: "Summe" }), h("td", { class: "num", text: euro(total) }), h("td", { colspan: 4 }))),
    ),
  );
}

function toggleClosed(close) {
  if (close && !confirm(`Close ${state.year}? Its entries can't be changed until it is reopened.`)) return;
  if (!close && !confirm(`Reopen ${state.year}? Change it only if the filed EÜR is corrected too.`)) return;
  change((data) => {
    const set = new Set(data.closed ?? []);
    if (close) set.add(state.year);
    else set.delete(state.year);
    data.closed = [...set].sort();
  });
}

function homeOfficeCard(closed) {
  const rate = homeOfficeRate(state.year);
  if (!rate) return card("Home office", h("p", { class: "muted", text: `No day rate in ${state.year}: it started in 2020.` }));
  const rows = state.data.homeOffice?.[state.year] ?? [];
  const update = (fn) => change((data) => {
    data.homeOffice ??= {};
    const list = (data.homeOffice[state.year] ??= []);
    fn(list);
    if (!list.length) delete data.homeOffice[state.year];
  });
  return card(
    "Home office days",
    h("p", { class: "muted small", text: `Days of business work at home, by activity: ${euro(rate.perDay)} a day, up to ${euro(rate.max, { round: true })} a year.` }),
    h(
      "table",
      { class: "compact" },
      h(
        "tbody",
        {},
        rows.map((row, i) =>
          h(
            "tr",
            {},
            h("td", {}, h("input", { value: row.activity, disabled: closed, "aria-label": "Activity", onchange: (e) => update((list) => (list[i].activity = e.target.value)) })),
            h("td", { class: "num" }, h("input", { class: "days", type: "number", min: 0, max: 366, value: row.days, disabled: closed, "aria-label": "Days", onchange: (e) => update((list) => (list[i].days = Math.max(0, Number(e.target.value) || 0))) })),
            h("td", {}, closed ? null : h("button", { class: "link danger", onclick: () => update((list) => list.splice(i, 1)) }, "Remove")),
          ),
        ),
      ),
    ),
    closed ? null : h("button", { onclick: () => update((list) => list.push({ activity: "", days: 0 })) }, "+ Activity"),
  );
}

function filedCard(r, closed) {
  return card(
    "Filed with the tax office",
    h("p", { class: "muted small", text: "The profit of the EÜR sent for this year, to check the entries against it." }),
    h(
      "label",
      {},
      "Profit filed (€)",
      h("input", {
        inputmode: "decimal",
        value: r.filed === null ? "" : amountText(r.filed),
        placeholder: amountText(r.profit),
        disabled: closed,
        onchange: (e) => {
          const value = e.target.value.trim() ? parseAmount(e.target.value) : null;
          change((data) => {
            data.filed ??= {};
            if (value === null) delete data.filed[state.year];
            else data.filed[state.year] = value;
          });
        },
      }),
    ),
  );
}

// ---- Settings

function drawSettings(tab) {
  const tabs = h(
    "nav",
    { class: "tabs" },
    SETTINGS_TABS.map(([id, label]) => h("a", { href: `#settings/${id}`, class: id === tab ? "active" : null, text: label })),
  );
  const draw = { categories: drawCategories, import: drawImport, business: drawBusiness, backup: drawBackup, updates: drawUpdates }[tab] ?? drawCategories;
  return [tabs, draw()];
}

function drawCategories() {
  const formYear = state.formYear ?? state.year;
  const groupOptions = (kind, value) => [
    h("option", { value: "", selected: !value, text: "No EÜR line" }),
    ...state.data.groups.filter((g) => g.kind === kind && !isComputedGroup(g.id)).map((g) => h("option", { value: g.id, selected: g.id === value, text: g.label })),
  ];
  const used = new Set(state.data.entries.map((e) => e.category));
  const categoryRows = (kind) =>
    state.data.categories
      .filter((c) => c.kind === kind)
      .sort((a, b) => a.account - b.account)
      .map((c) =>
        h(
          "tr",
          {},
          h("td", { class: "num", text: c.account }),
          h("td", {}, h("input", { value: c.name, "aria-label": "Name", onchange: (e) => updateCategory(c.id, { name: e.target.value.trim() || c.name }) })),
          h("td", {}, h("select", { "aria-label": "EÜR line", onchange: (e) => updateCategory(c.id, { group: e.target.value || null }) }, groupOptions(kind, c.group))),
          h("td", {}, used.has(c.id) ? h("span", { class: "muted small", text: "in use" }) : h("button", { class: "link danger", onclick: () => removeCategory(c.id) }, "Remove")),
        ),
      );
  const addForm = (kind) =>
    h(
      "form",
      {
        class: "inline-form",
        onsubmit: (e) => {
          e.preventDefault();
          const form = new FormData(e.target);
          addCategory(kind, Number(form.get("account")), String(form.get("name")).trim());
        },
      },
      h("input", { name: "account", type: "number", min: 1, placeholder: "Konto", required: true, "aria-label": "Account number", class: "days" }),
      h("input", { name: "name", placeholder: "Name", required: true, "aria-label": "Name" }),
      h("button", { type: "submit" }, "+ Category"),
    );
  const head = h("thead", {}, h("tr", {}, h("th", { class: "num", text: "Konto" }), h("th", { text: "Name" }), h("th", { text: "EÜR line" }), h("th")));
  const lineRows = state.data.groups.map((g) => {
    const line = lineFor(g, formYear);
    return h(
      "tr",
      {},
      h("td", { class: "num" }, h("input", { class: "days", type: "number", min: 1, value: g.lines?.[formYear] ?? "", placeholder: line ? String(line.line) : "?", "aria-label": `Line in the ${formYear} form`, onchange: (e) => setLine(g.id, formYear, e.target.value) })),
      h("td", { text: g.label }),
      h("td", { class: "muted", text: g.kind === "income" ? "Income" : "Expense" }),
    );
  });
  return [
    card("Income categories", h("table", { class: "compact" }, head.cloneNode(true), h("tbody", {}, categoryRows("income"))), addForm("income")),
    card("Expense categories", h("table", { class: "compact" }, head, h("tbody", {}, categoryRows("expense"))), addForm("expense")),
    card(
      null,
      h(
        "div",
        { class: "card-head" },
        h("h2", { text: "EÜR lines" }),
        h(
          "label",
          { class: "inline" },
          "Form of",
          h(
            "select",
            { onchange: (e) => ((state.formYear = Number(e.target.value)), render()) },
            years(state.data).map((y) => h("option", { value: y, selected: y === formYear, text: y })),
          ),
        ),
      ),
      h("p", { class: "muted small", text: "The line numbers change from year to year. An empty field uses the number of the nearest form that has one, shown grey: type the number from this year's form to set it." }),
      h("table", { class: "compact" }, h("thead", {}, h("tr", {}, h("th", { class: "num", text: "Line" }), h("th", { text: "Label" }), h("th"))), h("tbody", {}, lineRows)),
    ),
  ];
}

function updateCategory(id, fields) {
  change((data) => {
    const c = data.categories.find((x) => x.id === id);
    Object.assign(c, fields);
  });
}

function removeCategory(id) {
  change((data) => {
    data.categories = data.categories.filter((c) => c.id !== id);
  });
}

function addCategory(kind, account, name) {
  const id = `${kind === "income" ? "in" : "ex"}-${account}`;
  if (!Number.isInteger(account) || account < 1 || !name) return;
  if (categoryById(state.data, id)) {
    toast(`Konto ${account} exists already.`, "bad");
    return;
  }
  change((data) => {
    data.categories.push({ id, kind, account, name, group: null });
  });
}

function setLine(groupId, year, value) {
  const line = Number(value);
  change((data) => {
    const g = data.groups.find((x) => x.id === groupId);
    g.lines ??= {};
    if (value === "" || !Number.isInteger(line) || line < 1) delete g.lines[year];
    else g.lines[year] = line;
  });
}

async function readFileText(file) {
  const buffer = await file.arrayBuffer();
  const utf8 = new TextDecoder("utf-8").decode(buffer);
  // Excel on Windows saves CSV as Windows-1252: then UTF-8 shows U+FFFD.
  return utf8.includes("�") ? new TextDecoder("windows-1252").decode(buffer) : utf8;
}

function drawImport() {
  const picker = h("input", {
    type: "file",
    accept: ".csv,text/csv",
    multiple: true,
    onchange: async (e) => {
      const files = [...e.target.files];
      for (const file of files) {
        const text = await readFileText(file);
        state.tables.push({ name: file.name, text, ...readTable(text, { fileName: file.name }) });
      }
      render();
    },
  });
  const intro = card(
    "Import from the spreadsheets",
    h("p", {}, "Export the ", h("strong", { text: "Einnahmen" }), " and ", h("strong", { text: "Ausgaben" }), " tables of each year as CSV, and pick the files here, several at once. Columns: Datum, Betrag, Text or Beschreibung, Rechnungsnr., Rechnungsnr. EXTERN, Konto. Title, empty and Summe rows are skipped."),
    h("p", { class: "muted small", text: "Nothing is saved until Import. Entries already there (same day, amount and text) are left out, so a file can be picked again safely." }),
    picker,
  );
  if (!state.tables.length) return [intro];
  const files = card(
    "Files",
    h(
      "table",
      { class: "compact" },
      h("thead", {}, h("tr", {}, h("th", { text: "File" }), h("th", { text: "Table" }), h("th", { class: "num", text: "Rows" }), h("th", { text: "Problems" }), h("th"))),
      h(
        "tbody",
        {},
        state.tables.map((t, i) =>
          h(
            "tr",
            {},
            h("td", { text: t.name }),
            h(
              "td",
              {},
              h(
                "select",
                {
                  "aria-label": "Table",
                  onchange: (e) => {
                    state.tables[i] = { name: t.name, text: t.text, ...readTable(t.text, { kind: e.target.value }) };
                    render();
                  },
                },
                h("option", { value: "income", selected: t.kind === "income", text: "Einnahmen (income)" }),
                h("option", { value: "expense", selected: t.kind === "expense", text: "Ausgaben (expenses)" }),
              ),
            ),
            h("td", { class: "num", text: t.rows.length }),
            h("td", {}, t.problems.length ? h("ul", { class: "problems" }, t.problems.map((p) => h("li", { text: `Row ${p.row}: ${p.reason}` }))) : h("span", { class: "muted", text: "None" })),
            h("td", {}, h("button", { class: "link danger", onclick: () => (state.tables.splice(i, 1), render()) }, "Remove")),
          ),
        ),
      ),
    ),
  );
  const plan = planImport(state.data, state.tables);
  const yearRows = [...plan.byYear].map(([year, t]) =>
    h("tr", {}, h("td", { text: year }), h("td", { class: "num", text: t.count }), h("td", { class: "num", text: euro(t.income) }), h("td", { class: "num", text: euro(t.expenses) }), h("td", { class: "num", text: euro(t.income - t.expenses) })),
  );
  const summary = card(
    "What the import adds",
    plan.entries.length
      ? h(
          "table",
          { class: "compact" },
          h("thead", {}, h("tr", {}, h("th", { text: "Year" }), h("th", { class: "num", text: "Entries" }), h("th", { class: "num", text: "Income" }), h("th", { class: "num", text: "Expenses" }), h("th", { class: "num", text: "Balance" }))),
          h("tbody", {}, yearRows),
        )
      : h("p", { class: "muted", text: "No new entries in these files." }),
    h(
      "ul",
      { class: "checks" },
      plan.duplicates.length ? h("li", { class: "muted", text: `${plan.duplicates.length} entries are there already and are left out.` }) : null,
      plan.closedYears.length ? h("li", { class: "risk-text", text: `Closed years left out: ${plan.closedYears.join(", ")}.` }) : null,
      plan.newAccounts.length
        ? h("li", { class: "risk-text", text: `New accounts become categories without an EÜR line: ${plan.newAccounts.map((a) => `${a.kind === "income" ? "income" : "expense"} Konto ${a.account}`).join(", ")}. Link them in Settings › Categories.` })
        : null,
      plan.entries.some((e) => !e.category) ? h("li", { class: "risk-text", text: `${plan.entries.filter((e) => !e.category).length} rows have no Konto: they get no category.` }) : null,
      h("li", { class: "muted", text: "Balance leaves out the home-office days: add those per year on the EÜR page." }),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          class: "primary",
          disabled: !plan.entries.length,
          onclick: () => {
            const count = plan.entries.length;
            state.year = Math.max(...plan.byYear.keys());
            state.tables = [];
            change((data) => applyImport(data, plan));
            toast(`Imported ${count} entries`);
          },
        },
        `Import ${plan.entries.length} entries`,
      ),
      h("button", { onclick: () => ((state.tables = []), render()) }, "Clear"),
    ),
  );
  return [intro, files, summary];
}

function drawBusiness() {
  const b = state.data.business ?? {};
  const field = (key, label, placeholder, multiline) =>
    h(
      "label",
      { class: multiline ? "wide" : null },
      label,
      h(multiline ? "textarea" : "input", {
        value: b[key] ?? "",
        placeholder,
        rows: multiline ? 3 : null,
        onchange: (e) =>
          change((data) => {
            data.business = { ...(data.business ?? {}), [key]: e.target.value.trim() };
          }),
      }),
    );
  return [
    card(
      "Business",
      h("p", { class: "muted small", text: "Shown on the EÜR and, later, on invoices. Stays in the data file on this computer." }),
      h("div", { class: "form-grid" }, field("name", "Name", "Vorname Nachname"), field("taxNumber", "Steuernummer", "12/345/67890"), field("address", "Address", "Straße 1\n10000 Berlin", true), field("iban", "IBAN", "DE00 …")),
    ),
    card(
      "Files",
      h("dl", { class: "paths" }, h("dt", { text: "Data" }), h("dd", {}, h("code", { text: state.paths.file ?? "" })), h("dt", { text: "Daily copies" }), h("dd", {}, h("code", { text: state.paths.backups ?? "" })), h("dt", { text: "Receipts" }), h("dd", {}, h("code", { text: state.paths.receipts ?? "" }))),
    ),
  ];
}

function drawBackup() {
  const info = state.backup ?? {};
  const b = backupState(info.status ?? null, state.revision);
  const setup = info.setup ?? "setup";
  const command = (text) => h("code", { text });
  const status = card(
    "Backup",
    h("p", { class: b.level === "warn" ? "risk-text" : b.level === "ok" ? null : "muted" }, h("strong", { text: b.title })),
    h("p", { class: b.level === "warn" ? "risk-text" : "muted", text: b.detail }),
    b.problem ? h("p", { class: "risk-text", text: b.problem }) : null,
    b.note ? h("p", { class: "muted", text: b.note }) : null,
    b.destination ? h("dl", { class: "paths" }, h("dt", { text: "Copies go to" }), h("dd", {}, command(b.destination))) : null,
  );
  if (b.level === "off") {
    return [
      status,
      card(
        "Set it up",
        h("p", {}, "Once a day, a timer copies the data, its daily copies and the receipts to another computer over SSH, such as a home server. Run once in a terminal:"),
        h("p", {}, command(`${setup} --backup user@host:path`)),
        h("p", { class: "muted small", text: "The other computer needs rsync and this computer's SSH key; the first copy shows whether it works." }),
      ),
    ];
  }
  return [
    status,
    card(
      "How it works",
      h(
        "ul",
        {},
        h("li", { text: "Once a day, the first time the other computer can be reached: a timer tries every hour, also after sleep. Offline, it waits quietly." }),
        h("li", {}, "Nothing there is ever deleted. A file that changed here replaces its copy there, and the old copy moves to ", command("replaced/<date and time>/"), ". So every version of the data file stays, and every receipt."),
        h("li", {}, "Copy now: ", command(info.backup ?? "backup"), ". Stop: ", command(`${setup} --no-backup`), "."),
        h("li", { text: "To go back to an earlier version: copy it from there over the data file here (Settings › Business › Files) and reload this window." }),
      ),
    ),
  ];
}

// The channel of the update button (update.mjs): which updates it offers.
function drawUpdates() {
  return [
    card(
      "Updates",
      h("p", { class: "muted small", text: "Stable offers releases, with release notes on GitHub. Preview offers every change as soon as its tests pass, before it is released: new features first, and now and then a new bug. Back on Stable, Bookkeeping keeps its version until a release is newer: it never goes back to an older one. Updates never touch the data or the receipts." }),
      updates.channelSettings(),
    ),
  ];
}

// ---- start

setUpDrop();
const updates = startUpdates(document.getElementById("update"), { saving: () => sending > 0, editing: () => state.editing !== null });

Promise.all([load(), loadBackup()])
  .then(() => {
    const all = years(state.data);
    if (!all.includes(state.year)) state.year = all[0];
    render();
  })
  .catch((error) => {
    document.getElementById("main").replaceChildren(h("p", { class: "bad-text", text: `Could not load the data: ${error.message}` }));
  });
