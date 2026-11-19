import assert from "node:assert/strict";
import test from "node:test";
import { assetInYear, assetProblems, assetsInYear, aveur, changedYears, deleteProblems, gwgLimit, netCost, treatment } from "../app/assets.mjs";
import { categoryTotals, emptyData, euer, profitByYear, upgradeData, yearTotals, years } from "../app/books.mjs";
import { planImport } from "../app/import.mjs";

// Made-up assets: amounts in cents, cost as paid (VAT included).
const asset = (fields) => ({ id: fields.name, type: "office", vatRate: 19, life: null, ref: "", receipt: null, disposal: null, ...fields });
const laptop = asset({ name: "Laptop", type: "computer", date: "2025-07-20", cost: 149900 });
const desk = asset({ name: "Desk", type: "office", date: "2025-03-14", cost: 120000, life: 5 });
const chair = asset({ name: "Chair", type: "office", date: "2025-02-01", cost: 59500 });
const app = asset({ name: "Video editor", type: "software", date: "2025-05-05", cost: 119000 });
const monitor = asset({ name: "Monitor", type: "peripheral", date: "2025-05-05", cost: 29900 });

const amounts = (a, year) => {
  const row = assetInYear(a, year);
  return row && { start: row.start, added: row.added, afa: row.afa, gwg: row.gwg, remaining: row.remaining, sale: row.sale, end: row.end };
};

test("the GWG limit is 800 € net, also when the VAT can't be deducted", () => {
  assert.equal(netCost(asset({ date: "2025-01-01", cost: 95200 })), 80000);
  assert.equal(treatment(asset({ date: "2025-01-01", cost: 95200 })).method, "gwg");
  assert.equal(treatment(asset({ date: "2025-01-01", cost: 95201, life: 13 })).method, "linear");
  assert.equal(treatment(asset({ date: "2025-01-01", cost: 85600, vatRate: 7 })).method, "gwg");
  assert.equal(treatment(asset({ date: "2025-01-01", cost: 80000, vatRate: 0 })).method, "gwg");
  assert.equal(treatment(asset({ date: "2025-01-01", cost: 80001, vatRate: 0, life: 13 })).method, "linear");
  // 410 € before 2018
  assert.equal(gwgLimit(2017), 41000);
  assert.equal(treatment(asset({ date: "2017-06-01", cost: 48790 })).method, "gwg");
  assert.equal(treatment(asset({ date: "2017-06-01", cost: 48791, life: 13 })).method, "linear");
  // The deduction is the cost as paid, VAT included.
  assert.deepEqual(amounts(chair, 2025), { start: 0, added: 59500, afa: 0, gwg: 59500, remaining: 0, sale: 0, end: 0 });
  assert.equal(treatment(chair).line, "gwg");
});

test("straight-line AfA by month: the month bought counts", () => {
  // 1.200 € over 5 years = 20 € a month; bought in March: 10 months.
  const afa = [2025, 2026, 2027, 2028, 2029, 2030].map((y) => amounts(desk, y).afa);
  assert.deepEqual(afa, [20000, 24000, 24000, 24000, 24000, 4000]);
  assert.equal(amounts(desk, 2026).start, 100000);
  assert.equal(amounts(desk, 2030).end, 0);
  assert.deepEqual(amounts(desk, 2031), { start: 0, added: 0, afa: 0, gwg: 0, remaining: 0, sale: 0, end: 0 });
  // Cents that don't divide evenly still add up to the cost.
  const odd = asset({ name: "Shelf", date: "2025-07-01", cost: 100000, life: 3 });
  const parts = [2025, 2026, 2027, 2028].map((y) => amounts(odd, y).afa);
  assert.deepEqual(parts, [16667, 33333, 33333, 16667]);
  assert.equal(
    parts.reduce((a, b) => a + b),
    100000,
  );
  assert.equal(assetInYear(desk, 2024), null);
});

test("computers, their accessories and software: in full in the year bought", () => {
  assert.deepEqual(treatment(laptop), { method: "one-year", life: 1, line: "afa-movable" });
  assert.deepEqual(amounts(laptop, 2025), { start: 0, added: 149900, afa: 149900, gwg: 0, remaining: 0, sale: 0, end: 0 });
  assert.equal(amounts(laptop, 2026).afa, 0);
  // Software over the GWG limit is an intangible asset.
  assert.equal(treatment(app).line, "afa-intangible");
  assert.equal(amounts(app, 2025).afa, 119000);
  // A monitor is never a GWG: it works only with a computer.
  assert.equal(treatment(monitor).method, "one-year");
  // A cheap laptop or program that works on its own is a GWG.
  assert.equal(treatment({ ...laptop, cost: 70000 }).method, "gwg");
  assert.equal(treatment({ ...app, cost: 59900 }).method, "gwg");
  // Before 2021: the useful life from the AfA table.
  assert.deepEqual(treatment({ ...laptop, date: "2020-02-01", life: 3 }), { method: "linear", life: 3, line: "afa-movable" });
});

