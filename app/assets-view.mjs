// Bookkeeping: the Assets view, and the asset parts of the EÜR page. Drawn
// by app.mjs, which passes in its helpers (`ui`). The numbers come from
// assets.mjs.

import {
  ASSET_TYPES,
  AVEUR_AMOUNTS,
  AVEUR_MOVABLE_AFA,
  LIVES,
  VAT_RATES,
  assetInYear,
  assetProblems,
  assetType,
  assetYears,
  assetsInYear,
  aveur,
  deleteProblems,
  gwgLimit,
  isDate,
  netCost,
  treatment,
} from "./assets.mjs";
import { amountText, dateText, duplicateKey, euro, groupById, isClosed, lineFor, newId, parseAmount, parseDate } from "./books.mjs";

// The asset in the form: a copy with the typed text, `isNew` when new.
let draft = null;
let problems = [];
let show = "year"; // "year": the assets held in the selected year; "all"

/** Opens the form for a new asset, filled from an expense entry that is
 *  one: saving the asset takes the entry out, so the price counts once. */
export function startAssetFromEntry(entry, isNew) {
  draft = {
    isNew: true,
    id: newId(),
    name: entry.text ?? "",
    type: "computer",
    date: entry.date ?? "",
    cost: entry.amount ?? "",
    vatRate: 19,
    life: "",
    ref: entry.ref ?? "",
    receipt: entry.receipt ?? null,
    goneDate: "",
    gonePrice: "",
    fromEntry: isNew ? null : entry.id,
  };
  problems = [];
  show = "all";
}

function startAsset(ui) {
  const year = ui.state.year;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  draft = {
    isNew: true,
    id: newId(),
    name: "",
    type: "computer",
    date: year === now.getFullYear() ? today : `${year}-12-31`,
    cost: "",
    vatRate: 19,
    life: "",
    ref: "",
    receipt: null,
    goneDate: "",
    gonePrice: "",
  };
  problems = [];
  ui.render();
  document.querySelector(".editor input[name=name]")?.focus();
}

function editAsset(ui, asset) {
  draft = {
    ...structuredClone(asset),
    life: asset.life ?? "",
    goneDate: asset.disposal?.date ?? "",
    gonePrice: asset.disposal ? asset.disposal.price : "",
  };
  problems = [];
  ui.render();
}

/** The asset the form describes, with what was typed read as amounts and
 *  dates (left as typed when it can't be read, for assetProblems). */
function fromDraft(d) {
  const amount = (value) => (typeof value === "number" ? value : parseAmount(value));
  const date = (value) => parseDate(value) ?? String(value ?? "").trim();
  const life = Number(String(d.life).trim());
  const asset = {
    id: d.id,
    name: String(d.name ?? "").trim(),
    type: d.type,
    date: date(d.date),
    cost: amount(d.cost),
    vatRate: Number(d.vatRate),
    life: String(d.life).trim() && Number.isFinite(life) ? life : null,
    ref: String(d.ref ?? "").trim(),
    receipt: d.receipt ?? null,
    disposal: null,
  };
  const goneDate = String(d.goneDate ?? "").trim();
  const gonePrice = String(d.gonePrice ?? "").trim();
  if (goneDate || gonePrice) asset.disposal = { date: date(goneDate), price: gonePrice ? amount(gonePrice) : 0 };
  if (d.entryKey) asset.entryKey = d.entryKey;
  return asset;
}

function cancel(ui) {
  draft = null;
  problems = [];
  ui.render();
}

