import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptyData, euer, lineFor } from "../app/books.mjs";
import { HOME_OFFICE_ACTIVITY, applyImport, findHeader, parseCsv, planChanges, planImport, readFile, readTable } from "../app/import.mjs";

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("CSV with semicolons, quotes and commas", () => {
  assert.deepEqual(parseCsv('a;"b;c";"d ""e"""\r\n1;2;3'), [
    ["a", "b;c", 'd "e"'],
    ["1", "2", "3"],
  ]);
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [
    ["a", "b"],
    ["1", "2"],
  ]);
  assert.deepEqual(parseCsv("﻿Datum\tBetrag\n1\t2"), [
    ["Datum", "Betrag"],
    ["1", "2"],
  ]);
});

test("the header is found under a title row", () => {
  const header = findHeader(parseCsv(fixture("2024-einnahmen.csv")));
  assert.equal(header.index, 1);
  assert.deepEqual(header.columns, { date: 0, amount: 1, text: 2, number: 3, external: 4, account: 5 });
});

test("the income table: own numbers, the payer's numbers, accounts", () => {
  const table = readTable(fixture("2024-einnahmen.csv"));
  assert.equal(table.kind, "income");
  assert.deepEqual(table.problems, []);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[1], { kind: "income", date: "2024-03-15", amount: 120000, text: "Workshop Musterverein", account: 3, number: 72, ref: "RE-2024-17" });
});

test("the expense table: the supplier's invoice number", () => {
  const table = readTable(fixture("2024-ausgaben.csv"));
  assert.equal(table.kind, "expense");
  assert.equal(table.rows.length, 4);
  assert.deepEqual(table.rows[0], { kind: "expense", date: "2024-01-15", amount: 515, text: "Domain example.de", account: 21, ref: "A-1001" });
  assert.equal(table.rows.reduce((t, r) => t + r.amount, 0), 11171);
});

test("the file name decides the table when the columns can't", () => {
  const text = "Datum;Betrag;Text;Konto\n01.01.2020;10,00;x;1\n";
  assert.equal(readTable(text, { fileName: "2020 Einnahmen.csv" }).kind, "income");
  assert.equal(readTable(text, { fileName: "2020-Ausgaben.csv" }).kind, "expense");
  assert.equal(readTable(text, { kind: "income" }).kind, "income");
});

test("rows without a date or amount are reported", () => {
  const table = readTable("Datum;Betrag;Text;Konto\n32.01.2020;10,00;x;1\n01.02.2020;;y;1\n");
  assert.equal(table.rows.length, 0);
  assert.equal(table.problems.length, 2);
  assert.match(table.problems[0].reason, /No date/);
  assert.equal(readTable("a;b\n1;2").problems[0].reason, "No header row with Datum and Betrag found.");
});

test("an import plan: per year, new accounts, copies left out", () => {
  const data = emptyData();
  const tables = [readTable(fixture("2024-einnahmen.csv")), readTable(fixture("2024-ausgaben.csv"))];
  tables[1].rows.push({ kind: "expense", date: "2024-12-01", amount: 999, text: "Unknown", account: 23, ref: "" });
  const plan = planImport(data, tables);
  assert.equal(plan.entries.length, 8);
  assert.deepEqual(plan.byYear.get(2024), { income: 126000, expenses: 12170, count: 8 });
  assert.deepEqual(plan.newAccounts.map((a) => a.id), ["ex-23"]);

  const after = applyImport(data, plan);
  assert.equal(after.entries.length, 8);
  assert.ok(after.categories.some((c) => c.id === "ex-23" && c.group === null));
  assert.ok(after.entries.every((e) => e.imported));

  const again = planImport(after, tables);
  assert.equal(again.entries.length, 0);
  assert.equal(again.duplicates.length, 8);
});

test("the same file picked twice is imported once; repeated rows in one file stay", () => {
  const data = emptyData();
  const table = readTable(fixture("2024-ausgaben.csv"));
  const plan = planImport(data, [table, readTable(fixture("2024-ausgaben.csv"))]);
  assert.equal(plan.entries.length, 4);
  assert.equal(plan.duplicates.length, 4);

  const twice = readTable("Datum;Betrag;Text;Konto\n01.02.2024;3,72;Payout;1\n01.02.2024;3,72;Payout;1\n", { kind: "income" });
  assert.equal(planImport(data, [twice]).entries.length, 2);
});

test("closed years are left out", () => {
  const data = { ...emptyData(), closed: [2024] };
  const plan = planImport(data, [readTable(fixture("2024-ausgaben.csv"))]);
  assert.equal(plan.entries.length, 0);
  assert.deepEqual(plan.closedYears, [2024]);
});

// A year's spreadsheet as Numbers exports it: one file per table, with
// CRLF, no-break spaces before €, an unnamed month column and rows of
// ";0;;;;" below the entries. Made-up numbers.
const EXPORT_2025 = ["Einnahmen-Einnahmen.csv", "Ausgaben-Ausgaben.csv", "Einnahmen-Konten Einnahmen.csv", "Ausgaben-Konten Ausgaben.csv", "Dashboard-Dashboard.csv", "EÜR-EÜR.csv"];
const exported = (pick = 1) => EXPORT_2025.map((name) => readFile(fixture(`numbers-2025/${name}`), { fileName: name, pick }));

