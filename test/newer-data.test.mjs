// A data file from a newer Bookkeeping stays closed (books.mjs, unreadable):
// updates never go back, and this holds when the code goes back another way
// (a backup restored, a checkout moved by hand). Run: node --test
import assert from "node:assert/strict";
import test from "node:test";
import { VERSION, emptyData, unreadable } from "../app/books.mjs";

test("this version opens its own data file and none yet", () => {
  assert.equal(unreadable(emptyData()), "");
  assert.equal(unreadable(null), "", "no file yet");
  assert.equal(unreadable({ ...emptyData(), invoices: [] }), "", "new fields keep the version");
});

test("a data file saved by a newer version stays closed", () => {
  const newer = { ...emptyData(), version: VERSION + 1 };
  assert.equal(
    unreadable(newer),
    `it was saved by a newer version of Bookkeeping (data version ${VERSION + 1}; this one reads version ${VERSION}). Update Bookkeeping (the button at the top right) to open it.`,
  );
});