test("when it goes: AfA up to that month, the book value left as an expense, the price as income", () => {
  const sold = { ...desk, disposal: { date: "2027-06-10", price: 30000 } };
  assert.deepEqual(amounts(sold, 2027), { start: 76000, added: 0, afa: 12000, gwg: 0, remaining: 64000, sale: 30000, end: 0 });
  assert.equal(assetInYear(sold, 2028), null);
  assert.deepEqual(amounts({ ...laptop, disposal: { date: "2026-09-01", price: 40000 } }, 2026), { start: 0, added: 0, afa: 0, gwg: 0, remaining: 0, sale: 40000, end: 0 });
  // Thrown away in the year bought: all of it written off, nothing left.
  assert.deepEqual(amounts({ ...chair, disposal: { date: "2025-12-01", price: 0 } }, 2025), { start: 0, added: 59500, afa: 0, gwg: 59500, remaining: 0, sale: 0, end: 0 });
});

function books() {
  const data = emptyData();
  data.entries = [
    { id: "i1", kind: "income", date: "2025-03-10", amount: 500000, text: "Workshop", category: "in-3", number: 1, ref: "", receipt: null },
    { id: "e1", kind: "expense", date: "2025-01-15", amount: 600, text: "Domain", category: "ex-21", ref: "", receipt: null },
  ];
  data.assets = [laptop, desk, chair, app, { ...monitor, disposal: { date: "2026-02-01", price: 5000 } }];
  return data;
}

test("the EÜR: AfA, GWG, book value gone and sales on their own lines", () => {
  const r = euer(books(), 2025);
  const line = (rows, id) => rows.find((row) => row.id === id);
  assert.equal(line(r.expenses, "afa-movable").amount, 149900 + 20000 + 29900);
  assert.deepEqual(line(r.expenses, "afa-movable").line, { line: 33, carried: false });
  assert.equal(line(r.expenses, "afa-intangible").amount, 119000);
  assert.equal(line(r.expenses, "afa-intangible").line.line, 32);
  assert.equal(line(r.expenses, "gwg").amount, 59500);
  assert.equal(line(r.expenses, "gwg").line.line, 36);
  assert.deepEqual(
    line(r.expenses, "afa-movable").categories.map((c) => [c.name, c.account, c.amount]),
    [
      ["Desk", null, 20000],
      ["Monitor", null, 29900],
      ["Laptop", null, 149900],
    ],
  );
  assert.equal(r.totalExpenses, 600 + 149900 + 20000 + 29900 + 119000 + 59500);
  assert.equal(r.profit, 500000 - r.totalExpenses);
  // In the order of the form.
  const numbers = r.expenses.map((row) => row.line?.line);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));

  // 2026: the monitor goes; the desk goes on.
  const r26 = euer(books(), 2026);
  assert.equal(line(r26.income, "asset-sales").amount, 5000);
  assert.equal(line(r26.income, "asset-sales").line.line, 19);
  assert.equal(line(r26.expenses, "remaining-value").amount, 0);
  assert.equal(line(r26.expenses, "afa-movable").amount, 24000);
  assert.equal(line(r26.expenses, "afa-movable").line.line, 34);
  assert.equal(r26.totalIncome, 5000);
});

test("year totals, the Overview and the revenue limit match the EÜR", () => {
  const data = books();
  for (const year of [2025, 2026]) {
    const t = yearTotals(data, year);
    const r = euer(data, year);
    assert.equal(t.income, r.totalIncome);
    assert.equal(t.expenses, r.totalExpenses);
    assert.equal(t.profit, r.profit);
  }
  const t = yearTotals(data, 2026);
  assert.equal(t.assets.sales, 5000);
  assert.equal(t.revenue, 0); // a sold asset doesn't count for § 19 UStG
  assert.equal(t.months.reduce((sum, m) => sum + m.income, 0), 0);
  assert.equal(yearTotals(data, 2025).assets.missingReceipts, 5);
  assert.deepEqual(
    categoryTotals(data, 2025, "expense").map((r) => [r.name, r.amount]),
    [
      ["Assets (AfA, GWG)", 378300],
      ["Domains", 600],
    ],
  );
  assert.deepEqual(categoryTotals(data, 2026, "income"), [{ id: "asset-sales", name: "Assets sold", amount: 5000 }]);
  const rows = profitByYear(data, new Date("2026-11-19"));
  assert.equal(rows.find((r) => r.year === 2025).profit, euer(data, 2025).profit);
});

