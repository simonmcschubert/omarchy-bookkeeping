// Bookkeeping: the invoice as a page, in German, for Chromium to print to
// the PDF and for the preview. A whole HTML document as a string: no DOM
// here, so node --test checks it. Its look is invoice.css, linked next to
// it; no inline styles or scripts, and its own CSP loads nothing else.
//
// What it shows, by § 14 Abs. 4 Satz 1 UStG:
//   Nr. 1  full name and address of the seller and the buyer
//   Nr. 2  the seller's Steuernummer (and USt-IdNr. when there is one)
//   Nr. 3  the date of issue (Rechnungsdatum)
//   Nr. 4  the running number (Rechnungsnummer)
//   Nr. 5  quantity and kind of each service (the lines)
//   Nr. 6  when the service was done (Leistungsdatum or -zeitraum)
//   Nr. 7  the price, by tax rate or exemption
//   Nr. 8  the rate and the tax, or the note that it is tax-exempt: for a
//          Kleinunternehmer the § 19 note
// Nr. 9 (the note on keeping invoices for building work for private
// customers, § 14b Abs. 1 Satz 5) and Nr. 10 ("Gutschrift", invoices the
// customer writes) don't apply to Simon's business and are left out.
// § 33 UStDV (invoices up to 250 €) and § 34a UStDV (Kleinunternehmer) ask
// for less than this, so every invoice meets them too.

import { dateText, euro } from "./books.mjs";
import { KLEINUNTERNEHMER, KLEINUNTERNEHMER_NOTE, UNITS, dueDate, invoiceTotals, quantityText, splitAddress } from "./invoices.mjs";

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Text with its line breaks kept. */
function lines(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(escapeHtml)
    .join("<br>");
}

