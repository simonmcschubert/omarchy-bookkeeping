// Assets (Anlagegüter): things bought for the business that serve it for
// more than a year, and what they cost in each year. No DOM here, so
// node --test can check all of it. Amounts are whole cents; dates are ISO
// strings (2025-01-15). See CONTEXT.md for the words used.
//
// An asset owns its purchase: it is no entry, so its price never counts as
// an expense of its own. What counts is its write-off, year by year, and
// when it goes, its remaining book value (an expense) and its price
// (income). The rules, checked against the official texts on 19.11.2026
// (line numbers are those of the 2025 form; in 2026 the expense lines are
// one higher):
//
// Cost. A Kleinunternehmer can't deduct the VAT (Vorsteuer) on purchases,
//   so it is part of the cost (§ 9b Abs. 1 EStG, R 9b Abs. 1 EStR).
//   Whether something is a GWG is still measured on the price without VAT,
//   "Ob der Vorsteuerbetrag umsatzsteuerrechtlich abziehbar ist, spielt in
//   diesem Fall keine Rolle" (R 9b Abs. 2 EStR). So `cost` is what was
//   paid, and `vatRate` (the rate on the invoice) gives the net price.
// The year bought is the year of delivery (§ 9a EStDV, R 7.4 Abs. 1 EStR),
//   not the day of payment: write-offs don't follow the Zuflussprinzip
//   (§ 4 Abs. 3 Satz 3 EStG).
// GWG (§ 6 Abs. 2 EStG): a movable asset that can be used on its own, up to
//   800 € net (410 € when bought before 2018), may be deducted in full in
//   the year bought. On Anlage EÜR line 36; not in Anlage AVEÜR ("In der
//   Anlage AVEÜR erfolgt keine Eintragung der GWG", Anleitung 2025). Over
//   250 € net it belongs in a register (§ 6 Abs. 2 Satz 4): the asset list.
//   Computer accessories such as monitors and printers can't be used on
//   their own, so they are never GWG (H 6.13 EStH: "Peripheriegeräte einer
//   PC-Anlage", BFH 19.02.2004, VI R 135/01). Software up to 800 € counts as
//   a movable asset (R 5.5 Abs. 1 Satz 2 and 3 EStR, 800 € from 2018).
//   Unconfirmed: whether that 800 € is net like the GWG limit; taken as net.
// Computer hardware, its accessories and software, bought from 2021: a
//   useful life of one year (BMF letter of 22.02.2022, BStBl I S. 187,
//   which replaced the one of 26.02.2021), and "Es wird nicht beanstandet,
//   wenn abweichend zu § 7 Absatz 1 Satz 4 EStG die Abschreibung im Jahr
//   der Anschaffung oder Herstellung in voller Höhe vorgenommen wird"
//   (Rz. 1.4): written off in full in the year bought. It is AfA, so on
//   line 33 (software over the GWG limit: line 32) and in Anlage AVEÜR.
// Anything else: AfA in equal yearly amounts over its useful life from the
//   official AfA table (§ 7 Abs. 1 Satz 1 and 2 EStG). In the year bought,
//   one twelfth less for each full month before the month bought (Satz 4):
//   the month bought counts.
// When it goes (sold, scrapped or taken for private use): AfA for the part
//   of the year until then (R 7.4 Abs. 8 EStR), then what is left of the
//   cost (Restbuchwert) is an expense on line 38 (H 4.5 (3) EStH, BFH
//   16.02.1995, IV R 29/94), and the price is income on line 19, also for
//   a Kleinunternehmer: line 12 is "ohne Beträge laut Zeilen 18 bis 22".
//   Taken for private use, the "price" is its value then (Teilwert,
//   Anleitung zu Zeile 19). R 7.4 Abs. 8 doesn't say whether the month it
//   goes counts; here it does, as in the month bought. Either way only
//   moves an amount between lines 33 and 38 of the same year: the profit
//   stays the same.
// Sales of assets don't count for the Kleinunternehmer limit: "Die Umsätze
//   mit Wirtschaftsgütern des Anlagevermögens eines Unternehmers bleiben
//   bei der Ermittlung des Gesamtumsatzes nach Satz 1 außer Ansatz"
//   (§ 19 Abs. 2 UStG, from 2025). Before 2025 the same rule stood in
//   § 19 Abs. 1 Satz 2 UStG (not checked against the old text).
// Left out: the pool for 250 to 1.000 € (Sammelposten, § 6 Abs. 2a EStG).
//   It is a choice per year that would take every asset of 250 to 800 €
//   of that year out of the GWG rule into a pool written off over five
//   years; with GWG up to 800 € and computers in one year, it only helps
//   with other things of 800 to 1.000 €.
// Also left out: the declining-balance AfA for movable assets bought from
//   July 2025 to 2027 (§ 7 Abs. 2 EStG), special AfA (§ 7g), cars, assets
//   brought in from private property (Einlage), and assets partly used
//   privately.

