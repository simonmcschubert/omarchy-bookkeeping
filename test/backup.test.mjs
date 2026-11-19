import assert from "node:assert/strict";
import { test } from "node:test";

import { STALE_DAYS, backupState, dateTimeText, daysAgo } from "../app/backup.mjs";

// Local times, so the tests pass in any time zone.
const at = (day, hour = 3, minute = 0) => new Date(2026, 10, day, hour, minute);
const iso = (date) => date.toISOString();

const status = (fields) => ({
  destination: "user@server:backups/books",
  lastAttempt: null,
  result: null,
  message: "",
  lastSuccess: null,
  lastRevision: null,
  ...fields,
});

test("dates and days in German order, local time", () => {
  assert.equal(dateTimeText(iso(at(19, 3, 5))), "19.11.2026, 03:05");
  assert.equal(daysAgo(iso(at(19, 3)), at(19, 23)), "today");
  assert.equal(daysAgo(iso(at(18, 23)), at(19, 1)), "yesterday", "by calendar day, not 24 hours");
  assert.equal(daysAgo(iso(at(14)), at(19)), "5 days ago");
});

test("no backup set up", () => {
  const state = backupState(null, "abc", at(19));
  assert.equal(state.level, "off");
  assert.equal(state.warning, undefined, "no nagging on the Overview before one is set up");
});

test("the copy has the data as it is now", () => {
  const state = backupState(status({ lastSuccess: iso(at(10)), lastRevision: "abc", lastAttempt: iso(at(10)), result: "ok" }), "abc", at(19));
  assert.equal(state.level, "ok", "old, but nothing changed since");
  assert.equal(state.title, "Last copy: 10.11.2026, 03:00 (9 days ago)");
  assert.equal(state.detail, "Everything is copied.");
  assert.equal(state.warning, undefined);
});

test("changes wait for the next daily copy", () => {
  const state = backupState(status({ lastSuccess: iso(at(18)), lastRevision: "old" }), "new", at(19, 15));
  assert.equal(state.level, "ok");
  assert.equal(state.detail, "Changes since then go with the next daily copy.");
});

test(`a warning when changes waited more than ${STALE_DAYS} days`, () => {
  const success = status({ lastSuccess: iso(at(15, 3)), lastRevision: "old" });
  assert.equal(backupState(success, "new", at(18, 2)).level, "ok", "a weekend away is fine");
  const state = backupState(success, "new", at(19, 4));
  assert.equal(state.level, "warn");
  assert.equal(state.warning, "No backup for 4 days: changes since 15.11.2026, 03:00 are only on this computer.");
});

test("set up, but no copy yet", () => {
  const state = backupState(status({ lastAttempt: iso(at(19)), result: "unreachable", message: "server not reachable" }), "abc", at(19, 5));
  assert.equal(state.level, "warn");
  assert.equal(state.title, "No copy yet");
  assert.match(state.warning, /^No backup yet/);
  assert.equal(state.note, "The last try, 19.11.2026, 03:00: server not reachable. It tries again every hour.");
  assert.equal(backupState(status({}), "none", at(19)).level, "ok", "nothing saved yet, nothing to lose");
});

test("why the last try failed, until a copy works again", () => {
  const failed = status({ lastSuccess: iso(at(18)), lastRevision: "abc", lastAttempt: iso(at(19)), result: "failed", message: "server refused the SSH key" });
  assert.equal(backupState(failed, "abc", at(19, 5)).problem, "The last try, 19.11.2026, 03:00, failed: server refused the SSH key");
  const recovered = { ...failed, lastSuccess: iso(at(19)), result: "ok" };
  assert.equal(backupState(recovered, "abc", at(19, 5)).problem, undefined);
});
