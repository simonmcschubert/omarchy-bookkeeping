// Sample data for the invoice tests: a made-up business and made-up
// customers, never real ones (the repo is public).

import { emptyData } from "../../app/books.mjs";
import { newInvoice } from "../../app/invoices.mjs";

export function sampleData() {
  const data = emptyData();
  data.business = { name: "Erika Musterfrau", address: "Musterstraße 12\n10115 Berlin", taxNumber: "12/345/67890", iban: "DE02 1203 0000 0000 2020 51", email: "erika@example.org" };
  data.customers = [
    { id: "c1", name: "Beispielverein e. V.", address: "Hauptstraße 5\n20095 Hamburg", country: "DE", email: "", vatId: "" },
    { id: "c2", name: "Muster Design GmbH", address: "Gartenweg 3\n80331 München", country: "DE", email: "", vatId: "" },
  ];
  data.entries = [{ id: "old", kind: "income", date: "2025-12-01", amount: 5000, text: "x", category: "in-3", number: 41, ref: "", receipt: null }];
  return data;
}

export function sampleDraft(data, extra = {}) {
  return {
    ...newInvoice(data, "2026-11-19"),
    id: "inv1",
    customer: "c1",
    service: { from: "2026-11-03", to: "2026-11-14" },
    items: [
      { text: "Workshop", quantity: 2, unit: "DAY", price: 45000 },
      { text: "Nachbetreuung", quantity: 1.5, unit: "HUR", price: 8000 },
    ],
    ...extra,
  };
}