/** The kinds of assets. `group` is their block in Anlage AVEÜR. */
export const ASSET_TYPES = [
  { id: "computer", label: "Computer", hint: "Laptop, desktop, tablet; also an external drive, or a printer that copies on its own", group: "office" },
  { id: "peripheral", label: "Computer accessory", hint: "Monitor, printer, keyboard, mouse, dock, headset, webcam: works only with a computer", group: "office" },
  { id: "software", label: "Software", hint: "Bought to keep, not a subscription (that is an expense: Laufende EDV-Kosten)", group: "intangible" },
  { id: "office", label: "Office furniture and equipment", hint: "Desk, chair, shelf, phone", group: "office" },
  { id: "other", label: "Other", hint: "Photo camera, tools, bicycle", group: "other" },
];

/** Kinds with a useful life of one year from 2021 (BMF, 22.02.2022). */
const ONE_YEAR = ["computer", "peripheral", "software"];

/** Useful lives (years) of common things from the official AfA table for
 *  "allgemein verwendbare Anlagegüter" (BMF, 15.12.2000, BStBl I S. 1532,
 *  still current), with their Fundstelle. A smartphone isn't computer
 *  hardware in the BMF letter's closed list (unconfirmed: it names no
 *  phones), so it takes 6.13.2.2. */
export const LIVES = [
  ["Büromöbel (desk, chair, shelf)", 13, "6.15"],
  ["Mobilfunkendgeräte (mobile phone)", 5, "6.13.2.2"],
  ["Foto-, Film-, Video- und Audiogeräte (camera, speakers, TV)", 7, "6.14.4"],
  ["Kommunikationsendgeräte, allgemein", 8, "6.13.2.1"],
  ["Kopiergeräte", 7, "6.14.10"],
  ["Reißwölfe (shredder)", 8, "6.14.13"],
  ["Klimageräte, mobil", 11, "6.5"],
  ["Motorräder, Motorroller, Fahrräder", 7, "4.2.2"],
  ["Workstations, PCs, Notebooks, Peripherie (bought before 2021)", 3, "6.14.3.2"],
];

/** VAT rates an invoice can show: 16 % and 5 % from July to December 2020. */
export const VAT_RATES = [19, 7, 16, 5, 0];

/** A real day as an ISO date: 2025-01-15, not 2025-13-01. */
export function isDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === iso;
}
const yearOfDate = (iso) => Number(iso.slice(0, 4));
/** A month as one number: year × 12 + month − 1. */
const monthOf = (iso) => yearOfDate(iso) * 12 + Number(iso.slice(5, 7)) - 1;

export function assetType(asset) {
  return ASSET_TYPES.find((t) => t.id === asset.type) ?? ASSET_TYPES.at(-1);
}

/** The GWG limit for the year bought, net (§ 6 Abs. 2 EStG): 800 € for
 *  assets bought from 01.01.2018, 410 € before (footnotes to R 9b Abs. 2
 *  and R 5.5 Abs. 1 EStR). */
export function gwgLimit(year) {
  return year >= 2018 ? 80000 : 41000;
}

/** The cost without the VAT in it, which decides the GWG limit. */
export function netCost(asset) {
  const rate = Number(asset.vatRate) || 0;
  return Math.round((asset.cost * 100) / (100 + rate));
}

/**
 * How an asset is written off (the rules above):
 * - gwg: in full in the year bought, on the GWG line
 * - one-year: in full in the year bought, on an AfA line
 * - linear: the same amount each year over `life` years, by month in the
 *   first year
 * `line` is the id of the Anlage EÜR line the write-off goes on.
 */
export function treatment(asset) {
  const year = yearOfDate(asset.date);
  const type = assetType(asset).id;
  const line = type === "software" ? "afa-intangible" : "afa-movable";
  if (type !== "peripheral" && netCost(asset) <= gwgLimit(year)) return { method: "gwg", life: 0, line: "gwg" };
  if (ONE_YEAR.includes(type) && year >= 2021) return { method: "one-year", life: 1, line };
  return { method: "linear", life: Number(asset.life) || 0, line };
}

/** Written off by the end of a month. */
function writtenOff(asset, how, month) {
  if (month < monthOf(asset.date)) return 0;
  if (how.method !== "linear") return asset.cost;
  const months = how.life * 12;
  const used = Math.min(month - monthOf(asset.date) + 1, months);
  return Math.round((asset.cost * used) / months);
}