function save(ui) {
  const asset = fromDraft(draft);
  const original = ui.state.data.assets?.find((a) => a.id === asset.id) ?? null;
  problems = assetProblems(ui.state.data, asset, original);
  // The expense it replaces, as saved: it must still be there and open, and
  // it keeps its key, so importing its row again doesn't bring it back.
  const source = draft.fromEntry ? ui.state.data.entries.find((e) => e.id === draft.fromEntry) : null;
  if (draft.fromEntry && !source) problems.push("The expense entry it came from is gone.");
  else if (source && isClosed(ui.state.data, Number(source.date.slice(0, 4)))) problems.push(`The expense entry is in ${source.date.slice(0, 4)}, which is closed.`);
  else if (source) asset.entryKey = duplicateKey(source);
  if (problems.length) {
    ui.render();
    return;
  }
  const fromEntry = draft.fromEntry;
  draft = null;
  ui.change((data) => {
    data.assets ??= [];
    const at = data.assets.findIndex((a) => a.id === asset.id);
    if (at >= 0) data.assets[at] = asset;
    else data.assets.push(asset);
    if (fromEntry) data.entries = data.entries.filter((e) => e.id !== fromEntry);
  });
  ui.toast(fromEntry ? "Saved as an asset; the expense entry is gone" : "Saved");
}

function remove(ui, id) {
  const asset = ui.state.data.assets.find((a) => a.id === id);
  if (!asset) return;
  const blocked = deleteProblems(ui.state.data, asset);
  if (blocked.length) {
    problems = blocked;
    ui.render();
    return;
  }
  if (!confirm(`Delete "${asset.name}" (${euro(asset.cost)})?`)) return;
  draft = null;
  ui.change((data) => {
    data.assets = data.assets.filter((a) => a.id !== id);
  });
  ui.toast("Deleted");
}

// ---- words for the numbers

function methodText(how) {
  if (how.method === "gwg") return "GWG";
  if (how.method === "one-year") return "AfA, 1 year";
  return `AfA, ${how.life} years`;
}

function lineText(data, id, year) {
  const line = lineFor(groupById(data, id), year);
  return line ? `line ${line.line}` : "no line";
}

/** What the form's asset adds to the EÜR, year by year, in words. */
function preview(data, d) {
  const asset = fromDraft(d);
  if (!isDate(asset.date) || !Number.isInteger(asset.cost) || asset.cost <= 0) {
    return "Enter the date and the cost to see how it is written off.";
  }
  const how = treatment(asset);
  const year = Number(asset.date.slice(0, 4));
  const net = netCost(asset);
  const lines = [];
  if (how.method === "gwg") {
    lines.push(`GWG: ${euro(asset.cost)} in full in ${year}, Anlage EÜR ${lineText(data, "gwg", year)}. Net ${euro(net)} is not over ${euro(gwgLimit(year), { round: true })}.`);
  } else if (how.method === "one-year") {
    lines.push(
      `AfA over one year: ${euro(asset.cost)} in full in ${year}, Anlage EÜR ${lineText(data, how.line, year)}, and in Anlage AVEÜR.` +
        (assetType(asset).id === "peripheral" ? " Never a GWG: it works only with a computer." : ` Net ${euro(net)} is over the GWG limit of ${euro(gwgLimit(year), { round: true })}.`),
    );
  } else if (!(how.life >= 1 && how.life <= 50)) {
    lines.push(`Net ${euro(net)} is over the GWG limit of ${euro(gwgLimit(year), { round: true })}: enter its useful life from the AfA table to spread it over the years.`);
  } else {
    const parts = assetYears(asset)
      .map((y) => [y, assetInYear(asset, y)])
      .filter(([, row]) => row && row.afa)
      .map(([y, row]) => `${y}: ${euro(row.afa)}`);
    const shown = parts.length > 6 ? [...parts.slice(0, 3), "…", ...parts.slice(-2)] : parts;
    lines.push(`AfA over ${how.life} years, Anlage EÜR ${lineText(data, how.line, year)}: ${shown.join(" · ")}.`);
  }
  if (asset.disposal && isDate(asset.disposal.date) && Number.isInteger(asset.disposal.price) && asset.disposal.date >= asset.date) {
    const goneYear = Number(asset.disposal.date.slice(0, 4));
    const row = assetInYear(asset, goneYear);
    lines.push(
      `Gone in ${goneYear}: remaining book value ${euro(row.remaining)} as an expense (${lineText(data, "remaining-value", goneYear)}), price ${euro(row.sale)} as income (${lineText(data, "asset-sales", goneYear)}).`,
    );
  }
  return lines.join(" ");
}