test("each file of an export is told by what it holds", () => {
  const [income, expenses, incomeAccounts, expenseAccounts, dashboard, sheet] = exported();
  assert.deepEqual([income.type, income.kind, income.rows.length, income.problems], ["entries", "income", 3, []]);
  assert.deepEqual(income.rows[1], { kind: "income", date: "2025-02-14", amount: 60000, text: "Workshop Musterverein", account: 3, number: 42, ref: "RE-2025-03" });
  assert.deepEqual([expenses.type, expenses.kind, expenses.rows.length, expenses.problems], ["entries", "expense", 3, []]);
  assert.deepEqual([incomeAccounts.type, incomeAccounts.kind, incomeAccounts.accounts.length], ["accounts", "income", 4]);
  assert.deepEqual(incomeAccounts.accounts[0], { kind: "income", account: 1, name: "Affiliate Partnerschaft", line: null, label: "" });
  assert.deepEqual([expenseAccounts.type, expenseAccounts.kind, expenseAccounts.accounts.length, expenseAccounts.lines.length], ["accounts", "expense", 11, 10]);
  assert.deepEqual(expenseAccounts.accounts.find((a) => a.account === 81), { kind: "expense", account: 81, name: "Fachliteratur", line: 57, label: "Arbeitsmittel (zum Beispiel Bürobedarf, Porto, Fachliteratur)" });
  assert.equal(dashboard.type, "dashboard");
  assert.deepEqual(
    { type: sheet.type, year: sheet.year, homeOffice: sheet.homeOffice, income: sheet.income, expenses: sheet.expenses, profit: sheet.profit },
    { type: "euer", year: 2025, homeOffice: 3000, income: 61700, expenses: 6705, profit: 54995 },
  );
  assert.equal(readFile("a;b\n1;2", { fileName: "Notizen.csv" }).type, "other");
});

test("a year's export: its entries, the home office of its EÜR, and a check that matches", () => {
  const data = emptyData();
  const plan = planImport(data, exported());
  assert.equal(plan.entries.length, 6);
  assert.deepEqual(plan.newAccounts, []);
  assert.deepEqual(plan.newLines, []);
  assert.deepEqual(plan.lineNumbers, [], "the 2025 form's numbers are there already");
  assert.deepEqual(plan.homeOffice, [{ year: 2025, days: 5, amount: 3000 }]);
  assert.deepEqual(plan.checks, [{ year: 2025, sheet: { income: 61700, expenses: 6705, profit: 54995 }, books: { income: 61700, expenses: 6705, profit: 54995 }, differs: [] }]);
  assert.deepEqual(plan.notes, []);

  const after = applyImport(data, plan);
  assert.deepEqual(after.homeOffice, { 2025: [{ activity: HOME_OFFICE_ACTIVITY, days: 5 }] });
  assert.equal(euer(after, 2025).profit, 54995);

  // Again: nothing new, and the year still matches.
  const again = planImport(after, exported());
  assert.equal(planChanges(again), false);
  assert.deepEqual(again.checks[0].differs, []);
});

test("the check shows where the books differ from the spreadsheet's EÜR", () => {
  const files = exported();
  files[0].rows.pop(); // an income the export has, but not the books
  const [check] = planImport(emptyData(), files).checks;
  assert.deepEqual(check.differs, ["income", "profit"]);
  assert.equal(check.sheet.income - check.books.income, 1280);
});