/**
 * An asset in a year, or null when it isn't held that year. In Anlage
 * AVEÜR's words: `start` is its book value at the start of the year (0 in
 * the year bought: then it comes in as `added`), `afa` or `gwg` the year's
 * write-off, `remaining` its book value when it goes (Abgang), and `end`
 * its book value at the end of the year. `sale` is its price when it goes.
 */
export function assetInYear(asset, year) {
  const bought = yearOfDate(asset.date);
  const goneYear = asset.disposal ? yearOfDate(asset.disposal.date) : null;
  if (year < bought || (goneYear !== null && year > goneYear)) return null;
  const how = treatment(asset);
  const last = asset.disposal ? monthOf(asset.disposal.date) : Infinity;
  const before = Math.min(year * 12 - 1, last);
  const through = Math.min(year * 12 + 11, last);
  const writeOff = writtenOff(asset, how, through) - writtenOff(asset, how, before);
  const gone = goneYear === year;
  const start = year === bought ? 0 : asset.cost - writtenOff(asset, how, before);
  const added = year === bought ? asset.cost : 0;
  const remaining = gone ? asset.cost - writtenOff(asset, how, last) : 0;
  return {
    asset,
    how,
    start,
    added,
    afa: how.method === "gwg" ? 0 : writeOff,
    gwg: how.method === "gwg" ? writeOff : 0,
    remaining,
    sale: gone ? asset.disposal.price : 0,
    gone,
    end: start + added - writeOff - remaining,
  };
}

/** The years an asset can add something to: from the year bought to the
 *  last of its write-off, or to the year it goes. */
export function assetYears(asset) {
  const how = treatment(asset);
  const first = yearOfDate(asset.date);
  const last = asset.disposal ? yearOfDate(asset.disposal.date) : how.method === "linear" ? first + Math.max(how.life, 0) : first;
  const out = [];
  for (let y = first; y <= last; y++) out.push(y);
  return out;
}

/** Every asset held in a year, and the year's amounts by Anlage EÜR line. */
export function assetsInYear(data, year) {
  const rows = [];
  const lines = { "asset-sales": 0, "afa-intangible": 0, "afa-movable": 0, gwg: 0, "remaining-value": 0 };
  for (const asset of data.assets ?? []) {
    const row = assetInYear(asset, year);
    if (!row) continue;
    rows.push(row);
    lines[row.how.line] += row.afa + row.gwg;
    lines["remaining-value"] += row.remaining;
    lines["asset-sales"] += row.sale;
  }
  rows.sort((a, b) => a.asset.date.localeCompare(b.asset.date) || a.asset.name.localeCompare(b.asset.name));
  const writeOff = lines["afa-intangible"] + lines["afa-movable"] + lines.gwg;
  return { rows, lines, writeOff, expenses: writeOff + lines["remaining-value"], sales: lines["asset-sales"] };
}

/** The years an asset was bought or went in. */
export function assetDates(data) {
  return (data.assets ?? []).flatMap((a) => [yearOfDate(a.date), ...(a.disposal ? [yearOfDate(a.disposal.date)] : [])]);
}

// ---- Anlage AVEÜR

// The blocks of Anlage AVEÜR (Anlageverzeichnis) that assets here go in,
// with the line (Zeile) and code (Kennzahl) of each amount on the 2025
// form (BMF-Schreiben of 29.08.2025, IV C 6 - S 2142/00023/010/001). The
// 2026 form (of 01.09.2026) has the same lines. The
// Anleitung: "Die Anlage AVEÜR ist Bestandteil der Anlage EÜR und mit
// dieser an das Finanzamt zu übermitteln." GWG don't go in it.
export const AVEUR_FORM_YEAR = 2025;
export const AVEUR = [
  {
    id: "intangible",
    label: "Immaterielle Wirtschaftsgüter",
    lines: { cost: [34, 320], start: [35, 321], added: [36, 322], afa: [37, 324], remaining: [38, 325], end: [39, 326] },
  },
  {
    id: "office",
    label: "Bewegliche Wirtschaftsgüter: Büroausstattung",
    lines: { cost: [48, 410], start: [49, 411], added: [50, 412], afa: [52, 414], remaining: [53, 415], end: [54, 416] },
  },
  {
    id: "other",
    label: "Bewegliche Wirtschaftsgüter: Andere",
    lines: { cost: [55, 420], start: [56, 421], added: [57, 422], afa: [59, 424], remaining: [60, 425], end: [61, 426] },
  },
];
/** Line 63 (Kz 490): the AfA of all movable assets, carried to line 33. */
export const AVEUR_MOVABLE_AFA = [63, 490];