/** "DE02 1203 0000 0000 2020 51" */
export function ibanText(iban) {
  return String(iban ?? "")
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

const COUNTRIES = { DE: "Deutschland", AT: "Österreich", CH: "Schweiz", FR: "Frankreich", NL: "Niederlande", BE: "Belgien", LU: "Luxemburg", DK: "Dänemark", PL: "Polen", CZ: "Tschechien", IT: "Italien", ES: "Spanien", GB: "Vereinigtes Königreich", US: "USA" };

function addressBlock(party, home = "DE") {
  const country = party.country && party.country !== home ? (COUNTRIES[party.country] ?? party.country) : "";
  return [escapeHtml(party.name), lines(party.address), country ? escapeHtml(country) : ""].filter(Boolean).join("<br>");
}

function oneLine(party) {
  const address = splitAddress(party.address);
  const place = [address.postcode, address.city].filter(Boolean).join(" ");
  return [party.name, ...address.lines, place].filter(Boolean).map(escapeHtml).join(" · ");
}

function unitText(item) {
  const unit = UNITS.find((u) => u.code === item.unit) ?? UNITS[0];
  return Math.abs(item.quantity) === 1 ? unit.one : unit.many;
}

function serviceText(service) {
  if (service?.to && service.to !== service.from) return ["Leistungszeitraum", `${dateText(service.from)} – ${dateText(service.to)}`];
  return ["Leistungsdatum", dateText(service?.from)];
}

function percent(rate) {
  return `${String(rate).replace(".", ",")} %`;
}

/**
 * The page of an invoice that is being issued or was issued: it has its
 * number, `seller` and `buyer`. A draft shows "Entwurf" across it.
 */
export function invoiceHtml(invoice, { draft = false } = {}) {
  const { seller, buyer } = invoice;
  const totals = invoiceTotals(invoice);
  const cancellation = invoice.kind === "cancellation";
  const title = cancellation ? "Stornorechnung" : "Rechnung";
  const number = invoice.number ?? "";
  const [serviceLabel, serviceValue] = serviceText(invoice.service);
  const facts = [
    ["Rechnungsnummer", number || "–"],
    ["Rechnungsdatum", dateText(invoice.date)],
    [serviceLabel, serviceValue],
    seller.taxNumber ? ["Steuernummer", seller.taxNumber] : null,
    seller.vatId ? ["USt-IdNr.", seller.vatId] : null,
    buyer.vatId ? ["Ihre USt-IdNr.", buyer.vatId] : null,
  ].filter(Boolean);
  // A cancellation counts its lines negative: −2 Tage × 450,00 € = −900,00 €,
  // as its XML has them (BT-129).
  const sign = invoice.kind === "cancellation" ? -1 : 1;
  const rows = totals.lines
    .map(
      (line, i) => `
      <tr>
        <td class="pos">${i + 1}</td>
        <td class="text">${lines(line.text)}</td>
        <td class="num">${escapeHtml(quantityText(sign * line.quantity))} ${escapeHtml(unitText(line))}</td>
        <td class="num">${escapeHtml(euro(line.price))}</td>
        <td class="num">${escapeHtml(euro(line.amount))}</td>
      </tr>`,
    )
    .join("");
  const kleinunternehmer = (invoice.vat ?? KLEINUNTERNEHMER) === KLEINUNTERNEHMER;
  const vatRows = kleinunternehmer
    ? ""
    : [
        `<tr><td colspan="4">Nettobetrag</td><td class="num">${escapeHtml(euro(totals.net))}</td></tr>`,
        ...totals.breakdown.map((g) => `<tr><td colspan="4">Umsatzsteuer ${percent(g.rate)} auf ${escapeHtml(euro(g.basis))}</td><td class="num">${escapeHtml(euro(g.tax))}</td></tr>`),
      ].join("");
  const original = invoice.original ?? {};
  const intro = cancellation
    ? `<p>Die Rechnung Nr. ${escapeHtml(original.number)} vom ${escapeHtml(dateText(original.date))} wird hiermit in voller Höhe storniert.</p>`
    : "";
  const payment = cancellation
    ? `<p>Die Rechnung Nr. ${escapeHtml(original.number)} ist damit aufgehoben; bitte zahlen Sie sie nicht.</p>`
    : `<p>Bitte überweisen Sie den Rechnungsbetrag ${
        invoice.terms ? `bis zum <strong>${escapeHtml(dateText(dueDate(invoice)))}</strong>` : "sofort"
      } ohne Abzug unter Angabe der Rechnungsnummer ${escapeHtml(number || "…")} auf das unten genannte Konto.</p>`;
  const contact = [seller.email ? `E-Mail ${escapeHtml(seller.email)}` : "", seller.taxNumber ? `Steuernummer ${escapeHtml(seller.taxNumber)}` : "", seller.vatId ? `USt-IdNr. ${escapeHtml(seller.vatId)}` : ""].filter(Boolean).join("<br>");
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' file:">
<title>${escapeHtml(title)} ${escapeHtml(number)}</title>
<link rel="stylesheet" href="invoice.css">
</head>
<body>
<article class="invoice${draft ? " draft" : ""}">
  <header class="letterhead">
    <div class="from">${escapeHtml(seller.name)}</div>
  </header>
  <div class="head">
    <div class="window">
      <div class="return">${oneLine(seller)}</div>
      <address>${addressBlock(buyer)}</address>
    </div>
    <dl class="facts">${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
  </div>
  <h1>${escapeHtml(title)}${number ? ` Nr. ${escapeHtml(number)}` : ""}</h1>
  ${intro}
  <table class="items">
    <thead><tr><th class="pos">Pos.</th><th>Beschreibung</th><th class="num">Menge</th><th class="num">Einzelpreis</th><th class="num">Betrag</th></tr></thead>
    <tbody>${rows}
    </tbody>
    <tfoot>
      ${vatRows}
      <tr class="total"><td colspan="4">${cancellation ? "Stornobetrag" : "Rechnungsbetrag"}</td><td class="num">${escapeHtml(euro(totals.gross))}</td></tr>
    </tfoot>
  </table>
  ${kleinunternehmer ? `<p class="vat-note">${escapeHtml(KLEINUNTERNEHMER_NOTE)}</p>` : ""}
  ${invoice.note ? `<p class="note">${lines(invoice.note)}</p>` : ""}
  ${payment}
  <p>Mit freundlichen Grüßen<br>${escapeHtml(seller.name)}</p>
  <footer>
    <div>${addressBlock(seller)}</div>
    <div>${contact}</div>
    <div>Bankverbindung<br>IBAN ${escapeHtml(ibanText(seller.iban))}<br>Kontoinhaber ${escapeHtml(seller.name)}</div>
  </footer>
</article>
</body>
</html>
`;
}
