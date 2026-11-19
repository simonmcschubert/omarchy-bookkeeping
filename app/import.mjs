// Reads the CSV exports of Simon's yearly spreadsheets into entries. No DOM
// here; node --test checks it. Numbers writes one file per table (File ›
// Export To › CSV), named <sheet>-<table>.csv; the import tells them apart
// by their columns and rows, not their names:
//
//   Einnahmen, Ausgaben (entries): a title row maybe, the header, the
//     entries, empty rows and a sum row, which are skipped.
//       Einnahmen: Datum | Betrag | Beschreibung | Rechnungsnr. | Rechnungsnr. EXTERN | Konto
//       Ausgaben:  Datum | Betrag | Text | Rechnungsnr. | Konto
//   Konten Einnahmen, Konten Ausgaben (accounts): Konto | Beschreibung,
//     and for expenses Zeile Form | Kategorie: a row with only a form line
//     and its label, then the accounts on that line.
//   EÜR (euer): the year's EÜR, with "Jahr: 2025" in its title row, the
//     Tagespauschale, Summe Einnahmen, Summe Ausgaben and Saldo.
//   Dashboard: the year by month. Not read: the EÜR has the totals.
//
// The files of one pick come from one spreadsheet, so of one year: that of
// its EÜR, else that of its entries, unless a file's name says another.

import {
  MONTHS,
  categoryById,
  categoryId,
  duplicateKey,
  euer,
  euro,
  homeOfficeAmount,
  homeOfficeRate,
  isComputedGroup,
  newId,
  normalizeText,
  parseAmount,
  parseDate,
} from "./books.mjs";

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
    return { type: "entries", kind: kind ?? "expense", rows: [], problems: [{ row: 0, reason: "No header row with Datum and Betrag found." }] };
  }
  return entriesOf(rows, header, kind ?? guessKind(rows, header, fileName));
}

function entriesOf(rows, header, chosen) {
  const c = header.columns;
  const result = { type: "entries", kind: chosen, rows: [], problems: [] };
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
 * Any file of a spreadsheet's export, by what it holds (`type`): entries
 * (an Einnahmen or Ausgaben table), accounts (a Konten table), euer (the
 * EÜR table), dashboard (not read) or other (none of these, left out).
 * `kind` chooses income or expense for entries and accounts; `pick` says
 * which files were picked together.
 */
export function readFile(text, { fileName = "", kind, pick = 0 } = {}) {
  const rows = parseCsv(text);
  const year = yearInName(fileName);
  const about = { fileName, pick, year };
  const header = findHeader(rows);
  if (header) return { ...entriesOf(rows, header, kind ?? guessKind(rows, header, fileName)), ...about };
  const accounts = findAccountsHeader(rows);
  if (accounts) return { ...accountsOf(rows, accounts, kind ?? guessKind(rows, accounts, fileName)), ...about };
  const sheet = euerSheetOf(rows);
  if (sheet) return { ...sheet, ...about, year: sheet.year ?? year };
  const months = rows.filter((row) => MONTHS.includes(row[0])).length;
  return { type: months >= 6 ? "dashboard" : "other", problems: [], ...about };
}

/** A year in a file name, such as "2023 Konten Ausgaben.csv"; null if none. */
function yearInName(fileName) {
  const match = String(fileName ?? "").match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/);
  return match ? Number(match[1]) : null;
}

const ACCOUNT_COLUMNS = {
  konto: "account",
  beschreibung: "name",
  bezeichnung: "name",
  name: "name",
  zeileform: "line",
  zeile: "line",
  kategorie: "label",
};

/** The header row of a Konten table: Konto and Beschreibung, no Datum. */
export function findAccountsHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const names = rows[i].map((cell) => ACCOUNT_COLUMNS[key(cell)]);
    if (!names.includes("account") || !names.includes("name")) continue;
    const columns = {};
    names.forEach((name, index) => {
      if (name && columns[name] === undefined) columns[name] = index;
    });
    return { index: i, columns };
  }
  return null;
}

/** The accounts of a Konten table, each with the form line above it. */
function accountsOf(rows, header, kind) {
  const c = header.columns;
  const result = { type: "accounts", kind, accounts: [], lines: [], problems: [] };
  let line = null;
  for (let i = header.index + 1; i < rows.length; i++) {
    const row = rows[i];
    const cell = (name) => (c[name] === undefined ? "" : (row[c[name]] ?? ""));
    const number = /^\d+$/.test(cell("line")) ? Number(cell("line")) : null;
    if (number !== null || cell("label")) {
      line = { line: number, label: cell("label") };
      result.lines.push(line);
    }
    if (!/^\d+$/.test(cell("account"))) continue;
    result.accounts.push({ kind, account: Number(cell("account")), name: cell("name"), line: line?.line ?? null, label: line?.label ?? "" });
  }
  return result;
}

