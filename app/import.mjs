// Reads the CSV exports of Simon's yearly spreadsheets (the Einnahmen and
// Ausgaben tables) into entries. No DOM here; node --test checks it.
//
// The tables look like this, with a title row, empty rows and a sum row
// that are skipped:
//   Einnahmen: Datum | Betrag | Beschreibung | Rechnungsnr. | Rechnungsnr. EXTERN | Konto
//   Ausgaben:  Datum | Betrag | Text | Rechnungsnr. | Konto

import { categoryById, categoryId, duplicateKey, newId, parseAmount, parseDate } from "./books.mjs";

/** Rows of cells. Finds the delimiter (; , or tab) and honors quotes. */
export function parseCsv(text) {
  const source = String(text ?? "").replace(/^﻿/, "");
  const delimiter = detectDelimiter(source);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((value) => value.trim()));
}

function detectDelimiter(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 20).join("\n");
  const counts = [";", "\t", ","].map((d) => [d, outsideQuotes(firstLines, d)]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
}

function outsideQuotes(text, delimiter) {
  let quoted = false;
  let count = 0;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === delimiter) count += 1;
  }
  return count;
}

const key = (cell) =>
  String(cell ?? "")
    .toLowerCase()
    .replace(/[^a-zäöüß]/g, "");

const COLUMNS = {
  datum: "date",
  date: "date",
  betrag: "amount",
  amount: "amount",
  text: "text",
  beschreibung: "text",
  description: "text",
  rechnungsnr: "number",
  rechnungsnummer: "number",
  rechnungsnrextern: "external",
  rechnungsnummerextern: "external",
  konto: "account",
};

/** The header row: the first one with Datum and Betrag. */
export function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const keys = rows[i].map(key);
    if (keys.some((k) => COLUMNS[k] === "date") && keys.some((k) => COLUMNS[k] === "amount")) {
      const columns = {};
      keys.forEach((k, index) => {
        const name = COLUMNS[k];
        if (name && columns[name] === undefined) columns[name] = index;
      });
      return { index: i, columns };
    }
  }
  return null;
}

/** income or expense, from the file name, the title row or the columns. */
export function guessKind(rows, header, fileName = "") {
  const name = fileName.toLowerCase();
  if (/einnahm|income/.test(name)) return "income";
  if (/ausgab|expense/.test(name)) return "expense";
  for (const row of rows.slice(0, header?.index ?? 0)) {
    const text = row.join(" ").toLowerCase();
    if (/einnahm/.test(text)) return "income";
    if (/ausgab/.test(text)) return "expense";
  }
  return header?.columns.external !== undefined ? "income" : "expense";
}

/**
 * Entries from one table. For income, Rechnungsnr. is Simon's own running
 * number and Rechnungsnr. EXTERN the payer's; for expenses, Rechnungsnr.
 * is the supplier's invoice number.
 */
export function readTable(text, { kind, fileName = "" } = {}) {
  const rows = parseCsv(text);
  const header = findHeader(rows);
  if (!header) {
    return { kind: kind ?? "expense", rows: [], problems: [{ row: 0, reason: "No header row with Datum and Betrag found." }] };
  }
  const chosen = kind ?? guessKind(rows, header, fileName);
  const c = header.columns;
  const result = { kind: chosen, rows: [], problems: [] };
  for (let i = header.index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((cell) => cell === "")) continue;
    const first = row.find((cell) => cell !== "") ?? "";
    if (/^(summe|gesamt|total)/i.test(first)) continue;
    const cell = (name) => (c[name] === undefined ? "" : (row[c[name]] ?? ""));
    const date = parseDate(cell("date"));
    const amount = parseAmount(cell("amount"));
    if (!date && amount === null && !cell("text")) continue;
    if (!date) {
      result.problems.push({ row: i + 1, reason: `No date: "${cell("date")}"` });
      continue;
    }
    if (amount === null) {
      result.problems.push({ row: i + 1, reason: `No amount: "${cell("amount")}"` });
      continue;
    }
    const account = /^\d+$/.test(cell("account")) ? Number(cell("account")) : null;
    const entry = { kind: chosen, date, amount, text: cell("text"), account };
    if (chosen === "income") {
      entry.number = /^\d+$/.test(cell("number")) ? Number(cell("number")) : null;
      entry.ref = cell("external") || (entry.number === null ? cell("number") : "");
    } else {
      entry.ref = cell("number") || cell("external");
    }
    result.rows.push(entry);
  }
  return result;
}

/**
 * What an import of these tables would add, checked against the data:
 * entries, possible copies of ones already there or in an earlier table of
 * the same import (the same file picked twice, overlapping exports), and
 * accounts that are no category yet. Identical rows within one table are
 * kept: the spreadsheet lists them twice. Nothing changes until applyImport.
 */
export function planImport(data, tables) {
  // An expense made into an asset keeps the key it had as an entry.
  const existing = new Set([...data.entries.map(duplicateKey), ...(data.assets ?? []).map((a) => a.entryKey).filter(Boolean)]);
  const plan = { entries: [], duplicates: [], newAccounts: [], closedYears: [], byYear: new Map() };
  const accounts = new Map();
  for (const table of tables) {
    const accepted = [];
    for (const row of table.rows) {
      const id = row.account === null ? null : categoryId(row.kind, row.account);
      const entry = {
        id: newId(),
        kind: row.kind,
        date: row.date,
        amount: row.amount,
        text: row.text,
        category: id,
        number: row.kind === "income" ? row.number : undefined,
        ref: row.ref || "",
        receipt: null,
        imported: true,
      };
      if (entry.number === undefined) delete entry.number;
      if (existing.has(duplicateKey(entry))) {
        plan.duplicates.push(entry);
        continue;
      }
      const year = Number(entry.date.slice(0, 4));
      if ((data.closed ?? []).includes(year)) {
        if (!plan.closedYears.includes(year)) plan.closedYears.push(year);
        continue;
      }
      if (id && !categoryById(data, id) && !accounts.has(id)) {
        accounts.set(id, { id, kind: row.kind, account: row.account, name: `Konto ${row.account}`, group: null });
      }
      const totals = plan.byYear.get(year) ?? { income: 0, expenses: 0, count: 0 };
      if (entry.kind === "income") totals.income += entry.amount;
      else totals.expenses += entry.amount;
      totals.count += 1;
      plan.byYear.set(year, totals);
      plan.entries.push(entry);
      accepted.push(duplicateKey(entry));
    }
    for (const key of accepted) existing.add(key);
  }
  plan.newAccounts = [...accounts.values()];
  plan.byYear = new Map([...plan.byYear].sort((a, b) => a[0] - b[0]));
  return plan;
}

/** The data with the plan's entries and new accounts added. */
export function applyImport(data, plan) {
  return {
    ...data,
    categories: [...data.categories, ...plan.newAccounts],
    entries: [...data.entries, ...plan.entries],
  };
}
