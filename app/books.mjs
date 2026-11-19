// Bookkeeping: the data and the numbers made from it. No DOM here, so
// node --test can check all of it. Amounts are whole cents; dates are
// ISO strings (2025-01-15). See CONTEXT.md for the words used.

import { assetDates, assetsInYear } from "./assets.mjs";

export const VERSION = 1; // data file version; matches VERSION in server.py

// The yearly revenue a Kleinunternehmer may have had in the year before
// (§ 19 UStG). From 2025 the current year may also not pass 100.000 €.
export function revenueLimit(year) {
  if (year >= 2025) return 2500000;
  if (year >= 2020) return 2200000;
  return 1750000;
}

// The home-office day rate (Tagespauschale) and its yearly cap. Before 2020
// there was none; 2020 to 2022 it was the Homeoffice-Pauschale.
export function homeOfficeRate(year) {
  if (year >= 2023) return { perDay: 600, max: 126000 };
  if (year >= 2020) return { perDay: 500, max: 60000 };
  return null;
}

export const HOME_OFFICE = "home-office";

// Simon's chart of accounts from the 2025 spreadsheet: own accounts
// (Konto) linked to the lines of Anlage EÜR. Line numbers are those of the
// 2025 form. Lines 12 and 66 come from a tax guide, not the spreadsheet:
// check them against the form.
const SEED_GROUPS = [
  ["income", "Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer", 12, "ku-income"],
  ["expense", "Waren, Rohstoffe und Hilfsstoffe einschließlich der Nebenkosten", 26, "goods"],
  ["expense", "Bezogene Leistungen (zum Beispiel Fremdleistungen)", 27, "services"],
  ["expense", "Aufwendungen für Telekommunikation", 49, "telecom"],
  ["expense", "Fortbildungskosten (ohne Reisekosten)", 51, "training"],
  ["expense", "Kosten für Rechts- und Steuerberatung, Buchführung", 52, "advice"],
  ["expense", "Beiträge, Gebühren, Abgaben und Versicherungen", 55, "fees"],
  ["expense", "Laufende EDV-Kosten", 56, "it"],
  ["expense", "Arbeitsmittel (zum Beispiel Bürobedarf, Porto, Fachliteratur)", 57, "supplies"],
  ["expense", "Kosten für Verpackung und Transport", 59, "shipping"],
  ["expense", "Werbekosten (zum Beispiel Inserate, Werbespots, Plakate)", 60, "ads"],
  ["expense", "Tagespauschale für die Tätigkeit in der häuslichen Wohnung", 66, HOME_OFFICE],
];

// The lines the assets' amounts go on (assets.mjs). Their amounts come from
// the assets, so no category links to them. Line numbers from the official
// forms: 2025 (BMF-Schreiben of 29.08.2025) and 2026 (of 01.09.2026), where
// a new line 27 moved the expense lines down by one.
const ASSET_GROUPS = [
  ["income", "Veräußerung oder Entnahme von Anlagevermögen", { 2025: 19, 2026: 19 }, "asset-sales"],
  ["expense", "AfA auf immaterielle Wirtschaftsgüter", { 2025: 32, 2026: 33 }, "afa-intangible"],
  ["expense", "AfA auf bewegliche Wirtschaftsgüter", { 2025: 33, 2026: 34 }, "afa-movable"],
  ["expense", "Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG", { 2025: 36, 2026: 37 }, "gwg"],
  ["expense", "Restbuchwerte der ausgeschiedenen Anlagegüter", { 2025: 38, 2026: 39 }, "remaining-value"],
];

export const ASSET_LINES = ASSET_GROUPS.map(([, , , id]) => id);

/** Lines whose amounts don't come from categories. */
export function isComputedGroup(id) {
  return id === HOME_OFFICE || ASSET_LINES.includes(id);
}

const seedGroup = ([kind, label, line, id]) => ({ id, kind, label, lines: typeof line === "number" ? { [FORM_YEAR]: line } : { ...line } });

const SEED_CATEGORIES = [
  ["income", 1, "Affiliate-Partnerschaft", "ku-income"],
  ["income", 2, "Einnahmen aus Lizenzvertrag", "ku-income"],
  ["income", 3, "Dienstleistungen", "ku-income"],
  ["income", 4, "Sonstige Einnahmen", "ku-income"],
  ["expense", 1, "Software", "it"],
  ["expense", 21, "Domains", "telecom"],
  ["expense", 22, "Internet", "telecom"],
  ["expense", 51, "Online-Kurse", "training"],
  ["expense", 52, "Online-Fortbildung", "training"],
  ["expense", 61, "Buchführung", "advice"],
  ["expense", 71, "IHK-Mitgliedschaft", "fees"],
  ["expense", 72, "Versicherungen", "fees"],
  ["expense", 81, "Fachliteratur", "supplies"],
  ["expense", 82, "Bürobedarf", "supplies"],
  ["expense", 101, "Online-Anzeigen", "ads"],
];