test("files from before the assets still load", () => {
  const old = emptyData();
  old.groups = old.groups.filter((g) => !["asset-sales", "afa-intangible", "afa-movable", "gwg", "remaining-value"].includes(g.id));
  delete old.assets;
  assert.equal(assetsInYear(old, 2025).rows.length, 0);
  assert.equal(euer(old, 2025).profit, 0);
  const upgraded = upgradeData(old);
  assert.deepEqual(upgraded.groups.find((g) => g.id === "gwg").lines, { 2025: 36, 2026: 37 });
  assert.equal(upgradeData(upgraded), upgraded);
  // An old file with assets but no asset lines still counts them.
  old.assets = [chair];
  assert.equal(euer(old, 2025).expenses.find((r) => r.id === "gwg").amount, 59500);
});

test("the years list holds the years assets came and went", () => {
  const data = emptyData();
  data.assets = [{ ...desk, date: "2023-03-01", disposal: { date: "2024-05-01", price: 0 } }];
  assert.deepEqual(years(data, new Date("2026-11-19")), [2026, 2024, 2023]);
});

test("checks before saving, and closed years", () => {
  const data = books();
  assert.deepEqual(assetProblems(data, desk), []);
  assert.match(assetProblems(data, { ...desk, life: null })[0], /useful life/);
  assert.match(assetProblems(data, { ...desk, vatRate: 12 })[0], /VAT/);
  assert.match(assetProblems(data, { ...desk, disposal: { date: "2024-01-01", price: 0 } })[0], /before/);
  assert.match(assetProblems(data, { ...desk, cost: 0 })[0], /cost/);

  data.closed = [2025];
  // A new asset bought in a closed year, or a change to its numbers there: no.
  assert.match(assetProblems(data, desk)[0], /2025, which is closed/);
  assert.match(assetProblems(data, { ...desk, life: 13 }, desk)[0], /2025/);
  // Its name, its receipt, and how it goes in a later year: yes.
  assert.deepEqual(assetProblems(data, { ...desk, name: "Standing desk" }, desk), []);
  assert.deepEqual(assetProblems(data, { ...desk, disposal: { date: "2027-06-10", price: 30000 } }, desk), []);
  assert.deepEqual(changedYears(desk, { ...desk, disposal: { date: "2027-06-10", price: 30000 } }), [2027, 2028, 2029, 2030]);
  assert.match(deleteProblems(data, desk)[0], /2025/);
  assert.deepEqual(deleteProblems(data, asset({ name: "Later", date: "2026-01-01", cost: 10000 })), []);
});

test("Anlage AVEÜR: AfA assets by block, GWG left out", () => {
  const data = books();
  const r25 = aveur(data, 2025);
  const block = (r, id) => r.blocks.find((b) => b.id === id);
  assert.deepEqual(
    r25.blocks.map((b) => b.id),
    ["intangible", "office"],
  );
  const office = block(r25, "office");
  assert.deepEqual(
    office.assets.map((r) => r.asset.name),
    ["Desk", "Monitor", "Laptop"],
  );
  assert.deepEqual([office.cost, office.start, office.added, office.afa, office.remaining, office.end], [0, 0, 299800, 199800, 0, 100000]);
  assert.deepEqual(office.lines.added, [50, 412]);
  assert.equal(r25.movableAfa, 199800);
  assert.equal(block(r25, "intangible").afa, 119000);

  const office26 = block(aveur(data, 2026), "office");
  // The cost of what was there at the start; the monitor leaves at 0.
  assert.deepEqual([office26.cost, office26.start, office26.added, office26.afa, office26.remaining, office26.end], [299800, 100000, 0, 24000, 0, 76000]);
});

test("an expense made into an asset is not imported again", () => {
  const data = emptyData();
  data.assets = [{ ...laptop, entryKey: "expense|2025-07-20|149900|laptop" }];
  const table = { kind: "expense", rows: [{ kind: "expense", date: "2025-07-20", amount: 149900, text: "Laptop", account: 1, ref: "" }] };
  const plan = planImport(data, [table]);
  assert.equal(plan.entries.length, 0);
  assert.equal(plan.duplicates.length, 1);
});