const SHEET_SUMS = [
  ["income", /^summe einnahmen/],
  ["expenses", /^summe ausgaben/],
  ["profit", /^(saldo|gewinn|verlust)\b/],
];
const SHEET_HOME_OFFICE = /^(tagespauschale|home-?office-?pauschale)/;

/** The EÜR table's year, home office and totals (cents); null if the rows
 *  are no EÜR: one without Summe Einnahmen or Summe Ausgaben. */
function euerSheetOf(rows) {
  const sheet = { type: "euer", year: null, homeOffice: null, income: null, expenses: null, profit: null, problems: [] };
  for (const row of rows) {
    const at = row.findIndex((cell) => cell !== "");
    if (at < 0) continue;
    const year = row.join(" ").match(/\bJahr:?\s*((?:19|20)\d{2})\b/i);
    if (year && sheet.year === null) sheet.year = Number(year[1]);
    const label = normalizeText(row[at]);
    const amounts = row
      .slice(at + 1)
      .map(parseAmount)
      .filter((amount) => amount !== null);
    if (!amounts.length) continue;
    for (const [name, pattern] of SHEET_SUMS) if (sheet[name] === null && pattern.test(label)) sheet[name] = amounts.at(-1);
    if (sheet.homeOffice === null && SHEET_HOME_OFFICE.test(label)) sheet.homeOffice = amounts[0];
  }
  return sheet.income !== null || sheet.expenses !== null ? sheet : null;
}

/** A form line's label for comparing: without its "(zum Beispiel …)". */
const lineKey = (label) =>
  normalizeText(label)
    .replace(/\(zum beispiel[^)]*\)/g, " ")
    .replace(/[^a-z0-9äöüß]+/g, " ")
    .trim();

/** Tables made before readFile (or by hand) are entries. */
const isEntries = (table) => (table.type ?? "entries") === "entries";

/** The year each table is of: its own (EÜR title, file name), else that of
 *  the files picked with it. null when they don't say. */
function yearsOf(tables) {
  const picks = new Map();
  for (const table of tables) {
    const pick = picks.get(table.pick ?? 0) ?? { sheet: null, entries: new Set() };
    if (table.type === "euer" && table.year && !pick.sheet) pick.sheet = table.year;
    if (isEntries(table)) for (const row of table.rows) pick.entries.add(Number(row.date.slice(0, 4)));
    picks.set(table.pick ?? 0, pick);
  }
  return (table) => {
    if (table.year) return table.year;
    const pick = picks.get(table.pick ?? 0);
    return pick.sheet ?? (pick.entries.size === 1 ? [...pick.entries][0] : null);
  };
}

export const HOME_OFFICE_ACTIVITY = "From the spreadsheet";

/**
 * What an import of these tables would add, checked against the data:
 * entries, possible copies of ones already there or in an earlier table of
 * the same import (the same file picked twice, overlapping exports), and
 * accounts that are no category yet, named and linked to their EÜR line by
 * the Konten tables. Also from the Konten tables: the line numbers of their
 * year's form, where the data has none, and lines the data doesn't have
 * yet, for new accounts on them. From the EÜR tables: the home-office days
 * (Tagespauschale ÷ day rate), and a check of each year's totals after the
 * import against the EÜR's. Identical rows within one table are kept: the
 * spreadsheet lists them twice. Nothing changes until applyImport.
 */