// ---- the form

function editor(ui) {
  const { h } = ui;
  const d = draft;
  const data = ui.state.data;
  const previewBox = h("p", { class: "preview", text: preview(data, d) });
  const refresh = () => (previewBox.textContent = preview(data, d));
  const set = (key) => (event) => {
    d[key] = event.target.value;
    refresh();
  };
  const type = ASSET_TYPES.find((t) => t.id === d.type);
  const receipt = d.receipt
    ? h(
        "span",
        { class: "receipt" },
        h("a", { href: `/api/receipts/${d.receipt.file}`, target: "_blank", rel: "noopener", text: d.receipt.name }),
        h("button", { type: "button", class: "link danger", onclick: () => ((d.receipt = null), ui.render()) }, "Remove"),
      )
    : h("input", {
        type: "file",
        accept: ".pdf,.jpg,.jpeg,.png,.webp,.xml",
        onchange: async (event) => {
          const file = event.target.files[0];
          if (!file) return;
          try {
            d.receipt = await ui.uploadReceipt(file);
            ui.render();
          } catch (error) {
            ui.toast(`Receipt not saved: ${error.message}`, "bad");
          }
        },
      });
  const dateValue = (value) => dateText(parseDate(value) ?? "") || value;
  const amountValue = (value) => (typeof value === "number" ? amountText(value) : (value ?? ""));
  return h(
    "form",
    {
      class: "editor",
      onsubmit: (event) => {
        event.preventDefault();
        save(ui);
      },
      onkeydown: (event) => event.key === "Escape" && cancel(ui),
    },
    h("div", { class: "editor-head" }, h("h3", { text: d.isNew ? "New asset" : "Edit asset" })),
    d.fromEntry ? h("p", { class: "muted small", text: "From an expense entry: saving the asset takes that entry out, so the price counts once, as AfA or GWG." }) : null,
    h(
      "div",
      { class: "form-grid" },
      h("label", { class: "wide" }, "What", h("input", { name: "name", value: d.name, placeholder: "Laptop", oninput: set("name"), required: true })),
      h(
        "label",
        { class: "wide" },
        "Kind",
        h(
          "select",
          { name: "type", onchange: (event) => ((d.type = event.target.value), ui.render()) },
          ASSET_TYPES.map((t) => h("option", { value: t.id, selected: t.id === d.type, text: t.label })),
        ),
        type ? h("span", { class: "sub", text: type.hint }) : null,
      ),
      h("label", {}, "Bought (delivered)", h("input", { name: "date", value: dateValue(d.date), placeholder: "TT.MM.JJJJ", oninput: set("date"), required: true })),
      h("label", {}, "Cost (€), as paid", h("input", { name: "cost", inputmode: "decimal", value: amountValue(d.cost), placeholder: "1299,00", oninput: set("cost"), required: true })),
      h(
        "label",
        {},
        "VAT on the invoice",
        h(
          "select",
          { name: "vatRate", onchange: set("vatRate") },
          VAT_RATES.map((rate) => h("option", { value: rate, selected: Number(d.vatRate) === rate, text: rate ? `${rate} %${rate === 16 || rate === 5 ? " (07–12/2020)" : ""}` : "None (private seller, abroad)" })),
        ),
      ),
      h(
        "label",
        {},
        "Useful life (years)",
        h("input", { name: "life", type: "number", min: 1, max: 50, list: "afa-lives", value: d.life ?? "", placeholder: "AfA table", oninput: set("life") }),
        h("datalist", { id: "afa-lives" }, LIVES.map(([label, years, ref]) => h("option", { value: years, label: `${label}: AfA-Tabelle ${ref}` }))),
      ),
      h("label", {}, "Invoice no.", h("input", { name: "ref", value: d.ref ?? "", oninput: set("ref") })),
      h("label", { class: "wide" }, "Receipt", receipt),
      h("label", {}, "Gone on (sold, thrown away)", h("input", { name: "goneDate", value: dateValue(d.goneDate), placeholder: "TT.MM.JJJJ", oninput: set("goneDate") })),
      h("label", {}, "Price it went for (€)", h("input", { name: "gonePrice", inputmode: "decimal", value: amountValue(d.gonePrice), placeholder: "0 if thrown away", oninput: set("gonePrice") })),
    ),
    previewBox,
    problems.length ? h("ul", { class: "problems" }, problems.map((p) => h("li", { text: p }))) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "primary", type: "submit" }, "Save"),
      h("button", { type: "button", onclick: () => cancel(ui) }, "Cancel"),
      d.isNew ? null : h("button", { type: "button", class: "danger push", onclick: () => remove(ui, d.id) }, "Delete"),
    ),
  );
}

