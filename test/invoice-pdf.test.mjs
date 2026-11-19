// The real thing: the server makes ZUGFeRD PDFs from the page's invoice
// with Chromium, pikepdf and the Mustang validator, and keeps only valid
// ones. Skipped where those tools are missing (setup installs them; CI's
// invoice job has them).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { invoiceHtml } from "../app/invoice-html.mjs";
import { invoiceXml } from "../app/invoice-xml.mjs";
import { cancellationOf, issuing } from "../app/invoices.mjs";
import { sampleData, sampleDraft } from "./fixtures/invoices.mjs";

async function startServer(dir) {
  const python = process.env.BOOKKEEPING_PYTHON ?? "python3";
  const child = spawn(python, [new URL("../server.py", import.meta.url).pathname, "--port", "0", "--data", join(dir, "books.json")], { stdio: ["ignore", "ignore", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let log = "";
    child.stderr.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/127\.0\.0\.1:(\d+)\//);
      if (match) resolve(match[1]);
    });
    child.on("exit", () => reject(new Error(`the server stopped: ${log}`)));
  });
  return { child, base: `http://127.0.0.1:${port}` };
}

async function post(base, invoice, xml = invoiceXml(invoice)) {
  const response = await fetch(`${base}/api/invoices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html: invoiceHtml(invoice), xml, title: `Rechnung ${invoice.number}` }),
  });
  return { status: response.status, body: await response.json() };
}

test("ZUGFeRD PDFs pass the Mustang validator; a broken one is not kept", { timeout: 300000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bookkeeping-invoice-"));
  const { child, base } = await startServer(dir);
  t.after(() => {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  const tools = await (await fetch(`${base}/api/invoices/tools`)).json();
  if (!tools.ready) {
    // CI's invoice job sets BOOKKEEPING_REQUIRE_TOOLS: there, missing is a failure.
    assert.ok(!process.env.BOOKKEEPING_REQUIRE_TOOLS, `missing: ${tools.missing.join(", ")}`);
    t.skip(`missing: ${tools.missing.join(", ")}`);
    return;
  }
  const data = sampleData();
  const draft = sampleDraft(data, { note: "Vielen Dank für den Auftrag!" });
  draft.items.push({ text: "Rabatt", quantity: -1, unit: "LS", price: 5000 });
  const invoice = issuing(data, draft, 42);
  const single = issuing(data, sampleDraft(data, { service: { from: "2026-11-18", to: "" }, terms: 0 }), 43);
  const storno = issuing(data, cancellationOf(data, { ...invoice, status: "sent" }, "2026-11-20"), 44);
  const kept = [];
  for (const [what, doc] of [
    ["invoice", invoice],
    ["single service date", single],
    ["cancellation", storno],
  ]) {
    const { status, body } = await post(base, doc);
    assert.equal(status, 200, `${what}: ${JSON.stringify(body)}`);
    const v = body.validation;
    assert.equal(v.valid, true, what);
    assert.equal(v.pdfa, "3u", what);
    assert.equal(v.profile, "urn:cen.eu:en16931:2017", what);
    assert.deepEqual(v.messages, [], what);
    const pdf = await fetch(`${base}/api/receipts/${body.file}`);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.ok(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).equals(Buffer.from("%PDF-")));
    kept.push(body.file);
  }
  // A wrong total breaks EN 16931's sums: refused and not kept.
  const broken = invoiceXml(invoice).replace("<ram:GrandTotalAmount>970.00", "<ram:GrandTotalAmount>971.00");
  assert.notEqual(broken, invoiceXml(invoice));
  const { status, body } = await post(base, invoice, broken);
  assert.equal(status, 422);
  assert.equal(body.validation.valid, false);
  assert.ok(body.validation.messages.some((m) => m.level === "error"));
  assert.deepEqual(readdirSync(join(dir, "receipts")).sort(), kept.sort());
});