export function planImport(data, tables) {
  // An expense made into an asset keeps the key it had as an entry.
  const existing = new Set([...data.entries.map(duplicateKey), ...(data.assets ?? []).map((a) => a.entryKey).filter(Boolean)]);
  const plan = {
    entries: [],
    duplicates: [],
    newAccounts: [],
    newLines: [],
    lineNumbers: [],
    homeOffice: [],
    checks: [],
    notes: [],
    closedYears: [],
    byYear: new Map(),
  };
  const isClosedYear = (year) => (data.closed ?? []).includes(year);
  const leaveOut = (year) => plan.closedYears.includes(year) || plan.closedYears.push(year);
  const yearOf = yearsOf(tables);
  const accountTables = tables.filter((t) => t.type === "accounts");

  // Each account as the Konten tables have it: the newest year's.
  const known = new Map();
  for (const table of accountTables) {
    const year = yearOf(table);
    for (const account of table.accounts) {
      const id = categoryId(account.kind, account.account);
      const before = known.get(id);
      if (!before || (year ?? 0) >= (before.year ?? 0)) known.set(id, { ...account, year });
    }
  }

  const used = new Map(); // accounts of the entries that are no category yet
  for (const table of tables.filter(isEntries)) {
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
      if (isClosedYear(year)) {
        leaveOut(year);
        continue;
      }
      if (id && !categoryById(data, id) && !used.has(id)) used.set(id, row);
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

  // A Konten table's line is the data's line of the same label, or the one
  // with that number in that year's form; else it is new (plan.newLines).
  const groupFor = (kind, line, year) => {
    const label = lineKey(line.label);
    const same = (g) => g.kind === kind && label && lineKey(g.label) === label;
    return (
      data.groups.find(same) ??
      (year && line.line ? data.groups.find((g) => g.kind === kind && g.lines?.[year] === line.line) : null) ??
      plan.newLines.find(same) ??
      null
    );
  };

  for (const [id, row] of used) {
    const account = known.get(id);
    let group = null;
    if (account && (account.label || account.line)) {
      group = groupFor(row.kind, account, account.year);
      if (!group && account.label) {
        group = { id: newId(), kind: row.kind, label: account.label, lines: {} };
        plan.newLines.push(group);
      }
    }
    plan.newAccounts.push({
      id,
      kind: row.kind,
      account: row.account,
      name: account?.name || `Konto ${row.account}`,
      // The home office's and the assets' lines take no categories.
      group: group && !isComputedGroup(group.id) ? group.id : null,
    });
  }

  // Line numbers of a Konten table's year, where that form has none yet.
  for (const table of accountTables) {
    const year = yearOf(table);
    if (!year) continue;
    for (const line of table.lines) {
      const group = line.line && groupFor(table.kind, line, year);
      if (!group || group.lines?.[year] != null) continue;
      if (plan.newLines.includes(group)) group.lines[year] = line.line;
      else if (!plan.lineNumbers.some((n) => n.group === group.id && n.year === year)) {
        plan.lineNumbers.push({ group: group.id, label: group.label, year, line: line.line });
      }
    }
  }

  // The home office of each EÜR table, as days at that year's rate.
  const sheets = new Map();
  for (const table of tables.filter((t) => t.type === "euer")) {
    const year = yearOf(table);
    if (!year) plan.notes.push(`${table.fileName || "An EÜR table"}: no year in it (Jahr: 2025) or in its name, so not read.`);
    else if (!sheets.has(year)) sheets.set(year, table);
  }
  for (const [year, sheet] of sheets) {
    const amount = sheet.homeOffice;
    if (!amount || homeOfficeAmount(data, year) === amount) continue;
    const rate = homeOfficeRate(year);
    if (isClosedYear(year)) leaveOut(year);
    else if (data.homeOffice?.[year]?.length) {
      plan.notes.push(`${year}: the EÜR page has home-office days already, so the Tagespauschale of the EÜR table (${euro(amount)}) is left out.`);
    } else if (!rate) plan.notes.push(`${year}: no Tagespauschale before 2020, so the EÜR table's ${euro(amount)} is left out.`);
    else if (amount % rate.perDay !== 0) {
      plan.notes.push(`${year}: the Tagespauschale of the EÜR table (${euro(amount)}) is no number of days at ${euro(rate.perDay)}, so it is left out: add the days on the EÜR page.`);
    } else plan.homeOffice.push({ year, days: amount / rate.perDay, amount });
  }

  plan.newAccounts.sort((a, b) => a.kind.localeCompare(b.kind) || a.account - b.account);
  plan.homeOffice.sort((a, b) => a.year - b.year);
  plan.byYear = new Map([...plan.byYear].sort((a, b) => a[0] - b[0]));

  // Each EÜR table's totals against the year's after the import.
  const after = applyImport(data, plan);
  for (const [year, sheet] of [...sheets].sort((a, b) => a[0] - b[0])) {
    const r = euer(after, year);
    const books = { income: r.totalIncome, expenses: r.totalExpenses, profit: r.profit };
    // A total the EÜR table doesn't have (null) differs too.
    const differs = ["income", "expenses", "profit"].filter((name) => sheet[name] !== books[name]);
    plan.checks.push({ year, sheet: { income: sheet.income, expenses: sheet.expenses, profit: sheet.profit }, books, differs });
  }
  return plan;
}

/** Whether the plan changes anything. */
export function planChanges(plan) {
  return plan.entries.length + plan.lineNumbers.length + plan.homeOffice.length > 0;
}

/** The data with the plan's entries, accounts, lines and home office added. */
export function applyImport(data, plan) {
  const groups = data.groups.map((group) => {
    const numbers = plan.lineNumbers.filter((n) => n.group === group.id);
    if (!numbers.length) return group;
    return { ...group, lines: { ...group.lines, ...Object.fromEntries(numbers.map((n) => [n.year, n.line])) } };
  });
  const homeOffice = { ...(data.homeOffice ?? {}) };
  for (const { year, days } of plan.homeOffice) homeOffice[year] = [{ activity: HOME_OFFICE_ACTIVITY, days }];
  return {
    ...data,
    groups: [...groups, ...plan.newLines.map((group) => ({ ...group, lines: { ...group.lines } }))],
    categories: [...data.categories, ...plan.newAccounts],
    entries: [...data.entries, ...plan.entries],
    homeOffice,
  };
}