// ---- the view

/** The Assets view: the asset list (Anlageverzeichnis) with each asset's
 *  write-off in the selected year. */
export function drawAssets(ui) {
  const { h, card, state } = ui;
  const year = state.year;
  const data = state.data;
  const all = data.assets ?? [];
  const listed = [...all]
    .filter((a) => show === "all" || assetInYear(a, year))
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  const toolbar = h(
    "div",
    { class: "toolbar" },
    ui.segmented(
      [
        ["year", `Held in ${year}`],
        ["all", "All"],
      ],
      show,
      (value) => {
        show = value;
        ui.render();
      },
    ),
    h("span", { class: "spacer" }),
    h("button", { class: "primary", onclick: () => startAsset(ui) }, "+ Asset"),
  );
  const editingId = draft && !draft.isNew ? draft.id : null;
  const rows = listed.map((asset) => {
    if (asset.id === editingId) return h("tr", { class: "editing" }, h("td", { colspan: 7 }, editor(ui)));
    const how = treatment(asset);
    const row = assetInYear(asset, year);
    const type = assetType(asset);
    return h(
      "tr",
      { class: `entry clickable ${row ? "" : "dim"}`, onclick: () => editAsset(ui, asset) },
      h("td", { class: "nowrap", text: dateText(asset.date) }),
      h("td", {}, asset.name, h("span", { class: "sub", text: [type.label, asset.ref ? `Invoice ${asset.ref}` : null].filter(Boolean).join(" · ") })),
      h("td", { class: "num" }, euro(asset.cost), asset.vatRate ? h("span", { class: "sub", text: `net ${euro(netCost(asset))}` }) : null),
      // The line of the form the write-off is on: this year's, else the year bought.
      h("td", {}, methodText(how), h("span", { class: "sub", text: lineText(data, how.line, row && row.afa + row.gwg ? year : Number(asset.date.slice(0, 4))) })),
      h(
        "td",
        { class: "num" },
        row ? euro(row.afa + row.gwg) : h("span", { class: "muted", text: "–" }),
        row?.gone ? h("span", { class: "sub", text: `gone ${dateText(asset.disposal.date)}: ${euro(row.remaining)} book value, ${euro(row.sale)} price` }) : null,
      ),
      h("td", { class: "num" }, row ? euro(row.end) : h("span", { class: "muted", text: "–" }), !row && asset.disposal ? h("span", { class: "sub", text: `gone ${dateText(asset.disposal.date)}` }) : null),
      h("td", { class: "nowrap" }, receiptLink(h, asset)),
    );
  });
  const totals = assetsInYear(data, year);
  const endValue = totals.rows.reduce((t, r) => t + r.end, 0);
  const table = listed.length
    ? h(
        "table",
        { class: "entries assets" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", { text: "Bought" }),
            h("th", { text: "What" }),
            h("th", { class: "num", text: "Cost" }),
            h("th", { text: "Written off as" }),
            h("th", { class: "num", text: `AfA, GWG ${year}` }),
            h("th", { class: "num", text: `Book value 31.12.${year}` }),
            h("th", { text: "Receipt" }),
          ),
        ),
        h("tbody", {}, rows),
        h(
          "tfoot",
          {},
          h(
            "tr",
            {},
            h("td", { colspan: 4, class: "muted", text: `${totals.rows.length} held in ${year}` }),
            h("td", { class: "num" }, euro(totals.writeOff), totals.lines["remaining-value"] ? h("span", { class: "sub", text: `+ ${euro(totals.lines["remaining-value"])} book value gone` }) : null),
            h("td", { class: "num", text: euro(endValue) }),
            h("td"),
          ),
        ),
      )
    : h("p", { class: "muted", text: all.length ? `No assets held in ${year}.` : "No assets yet. Add one, or open an expense entry and choose Make it an asset." });
  return [
    card(null, toolbar, draft?.isNew ? editor(ui) : null, problems.length && !draft ? h("ul", { class: "problems" }, problems.map((p) => h("li", { text: p }))) : null, table),
    card(
      "How assets are written off",
      h(
        "ul",
        { class: "rules" },
        h("li", { text: "An asset is something bought for the business that lasts more than a year. Enter it here, not as an expense: its cost counts as AfA or GWG instead. Up to 250 € net, a plain expense entry is fine too." }),
        h("li", { text: "The cost is what you paid, VAT included: as a Kleinunternehmer you can't deduct the VAT (§ 9b EStG). The 800 € GWG limit is still measured without VAT (R 9b Abs. 2 EStR): 952,00 € with 19 % VAT is 800,00 € net." }),
        h("li", { text: "Up to 800 € net, and usable on its own: a GWG, deducted in full in the year bought (§ 6 Abs. 2 EStG). Not in Anlage AVEÜR." }),
        h("li", { text: "Computers, their accessories and software, bought from 2021: one year of useful life, deducted in full in the year bought (BMF, 22.02.2022). Listed in Anlage AVEÜR." }),
        h("li", { text: "Anything else: AfA over its useful life from the official AfA table, by month in the first year: bought in March, 10/12 of a year's share (§ 7 Abs. 1 EStG)." }),
        h("li", { text: "When it goes: the AfA up to that month, then the book value left is an expense and the price is income. Sold assets don't count for the Kleinunternehmer limit (§ 19 Abs. 2 UStG)." }),
      ),
    ),
  ];
}

