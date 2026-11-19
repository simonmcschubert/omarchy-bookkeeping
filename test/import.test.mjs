import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { emptyData } from "../app/books.mjs";
import { applyImport, findHeader, parseCsv, planImport, readTable } from "../app/import.mjs";

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