test("Konten tables name new accounts and link them to their line; their year's numbers fill the form", () => {
  // A 2023 spreadsheet: other line numbers, and accounts the books don't know.
  const accounts = [
    "Konto;Beschreibung;Zeile Form;Kategorie",
    ";;54;Laufende EDV-Kosten",
    "1;Software;;",
    ";;47;Aufwendungen für Telekommunikation",
    "23;Mobilfunk;;",
    ";;63;Reisekosten (Übernachtung und Reisenebenkosten)",
    "31;Bahntickets;;",
  ].join("\r\n");
  const entries = ["Datum;Betrag;Text;Rechnungsnr.;Konto", "10.02.2023;49,00;Bahn Berlin;B-1;31", "01.03.2023;20,00;Mobilfunk;M-1;23", "02.03.2023;3,00;Hosting;H-1;1"].join("\n");
  const plan = planImport(emptyData(), [
    readFile(accounts, { fileName: "Ausgaben-Konten Ausgaben.csv", pick: 1 }),
    readFile(entries, { fileName: "Ausgaben-Ausgaben.csv", pick: 1 }),
  ]);
  assert.equal(plan.newLines.length, 1);
  const [travel] = plan.newLines;
  assert.deepEqual({ kind: travel.kind, label: travel.label, lines: travel.lines }, { kind: "expense", label: "Reisekosten (Übernachtung und Reisenebenkosten)", lines: { 2023: 63 } });
  assert.deepEqual(plan.newAccounts, [
    { id: "ex-23", kind: "expense", account: 23, name: "Mobilfunk", group: "telecom" },
    { id: "ex-31", kind: "expense", account: 31, name: "Bahntickets", group: travel.id },
  ]);
  assert.deepEqual(
    plan.lineNumbers.map((n) => [n.group, n.year, n.line]),
    [
      ["it", 2023, 54],
      ["telecom", 2023, 47],
    ],
  );

  const after = applyImport(emptyData(), plan);
  const r = euer(after, 2023);
  assert.deepEqual(r.unlinked.expense, []);
  const line = (id) => r.expenses.find((row) => row.id === id);
  assert.deepEqual([line(travel.id).line, line(travel.id).amount], [{ line: 63, carried: false }, 4900]);
  assert.deepEqual(line("it").line, { line: 54, carried: false });
  assert.deepEqual(lineFor(after.groups.find((g) => g.id === "it"), 2025), { line: 56, carried: false }, "other years keep theirs");

  // A year in the file name wins over the pick's; a typed number stays.
  const typed = emptyData();
  typed.groups.find((g) => g.id === "it").lines[2022] = 99;
  const named = planImport(typed, [readFile(accounts, { fileName: "2022 Konten Ausgaben.csv", pick: 1 }), readFile(entries, { fileName: "Ausgaben-Ausgaben.csv", pick: 1 })]);
  assert.deepEqual(
    named.lineNumbers.map((n) => [n.group, n.year, n.line]),
    [["telecom", 2022, 47]],
  );
});

test("an account without a Konten table, or on a line without a label, gets no line", () => {
  const entries = readFile("Datum;Betrag;Text;Konto\n01.03.2023;5,00;x;41\n02.03.2023;6,00;y;42\n", { fileName: "Ausgaben.csv" });
  const accounts = readFile("Konto;Beschreibung;Zeile Form;Kategorie\n;;70;\n42;Sonstiges;;\n", { fileName: "Konten Ausgaben.csv" });
  const plan = planImport(emptyData(), [entries, accounts]);
  assert.deepEqual(plan.newAccounts, [
    { id: "ex-41", kind: "expense", account: 41, name: "Konto 41", group: null },
    { id: "ex-42", kind: "expense", account: 42, name: "Sonstiges", group: null },
  ]);
  assert.deepEqual(plan.newLines, []);
});

test("the home office of an EÜR is left out when the days are there, aren't whole, or the year is closed", () => {
  const sheet = (year, amount) => readFile(`;;Gewinnermittlung;Jahr: ${year}\n;Tagespauschale;;${amount}\n;Summe Einnahmen;;0,00\n;Summe Ausgaben;;${amount}\n;Saldo;;-${amount}\n`, { fileName: "EÜR-EÜR.csv" });

  const typed = { ...emptyData(), homeOffice: { 2024: [{ activity: "Writing", days: 2 }] } };
  const kept = planImport(typed, [sheet(2024, "30,00 €")]);
  assert.deepEqual(kept.homeOffice, []);
  assert.match(kept.notes[0], /^2024: the EÜR page has home-office days already/);
  assert.deepEqual(kept.checks[0].differs, ["expenses", "profit"]);

  const same = planImport(typed, [sheet(2024, "12,00 €")]);
  assert.deepEqual([same.homeOffice, same.notes, same.checks[0].differs], [[], [], []]);

  assert.match(planImport(emptyData(), [sheet(2024, "17,00 €")]).notes[0], /no number of days at 6,00 €/);
  assert.match(planImport(emptyData(), [sheet(2019, "30,00 €")]).notes[0], /no Tagespauschale before 2020/);
  assert.deepEqual(planImport(emptyData(), [sheet(2021, "30,00 €")]).homeOffice, [{ year: 2021, days: 6, amount: 3000 }]);

  // More than the cap: the days come in, the EÜR caps them, the check shows it.
  const over = planImport(emptyData(), [sheet(2025, "1.266,00 €")]);
  assert.deepEqual(over.homeOffice, [{ year: 2025, days: 211, amount: 126600 }]);
  assert.deepEqual([over.checks[0].books.expenses, over.checks[0].differs], [126000, ["expenses", "profit"]]);

  const closed = planImport({ ...emptyData(), closed: [2024] }, [sheet(2024, "30,00 €")]);
  assert.deepEqual([closed.homeOffice, closed.closedYears], [[], [2024]]);

  // A total the EÜR table doesn't have is no match.
  assert.deepEqual(planImport(emptyData(), [readFile(";Jahr: 2024\n;Summe Einnahmen;;0,00\n", { fileName: "EÜR.csv" })]).checks[0].differs, ["expenses", "profit"]);

  const noYear = planImport(emptyData(), [readFile(";Summe Einnahmen;;10,00\n", { fileName: "EÜR.csv" })]);
  assert.deepEqual(noYear.checks, []);
  assert.match(noYear.notes[0], /^EÜR\.csv: no year in it/);
});