function receiptLink(h, asset) {
  if (asset.receipt) return h("a", { href: `/api/receipts/${asset.receipt.file}`, target: "_blank", rel: "noopener", title: asset.receipt.name, onclick: (e) => e.stopPropagation(), text: asset.receipt.file.split(".").pop().toUpperCase() });
  return h("span", { class: "muted", text: "–" });
}

// ---- on the EÜR page

/** Anlage AVEÜR for the year: what to type into each line. */
export function aveurCard(ui) {
  const { h, card, state } = ui;
  const year = state.year;
  const result = aveur(state.data, year);
  const afaLine = lineFor(groupById(state.data, "afa-movable"), year);
  const formNote = year === 2025 || year === 2026 ? null : h("p", { class: "risk-text small", text: `Line numbers of the 2025 and 2026 forms: check them against the ${year} form.` });
  if (!result.blocks.length) {
    return card(
      `Anlage AVEÜR ${year}`,
      h("p", { class: "muted", text: `Nothing to enter: no assets with AfA in ${year}. GWG don't go in it.` }),
    );
  }
  const rows = [];
  for (const block of result.blocks) {
    rows.push(h("tr", { class: "section" }, h("th", { colspan: 4, text: block.label })));
    for (const [key, label] of AVEUR_AMOUNTS) {
      const [line, code] = block.lines[key];
      const amount = block[key];
      rows.push(
        h(
          "tr",
          { class: amount ? "group" : "muted-row" },
          h("td", { class: "line", text: line }),
          h("td", { class: "line", text: code }),
          h("td", {}, label, key === "remaining" ? h("span", { class: "sub", text: "also in Anlage EÜR as Restbuchwerte" }) : null),
          h("td", { class: "num", text: amount ? euro(amount) : "–" }),
        ),
      );
    }
  }
  if (result.blocks.some((b) => b.id !== "intangible")) {
    rows.push(
      h(
        "tr",
        { class: "total" },
        h("td", { class: "line", text: AVEUR_MOVABLE_AFA[0] }),
        h("td", { class: "line", text: AVEUR_MOVABLE_AFA[1] }),
        h("td", { text: `Summe AfA aller beweglichen Wirtschaftsgüter${afaLine ? ` (Anlage EÜR line ${afaLine.line})` : ""}` }),
        h("td", { class: "num", text: euro(result.movableAfa) }),
      ),
    );
  }
  return h(
    "section",
    { class: "card print-break" },
    h("h2", { text: `Anlage AVEÜR ${year}` }),
    h("p", { class: "muted small", text: "Part of the EÜR whenever there is AfA: in ELSTER, add Anlage AVEÜR and type these in. Leave the other lines empty. GWG don't go in it." }),
    formNote,
    h("table", { class: "euer aveur" }, h("thead", {}, h("tr", {}, h("th", { class: "line", text: "Line" }), h("th", { class: "line", text: "Kz" }), h("th", { text: "" }), h("th", { class: "num", text: "Amount" }))), h("tbody", {}, rows)),
  );
}