export const FORM_YEAR = 2025; // the form the seeded line numbers belong to

export function categoryId(kind, account) {
  return `${kind === "income" ? "in" : "ex"}-${account}`;
}

export function emptyData() {
  return {
    version: VERSION,
    business: { name: "", address: "", taxNumber: "", iban: "" },
    groups: [...SEED_GROUPS, ...ASSET_GROUPS].map(seedGroup),
    categories: SEED_CATEGORIES.map(([kind, account, name, group]) => ({
      id: categoryId(kind, account),
      kind,
      account,
      name,
      group,
    })),
    entries: [],
    assets: [],
    homeOffice: {},
    filed: {},
    closed: [],
  };
}

/** A data file as this version uses it: files from before the assets get
 *  the asset lines of the EÜR. A missing asset list means none. */
export function upgradeData(data) {
  const missing = ASSET_GROUPS.filter(([, , , id]) => !data.groups.some((g) => g.id === id));
  if (!missing.length) return data;
  return { ...data, groups: [...data.groups, ...missing.map(seedGroup)] };
}

// ---- amounts and dates

const NBSP = /[\s  ]/g;

/** Cents from "1.234,56 €", "1234.56", "-5,15", "5,1". null if no amount. */
export function parseAmount(text) {
  if (typeof text === "number") return Number.isFinite(text) ? Math.round(text * 100) : null;
  let s = String(text ?? "").replace(NBSP, "").replace(/€|EUR/gi, "").replace(/−/g, "-");
  if (!s) return null;
  let sign = 1;
  if (s.startsWith("(") && s.endsWith(")")) [sign, s] = [-1, s.slice(1, -1)];
  if (s.startsWith("-")) [sign, s] = [-sign, s.slice(1)];
  else if (s.startsWith("+")) s = s.slice(1);
  if (s.endsWith("-")) [sign, s] = [-sign, s.slice(0, -1)];
  if (!/^[\d.,']+$/.test(s) || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let decimal = null;
  if (lastComma >= 0 && lastDot >= 0) decimal = lastComma > lastDot ? "," : ".";
  else if (lastComma >= 0) decimal = s.length - lastComma - 1 === 3 && s.indexOf(",") !== lastComma ? null : ",";
  else if (lastDot >= 0) {
    // "1.234" is a thousand in German; "12.5" or "12.50" is a decimal.
    const after = s.length - lastDot - 1;
    decimal = after === 3 ? null : ".";
  }
  let whole = s;
  let fraction = "";
  if (decimal) {
    const at = s.lastIndexOf(decimal);
    whole = s.slice(0, at);
    fraction = s.slice(at + 1);
  }
  whole = whole.replace(/[.,']/g, "");
  if (!/^\d*$/.test(fraction) || !/^\d*$/.test(whole)) return null;
  const cents = Number(whole || "0") * 100 + Math.round(Number(`0.${fraction || "0"}`) * 100);
  return sign * cents;
}

const EURO = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EURO_ROUND = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

/** "1.234,56 €"; whole euros with round: "1.235 €". */
export function euro(cents, { round = false } = {}) {
  const value = (cents ?? 0) / 100;
  return `${(round ? EURO_ROUND : EURO).format(value).replace("-", "−")} €`;
}

/** The amount as typed in a form: "1234,56". */
export function amountText(cents) {
  if (cents == null) return "";
  return EURO.format(cents / 100).replace(/\./g, "");
}

/** ISO date from "15.01.2025", "15.1.25", "2025-01-15". null if none. */
export function parseDate(text) {
  const s = String(text ?? "").trim();
  let y;
  let m;
  let d;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/);
  if (match) [, y, m, d] = match;
  else {
    match = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/);
    if (!match) return null;
    [, d, m, y] = match;
    if (y.length === 2) y = `20${y}`;
  }
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** "15.01.2025" */
export function dateText(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function yearOf(entry) {
  return Number(entry.date.slice(0, 4));
}

export const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

// ---- lookups

export function categoryById(data, id) {
  return data.categories.find((c) => c.id === id) ?? null;
}

export function groupById(data, id) {
  return data.groups.find((g) => g.id === id) ?? null;
}

/** The form line of a group for a year: that year's number, else the one of
 *  the latest earlier form, marked as carried over; null when none. */
export function lineFor(group, year) {
  const lines = group?.lines ?? {};
  if (lines[year] != null) return { line: lines[year], carried: false };
  const earlier = Object.keys(lines)
    .map(Number)
    .filter((y) => y < year)
    .sort((a, b) => b - a);
  if (earlier.length) return { line: lines[earlier[0]], carried: true, from: earlier[0] };
  const later = Object.keys(lines)
    .map(Number)
    .sort((a, b) => a - b);
  if (later.length) return { line: lines[later[0]], carried: true, from: later[0] };
  return null;
}

export function years(data, now = new Date()) {
  const set = new Set(data.entries.map(yearOf));
  set.add(now.getFullYear());
  for (const y of Object.keys(data.homeOffice ?? {})) set.add(Number(y));
  for (const y of assetDates(data)) set.add(y);
  return [...set].sort((a, b) => b - a);
}

export function isClosed(data, year) {
  return (data.closed ?? []).includes(year);
}

export function nextNumber(data) {
  let max = 0;
  for (const entry of data.entries) if (entry.kind === "income" && Number.isInteger(entry.number)) max = Math.max(max, entry.number);
  return max + 1;
}

// ---- home office

export function homeOfficeDays(data, year) {
  return (data.homeOffice?.[year] ?? []).reduce((sum, row) => sum + (Number(row.days) || 0), 0);
}

export function homeOfficeAmount(data, year) {
  const rate = homeOfficeRate(year);
  if (!rate) return 0;
  return Math.min(homeOfficeDays(data, year) * rate.perDay, rate.max);
}

// ---- the numbers of a year

/** Income, expenses and profit of a year, by month and category. Months
 *  and categories hold the entries; the home office and the assets'
 *  amounts count for the whole year. */
export function yearTotals(data, year) {
  const months = Array.from({ length: 12 }, () => ({ income: 0, expenses: 0 }));
  const byCategory = new Map();
  let income = 0;
  let expenses = 0;
  let missingReceipts = 0;
  let uncategorized = 0;
  for (const entry of data.entries) {
    if (yearOf(entry) !== year) continue;
    const month = Number(entry.date.slice(5, 7)) - 1;
    if (entry.kind === "income") {
      income += entry.amount;
      months[month].income += entry.amount;
    } else {
      expenses += entry.amount;
      months[month].expenses += entry.amount;
    }
    // By kind too: entries without a category are income or expenses.
    const key = `${entry.kind}|${entry.category ?? ""}`;
    byCategory.set(key, (byCategory.get(key) ?? 0) + entry.amount);
    if (!entry.receipt) missingReceipts += 1;
    if (!categoryById(data, entry.category)?.group) uncategorized += 1;
  }
  const homeOffice = homeOfficeAmount(data, year);
  const assets = assetsInYear(data, year);
  const allIncome = income + assets.sales;
  const allExpenses = expenses + homeOffice + assets.expenses;
  return {
    year,
    income: allIncome,
    // What counts for the Kleinunternehmer limit: sales of assets don't
    // (§ 19 Abs. 2 UStG, see assets.mjs).
    revenue: income,
    expenses: allExpenses,
    entryExpenses: expenses,
    homeOffice,
    assets: {
      writeOff: assets.writeOff,
      remaining: assets.lines["remaining-value"],
      sales: assets.sales,
      missingReceipts: assets.rows.filter((r) => r.added && !r.asset.receipt).length,
    },
    profit: allIncome - allExpenses,
    months,
    byCategory,
    missingReceipts,
    uncategorized,
  };
}

/** One row per year from the first with data to this year. */
export function profitByYear(data, now = new Date()) {
  const all = years(data, now);
  const first = Math.min(...all);
  const last = Math.max(...all);
  const rows = [];
  for (let year = first; year <= last; year++) {
    const t = yearTotals(data, year);
    rows.push({ year, income: t.income, expenses: t.expenses, profit: t.profit });
  }
  return rows;
}

/** Category totals of a year and kind, largest first. */
export function categoryTotals(data, year, kind) {
  const totals = yearTotals(data, year).byCategory;
  const rows = [];
  for (const [key, amount] of totals) {
    const [entryKind, id] = key.split("|");
    if (entryKind !== kind) continue;
    const category = categoryById(data, id);
    rows.push({ id, name: category ? category.name : "No category", amount });
  }
  const assets = assetsInYear(data, year);
  if (kind === "expense") {
    const homeOffice = homeOfficeAmount(data, year);
    if (homeOffice) rows.push({ id: HOME_OFFICE, name: "Home office (Tagespauschale)", amount: homeOffice });
    if (assets.writeOff) rows.push({ id: "assets", name: "Assets (AfA, GWG)", amount: assets.writeOff });
    const remaining = assets.lines["remaining-value"];
    if (remaining) rows.push({ id: "remaining-value", name: "Assets gone (Restbuchwert)", amount: remaining });
  } else if (assets.sales) {
    rows.push({ id: "asset-sales", name: "Assets sold", amount: assets.sales });
  }
  return rows.sort((a, b) => b.amount - a.amount);
}

// ---- the EÜR

/**
 * The year's Gewinnermittlung nach § 4 Abs. 3 EStG, in the shape of Simon's
 * spreadsheet: for income and expenses, each form line with its categories,
 * in the order of the form. Entries whose category has no line land in
 * `unlinked`, so they are seen. The assets' lines list the assets in place
 * of categories (with no account).
 */
export function euer(data, year) {
  const sides = { income: new Map(), expense: new Map() };
  const unlinked = { income: [], expense: [] };
  for (const group of upgradeData(data).groups) {
    if (group.id === HOME_OFFICE) continue;
    sides[group.kind].set(group.id, { group, line: lineFor(group, year), amount: 0, categories: new Map(), assets: [] });
  }
  for (const entry of data.entries) {
    if (yearOf(entry) !== year) continue;
    const category = categoryById(data, entry.category);
    const row = category && sides[entry.kind].get(category.group);
    if (!row || category.kind !== entry.kind) {
      unlinked[entry.kind].push(entry);
      continue;
    }
    row.amount += entry.amount;
    row.categories.set(category.id, (row.categories.get(category.id) ?? 0) + entry.amount);
  }
  for (const { asset, how, afa, gwg, remaining, sale } of assetsInYear(data, year).rows) {
    const parts = [
      [sides.expense.get(how.line), afa + gwg],
      [sides.expense.get("remaining-value"), remaining],
      [sides.income.get("asset-sales"), sale],
    ];
    for (const [row, amount] of parts) {
      if (!amount) continue;
      row.amount += amount;
      row.assets.push({ id: asset.id, account: null, name: asset.name, amount });
    }
  }
  const byLine = (a, b) => (a.line?.line ?? 1e9) - (b.line?.line ?? 1e9);
  const toRows = (map) =>
    [...map.values()]
      .map((row) => ({
        id: row.group.id,
        label: row.group.label,
        line: row.line,
        amount: row.amount,
        categories: [
          ...data.categories
            .filter((c) => c.group === row.group.id && c.kind === row.group.kind)
            .map((c) => ({ id: c.id, account: c.account, name: c.name, amount: row.categories.get(c.id) ?? 0 })),
          ...row.assets,
        ],
      }))
      .sort(byLine);
  const income = toRows(sides.income);
  const expenses = toRows(sides.expense);
  const homeGroup = groupById(data, HOME_OFFICE);
  const days = homeOfficeDays(data, year);
  const rate = homeOfficeRate(year);
  const homeOffice = {
    label: homeGroup?.label ?? "Tagespauschale für die Tätigkeit in der häuslichen Wohnung",
    line: lineFor(homeGroup, year),
    days,
    rate,
    amount: homeOfficeAmount(data, year),
    capped: rate ? days * rate.perDay > rate.max : false,
  };
  const sum = (rows) => rows.reduce((total, row) => total + row.amount, 0);
  const unlinkedIncome = unlinked.income.reduce((t, e) => t + e.amount, 0);
  const unlinkedExpenses = unlinked.expense.reduce((t, e) => t + e.amount, 0);
  const totalIncome = sum(income) + unlinkedIncome;
  const totalExpenses = sum(expenses) + homeOffice.amount + unlinkedExpenses;
  return {
    year,
    income,
    expenses,
    homeOffice,
    unlinked,
    totalIncome,
    totalExpenses,
    profit: totalIncome - totalExpenses,
    filed: data.filed?.[year] ?? null,
  };
}

// ---- changes (the page applies them, then saves the whole file)

let counter = 0;
export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  counter += 1;
  return `id-${Date.now().toString(36)}-${counter}`;
}

/** Problems with an entry before it is saved; empty when fine. */
export function entryProblems(data, entry) {
  const problems = [];
  if (entry.kind !== "income" && entry.kind !== "expense") problems.push("Choose income or expense.");
  if (!parseDate(entry.date)) problems.push("Enter a date, such as 15.01.2025.");
  if (!Number.isInteger(entry.amount) || entry.amount === 0) problems.push("Enter an amount, such as 12,40.");
  if (!String(entry.text ?? "").trim()) problems.push("Say what it was.");
  const category = categoryById(data, entry.category);
  if (!category) problems.push("Choose a category.");
  else if (category.kind !== entry.kind) problems.push("That category is for the other kind.");
  if (entry.date && parseDate(entry.date) && isClosed(data, Number(entry.date.slice(0, 4)))) {
    problems.push(`${entry.date.slice(0, 4)} is closed. Reopen it on the EÜR page first.`);
  }
  return problems;
}

/** Sorted newest first, income numbers before expenses on the same day. */
export function sortEntries(entries) {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date) || (b.number ?? 0) - (a.number ?? 0) || a.text.localeCompare(b.text));
}

export function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(NBSP, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The key two entries share when one looks like a copy of the other. */
export function duplicateKey(entry) {
  return [entry.kind, entry.date, entry.amount, normalizeText(entry.text)].join("|");
}
