// The backup: the copy of the data and receipts on another computer, made
// once a day by the backup script (setup --backup). What Settings › Backup
// and the Overview say about it. No DOM here, so node --test can check it.

// Changes may wait this long for a copy before the app warns: a laptop off
// over a weekend is no reason for alarm.
export const STALE_DAYS = 3;

const DAY = 24 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");

/** "19.11.2026, 03:00", in local time. */
export function dateTimeText(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? "");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "today", "yesterday" or "3 days ago", by calendar day. */
export function daysAgo(iso, now = new Date()) {
  const d = new Date(iso);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * What to say about the backup. `status` is GET /api/backup's (null when no
 * backup is set up), `revision` the data file's now ("none" before the first
 * save). Returns a level (off, ok or warn) and lines to show:
 * - title: the last copy, or that there is none
 * - detail: whether the data now is copied
 * - problem: why the last try failed, when it did and that was after the
 *   last copy
 * - note: the last try could not reach the other computer
 * - warning: for the Overview, when changes have waited too long
 */
export function backupState(status, revision, now = new Date()) {
  if (!status) {
    return { level: "off", title: "Not set up", detail: "The data and receipts are only on this computer." };
  }
  const success = status.lastSuccess ? new Date(status.lastSuccess) : null;
  const copied = revision === "none" || (success !== null && status.lastRevision === revision);
  const age = success ? now - success : Infinity;
  const stale = !copied && age > STALE_DAYS * DAY;
  const state = { level: stale ? "warn" : "ok", destination: status.destination };

  if (success) {
    state.title = `Last copy: ${dateTimeText(status.lastSuccess)} (${daysAgo(status.lastSuccess, now)})`;
    if (copied) state.detail = "Everything is copied.";
    else if (stale) state.detail = `Changes since ${dateTimeText(status.lastSuccess)} are only on this computer.`;
    else state.detail = "Changes since then go with the next daily copy.";
  } else {
    state.title = "No copy yet";
    state.detail = copied ? "Nothing to copy yet." : "The data and receipts are only on this computer.";
  }

  const tried = status.lastAttempt && (!success || new Date(status.lastAttempt) > success);
  if (tried && status.result === "failed") {
    state.problem = `The last try, ${dateTimeText(status.lastAttempt)}, failed: ${status.message || "see journalctl --user -u omarchy-bookkeeping-backup"}`;
  } else if (tried && status.result === "unreachable") {
    state.note = `The last try, ${dateTimeText(status.lastAttempt)}: ${status.message || "not reachable"}. It tries again every hour.`;
  }

  if (stale) {
    state.warning = success
      ? `No backup for ${Math.floor(age / DAY)} days: changes since ${dateTimeText(status.lastSuccess)} are only on this computer.`
      : "No backup yet: the data and receipts are only on this computer.";
  }
  return state;
}