/** The year's asset list on paper: the Anlageverzeichnis behind the
 *  EÜR (§ 4 Abs. 3 Satz 5 EStG, R 4.5 Abs. 3 EStR) and the GWG register
 *  (§ 6 Abs. 2 Satz 4 EStG). */
export function printAssets(ui) {
  const { h, state } = ui;
  const year = state.year;
  const { rows } = assetsInYear(state.data, year);
  if (!rows.length) return null;
  const sum = (key) => rows.reduce((t, r) => t + r[key], 0);
  const how = (r) => (r.how.method === "gwg" ? "GWG" : r.how.method === "one-year" ? "AfA, ND 1 Jahr" : `AfA, ND ${r.how.life} Jahre`);
  return h(
    "section",
    { class: "print-only" },
    h("h2", { text: `Anlageverzeichnis ${year}` }),
    h(
      "table",
      { class: "compact" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { text: "Angeschafft" }),
          h("th", { text: "Bezeichnung" }),
          h("th", { class: "num", text: "AK (brutto)" }),
          h("th", { text: "Abschreibung" }),
          h("th", { class: "num", text: "Buchwert 1.1." }),
          h("th", { class: "num", text: "Zugang" }),
          h("th", { class: "num", text: "AfA/GWG" }),
          h("th", { class: "num", text: "Abgang" }),
          h("th", { class: "num", text: "Buchwert 31.12." }),
          h("th", { text: "Ausgeschieden" }),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map((r) =>
          h(
            "tr",
            {},
            h("td", { text: dateText(r.asset.date) }),
            h("td", { text: [r.asset.name, r.asset.ref ? `(Rechnung ${r.asset.ref})` : ""].filter(Boolean).join(" ") }),
            h("td", { class: "num", text: euro(r.asset.cost) }),
            h("td", { text: how(r) }),
            h("td", { class: "num", text: euro(r.start) }),
            h("td", { class: "num", text: r.added ? euro(r.added) : "" }),
            h("td", { class: "num", text: euro(r.afa + r.gwg) }),
            h("td", { class: "num", text: r.remaining ? euro(r.remaining) : "" }),
            h("td", { class: "num", text: euro(r.end) }),
            h("td", { text: r.gone ? `${dateText(r.asset.disposal.date)}, Erlös ${euro(r.sale)}` : "" }),
          ),
        ),
      ),
      h(
        "tfoot",
        {},
        h(
          "tr",
          {},
          h("td", { colspan: 4, text: "Summe" }),
          h("td", { class: "num", text: euro(sum("start")) }),
          h("td", { class: "num", text: euro(sum("added")) }),
          h("td", { class: "num", text: euro(sum("afa") + sum("gwg")) }),
          h("td", { class: "num", text: euro(sum("remaining")) }),
          h("td", { class: "num", text: euro(sum("end")) }),
          h("td"),
        ),
      ),
    ),
  );
}

