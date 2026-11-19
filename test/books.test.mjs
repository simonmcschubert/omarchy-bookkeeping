import assert from "node:assert/strict";
import test from "node:test";
import {
  amountText,
  categoryTotals,
  dateText,
  emptyData,
  entryProblems,
  euer,
  euro,
  homeOfficeAmount,
  lineFor,
  nextNumber,
  parseAmount,
  parseDate,
  profitByYear,
  revenueLimit,
  yearTotals,
} from "../app/books.mjs";

const entry = (kind, date, amount, category, extra = {}) => ({ id: `${kind}-${date}-${amount}`, kind, date, amount, text: "x", category, ref: "", receipt: null, ...extra });

// A made-up year in the shape of Simon's spreadsheet: income with running
// numbers, expenses by Konto, and home-office days by activity.
function year2025() {
  const data = emptyData();
  data.entries = [
    entry("income", "2025-01-02", 450, "in-1", { number: 81 }),
    entry("income", "2025-03-10", 25000, "in-3", { number: 82 }),
    entry("income", "2025-11-04", 8000, "in-1", { number: 83 }),
    entry("expense", "2025-01-15", 600, "ex-21"),
    entry("expense", "2025-01-31", 720, "ex-1"),
    entry("expense", "2025-10-17", 1980, "ex-21"),
  ];
  data.homeOffice = { 2025: [{ activity: "Workshop-Vorbereitung", days: 1 }, { activity: "Admin", days: 0 }, { activity: "Websites", days: 1 }] };
  return data;
}

test("amounts in German and English notation", () => {
  assert.equal(parseAmount("5,15 €"), 515);
  assert.equal(parseAmount("1.234,56 €"), 123456);
  assert.equal(parseAmount("1234.56"), 123456);
  assert.equal(parseAmount("1,234.56"), 123456);
  assert.equal(parseAmount("1.200"), 120000);
  assert.equal(parseAmount("12.5"), 1250);
  assert.equal(parseAmount("-5,1"), -510);
  assert.equal(parseAmount("−3,72 €"), -372);
  assert.equal(parseAmount("0"), 0);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("abc"), null);
  assert.equal(euro(123456), "1.234,56 €");
  assert.equal(euro(-515), "−5,15 €");
  assert.equal(euro(2500000, { round: true }), "25.000 €");
  assert.equal(amountText(123456), "1234,56");
});

test("dates", () => {
  assert.equal(parseDate("15.01.2025"), "2025-01-15");
  assert.equal(parseDate("5.1.25"), "2025-01-05");
  assert.equal(parseDate("2025-01-15"), "2025-01-15");
  assert.equal(parseDate("31.02.2025"), null);
  assert.equal(parseDate(""), null);
  assert.equal(dateText("2025-01-15"), "15.01.2025");
});

test("the EÜR: lines, categories, home office, profit", () => {
  const r = euer(year2025(), 2025);
  assert.equal(r.totalIncome, 33450);
  assert.equal(r.totalExpenses, 4500);
  assert.equal(r.profit, 28950);
  const it = r.expenses.find((row) => row.id === "it");
  assert.equal(it.amount, 720);
  assert.deepEqual(it.line, { line: 56, carried: false });
  assert.equal(r.expenses.find((row) => row.id === "telecom").amount, 2580);
  assert.equal(r.income[0].categories.find((c) => c.id === "in-1").amount, 8450);
  assert.equal(r.income[0].categories.find((c) => c.id === "in-3").amount, 25000);
  assert.equal(r.homeOffice.amount, 1200);
  assert.equal(r.homeOffice.days, 2);
});

test("year totals and months", () => {
  const t = yearTotals(year2025(), 2025);
  assert.equal(t.income, 33450);
  assert.equal(t.expenses, 4500);
  assert.equal(t.months[2].income, 25000);
  assert.equal(t.months[0].expenses, 1320);
  assert.equal(t.missingReceipts, 6);
  assert.equal(t.uncategorized, 0);
});

test("entries whose category has no line are listed, not lost", () => {
  const data = year2025();
  data.categories.push({ id: "ex-23", kind: "expense", account: 23, name: "Konto 23", group: null });
  data.entries.push(entry("expense", "2025-05-05", 1000, "ex-23"));
  const r = euer(data, 2025);
  assert.equal(r.unlinked.expense.length, 1);
  assert.equal(r.totalExpenses, 5500);
  assert.equal(yearTotals(data, 2025).uncategorized, 1);
});

test("line numbers carry over to forms without their own", () => {
  const group = { lines: { 2025: 56 } };
  assert.deepEqual(lineFor(group, 2025), { line: 56, carried: false });
  assert.deepEqual(lineFor(group, 2026), { line: 56, carried: true, from: 2025 });
  assert.deepEqual(lineFor(group, 2019), { line: 56, carried: true, from: 2025 });
  assert.equal(lineFor({ lines: {} }, 2025), null);
});

test("home office rates and caps", () => {
  const data = emptyData();
  data.homeOffice = { 2019: [{ activity: "a", days: 10 }], 2021: [{ activity: "a", days: 200 }], 2024: [{ activity: "a", days: 300 }] };
  assert.equal(homeOfficeAmount(data, 2019), 0);
  assert.equal(homeOfficeAmount(data, 2021), 60000);
  assert.equal(homeOfficeAmount(data, 2024), 126000);
});

test("revenue limits by year", () => {
  assert.equal(revenueLimit(2019), 1750000);
  assert.equal(revenueLimit(2024), 2200000);
  assert.equal(revenueLimit(2026), 2500000);
});

test("profit per year fills the years between", () => {
  const data = year2025();
  data.entries.push(entry("income", "2022-06-01", 10000, "in-3", { number: 50 }));
  const rows = profitByYear(data, new Date("2026-11-19"));
  assert.deepEqual(
    rows.map((r) => r.year),
    [2022, 2023, 2024, 2025, 2026],
  );
  assert.equal(rows[0].profit, 10000);
  assert.equal(rows[3].profit, 28950);
});

test("category totals include the home office", () => {
  const rows = categoryTotals(year2025(), 2025, "expense");
  assert.deepEqual(
    rows.map((r) => [r.name, r.amount]),
    [
      ["Domains", 2580],
      ["Home office (Tagespauschale)", 1200],
      ["Software", 720],
    ],
  );
});

test("entries without a category count for their own kind", () => {
  const data = emptyData();
  data.entries = [entry("income", "2025-03-01", 10000, null), entry("expense", "2025-03-02", 2000, null)];
  assert.deepEqual(categoryTotals(data, 2025, "income").map((r) => [r.name, r.amount]), [["No category", 10000]]);
  assert.deepEqual(categoryTotals(data, 2025, "expense").map((r) => [r.name, r.amount]), [["No category", 2000]]);
});

test("next income number and entry checks", () => {
  const data = year2025();
  assert.equal(nextNumber(data), 84);
  assert.deepEqual(entryProblems(data, entry("expense", "2025-02-02", 100, "ex-1")), []);
  assert.ok(entryProblems(data, entry("expense", "2025-02-02", 100, "in-1")).length);
  assert.ok(entryProblems(data, entry("expense", "2025-02-02", 0, "ex-1")).length);
  data.closed = [2025];
  assert.match(entryProblems(data, entry("expense", "2025-02-02", 100, "ex-1"))[0], /closed/);
});