/** The labels of the amounts, as on the form. */
export const AVEUR_AMOUNTS = [
  ["cost", "Summe Anschaffungs-/Herstellungskosten/Einlagewerte"],
  ["start", "Summe Buchwerte zu Beginn des Gewinnermittlungszeitraums"],
  ["added", "Summe Zugänge"],
  ["afa", "Summe AfA"],
  ["remaining", "Summe Abgänge"],
  ["end", "Summe Buchwerte am Ende des Gewinnermittlungszeitraums"],
];

/**
 * What goes into Anlage AVEÜR for a year: per block, the cost of the
 * assets held at the start of the year (their historical cost), their book
 * values at the start, the assets bought (Zugänge), the year's AfA, the
 * book values of those gone (Abgänge, also line 38 of Anlage EÜR) and the
 * book values at the end. GWG are left out. Blocks without assets are
 * left out too.
 */
export function aveur(data, year) {
  const blocks = AVEUR.map((block) => ({ ...block, assets: [], cost: 0, start: 0, added: 0, afa: 0, remaining: 0, end: 0 }));
  for (const row of assetsInYear(data, year).rows) {
    if (row.how.method === "gwg") continue;
    const block = blocks.find((b) => b.id === assetType(row.asset).group);
    block.assets.push(row);
    if (row.added === 0) block.cost += row.asset.cost;
    for (const key of ["start", "added", "afa", "remaining", "end"]) block[key] += row[key];
  }
  const used = blocks.filter((b) => b.assets.length);
  return { blocks: used, movableAfa: used.filter((b) => b.id !== "intangible").reduce((t, b) => t + b.afa, 0) };
}

// ---- changes

/**
 * The years in which two versions of an asset (null: none) differ: in the
 * EÜR or in Anlage AVEÜR, which lists an asset (but a GWG) every year it is
 * held, with its cost, even when it is written off. `years` are the ones to look at:
 * by default those either version adds an amount to.
 */
export function changedYears(before, after, years = null) {
  const candidates = years ?? new Set([...(before ? assetYears(before) : []), ...(after ? assetYears(after) : [])]);
  const key = (asset, year) => {
    const row = asset && assetInYear(asset, year);
    if (!row) return "";
    // AVEÜR lists the cost of what was there at the start; GWG not at all.
    const cost = row.added || row.how.method === "gwg" ? 0 : asset.cost;
    return JSON.stringify([row.how.method, row.how.line, assetType(asset).group, cost, row.start, row.added, row.afa, row.gwg, row.remaining, row.sale, row.end]);
  };
  return [...candidates].filter((year) => key(before, year) !== key(after, year)).sort((a, b) => a - b);
}

/** The closed years a change of an asset would alter. */
function closedOf(data, before, after) {
  return changedYears(before, after, data.closed ?? []);
}

const closedText = (years) => `${years.join(", ")}, which ${years.length > 1 ? "are" : "is"} closed`;

/** Problems with an asset before it is saved; empty when fine. `original`
 *  is the saved version when one is changed. */
export function assetProblems(data, asset, original = null) {
  const problems = [];
  if (!String(asset.name ?? "").trim()) problems.push("Say what it is.");
  if (!ASSET_TYPES.some((t) => t.id === asset.type)) problems.push("Choose a kind.");
  const dateOk = isDate(asset.date);
  if (!dateOk) problems.push("Enter the day it came, such as 15.01.2025.");
  if (!Number.isInteger(asset.cost) || asset.cost <= 0) problems.push("Enter what it cost, such as 1299,00.");
  if (!VAT_RATES.includes(asset.vatRate)) problems.push("Choose the VAT rate on the invoice.");
  if (asset.disposal) {
    if (!isDate(asset.disposal.date)) problems.push("Enter the day it went, such as 15.01.2025.");
    else if (dateOk && asset.disposal.date < asset.date) problems.push("It can't go before it came.");
    if (!Number.isInteger(asset.disposal.price) || asset.disposal.price < 0) problems.push("Enter the price it went for: 0 if thrown away.");
  }
  if (problems.length) return problems;
  const how = treatment(asset);
  if (how.method === "linear" && !(Number.isInteger(how.life) && how.life >= 1 && how.life <= 50)) {
    return ["Enter its useful life in whole years, from the AfA table."];
  }
  const closed = closedOf(data, original, asset);
  if (closed.length) problems.push(`This changes ${closedText(closed)}. Reopen it on the EÜR page first.`);
  return problems;
}

/** Problems with deleting an asset; empty when fine. */
export function deleteProblems(data, asset) {
  const closed = closedOf(data, asset, null);
  return closed.length ? [`It counts in ${closedText(closed)}.`] : [];
}
