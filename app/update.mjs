// The update button in the header. The server looks for updates of
// Bookkeeping (updates.py, Updater); this shows what it found, and asks it to
// check, download and install. The button is always there: a circle of
// arrows that checks for updates when clicked. When there is an update it
// becomes Update: one click downloads and installs it, and Bookkeeping
// restarts. An update downloaded otherwise (a terminal, or a window closed
// during the download) shows Restart to update. Settings › Updates has the
// channel: Stable for releases, Preview for every change once its tests
// pass. The same as Finance's update.mjs, with Bookkeeping's names.

const POLL = 60 * 1000; // ms between asking the server for news
const RESTART_POLL = 1000; // ms between asks while the server restarts
const RESTART_TRIES = 120; // then give up waiting for it
const CONFIRM = 4000; // ms that "Up to date" shows after a check

// How the page names an update: a release "0.2.0", or a preview's commit
// as "preview 1a2b3c4".
export function updateName(version) {
  return /^[0-9a-f]{40}$/.test(version) ? `preview ${version.slice(0, 7)}` : version;
}

// What the button shows: icon, text, tone (accent, red or none), tip, and
// busy (the icon turns). server is GET /api/update (null before the first
// answer); asked is the last check the button asked for, and reload is set
// while an installed update waits for an open form (entry, asset, invoice)
// before the page reloads.
export function updateButton(server, asked) {
  const s = server ?? { status: "", version: "", error: "", installed: "", channel: "", checking: false };
  const name = `Bookkeeping ${updateName(s.version)}`;
  if (asked.reload) {
    return { icon: "restart", text: "Updated", tone: "accent",
      tip: `${s.installed ? `Bookkeeping ${s.installed}` : "A new version of Bookkeeping"} is installed. This window reloads with it once the open form is saved or cancelled.` };
  }
  switch (s.status) {
    case "available":
      return { icon: "download", text: "Update", tone: "accent",
        tip: `${name} is available. Click to install it and restart Bookkeeping. Your data stays as it is.` };
    case "downloading":
      return { icon: "download", text: "Downloading", tone: "accent", tip: `Downloading ${name}.` };
    case "downloaded":
      return { icon: "restart", text: "Restart to update", tone: "accent",
        tip: `${name} is downloaded. Click to restart Bookkeeping with it. Your data stays as it is.` };
    case "installing":
      return { icon: "restart", text: "Updating", tone: "accent", tip: `Installing ${name} and restarting Bookkeeping.`, busy: true };
    case "failed":
      return { icon: "alert", text: "Update failed", tone: "red", tip: `${sentence(s.error || `can't update to ${name}`)} Click to try again.` };
  }
  const installed = `${s.installed ? `Bookkeeping ${s.installed}` : "Bookkeeping"}${s.channel === "preview" ? " (Preview)" : ""}`;
  if (asked.checking || s.checking) return { icon: "refresh", text: "", tone: "", tip: "Checking for updates…", busy: true };
  if (asked.error) return { icon: "alert", text: "Can't check", tone: "red", tip: `Can't check for updates: ${asked.error}. Click to try again.` };
  if (asked.current) return { icon: "refresh", text: "Up to date", tone: "", tip: `${installed} is up to date.` };
  return { icon: "refresh", text: "", tone: "", tip: `${s.installed ? `${installed} is installed. ` : ""}Click to check for updates.` };
}

// Whether the server now runs other code than when the page last asked:
// before and now are GET /api/update. A new boot alone is a plain restart.
// The commit tells previews apart before the first release, when installed
// is empty for each of them.
export function newCode(before, now) {
  if (!before || now.boot === before.boot) return false;
  return now.commit !== before.commit || now.installed !== before.installed;
}

// The line under the channel choice in Settings. choosing is the switch
// the page asked for: busy, or the error it ended with.
export function channelNote(server, choosing) {
  if (choosing.busy) return "Switching…";
  if (choosing.error) return sentence(choosing.error);
  if (!server) return "";
  if (!server.channel) return "Bookkeeping can't update itself: its folder is not a git checkout.";
  return server.installed ? `Bookkeeping ${server.installed} is installed.` : "";
}

const CHANNELS = [
  ["stable", "Stable"],
  ["preview", "Preview"],
];

function sentence(text) {
  const trimmed = text.trim().replace(/\.$/, "");
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}.`;
}

// 24×24, drawn with a 2px stroke in the text color.
const ICONS = {
  refresh: ["M4 12A8 8 0 0 1 18.93 8", "M19 3v5h-5", "M20 12A8 8 0 0 1 5.07 16", "M5 21v-5h5"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  restart: ["M20 12A8 8 0 1 1 18.93 8", "M19 3v5h-5"],
  alert: ["M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16", "M12 8v5", "M12 16.5v.01"],
};

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICONS[name]) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Shows the button in root. saving() tells whether the page has a change
// on its way to the server: a restart waits for it. editing() tells whether
// the page holds a change only it knows (an entry, asset, invoice or
// customer open in its form): the reload after an update waits for it, so the change is not
// lost. Returns channelSettings(), the channel choice for Settings, which
// this keeps up to date.
export function startUpdates(root, { saving, editing = () => false }) {
  let server = null;
  const asked = { checking: false, error: "", current: false, reload: false };
  let confirmed = null;
  let restarting = false;
  // The server this page's code came from (its first answer). An answer
  // from a server that runs other code reloads the page (accept).
  let loaded = null;
  let reloading = false;
  const choosing = { busy: false, error: "" };
  let choice = null; // { buttons, note } of the choice on show in Settings

  async function call(method, body) {
    try {
      const response = await fetch("/api/update", {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json();
      return response.ok ? { json } : { error: json?.error ?? `HTTP ${response.status}` };
    } catch {
      return { error: "the Bookkeeping server does not answer" };
    }
  }

  function render() {
    const b = updateButton(server, asked);
    const classes = ["update-button", b.tone, b.busy ? "busy" : ""].filter(Boolean).join(" ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = classes;
    button.title = b.tip;
    button.setAttribute("aria-label", b.text ? `${b.text}. ${b.tip}` : b.tip);
    if (b.busy) button.setAttribute("aria-busy", "true");
    button.append(icon(b.icon));
    if (b.text) button.append(Object.assign(document.createElement("span"), { textContent: b.text }));
    button.addEventListener("click", act);
    const hadFocus = root.contains(document.activeElement);
    root.replaceChildren(button);
    if (hadFocus) button.focus();
    renderChoice();
  }

  // In place, so focus stays on the button that was clicked.
  function renderChoice() {
    if (!choice) return;
    const channel = server?.channel ?? "";
    for (const [value, button] of choice.buttons) {
      button.className = value === channel ? "on" : "";
      button.setAttribute("aria-pressed", String(value === channel));
      button.disabled = !channel || choosing.busy || asked.checking;
    }
    choice.note.textContent = channelNote(server, choosing);
  }

  function channelSettings() {
    const buttons = CHANNELS.map(([value, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => choose(value));
      return [value, button];
    });
    const group = Object.assign(document.createElement("div"), { className: "segmented" });
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Updates");
    group.append(...buttons.map(([, button]) => button));
    const note = document.createElement("p");
    note.setAttribute("role", "status");
    choice = { buttons, note };
    renderChoice();
    const box = document.createElement("div");
    box.append(group, note);
    return box;
  }

  async function refresh() {
    if (restarting) return;
    const { json } = await call("GET");
    if (!json || restarting) return;
    if (accept(json)) render();
  }

  // Takes json, an answer of the server, as what the button shows. When the
  // server runs other code than this page came from (another window or a
  // terminal installed an update), reloads the page instead. Returns
  // whether it took it.
  function accept(json) {
    if (reloading) return false;
    loaded ??= json;
    if (newCode(loaded, json)) {
      reload(json);
      return false;
    }
    server = json;
    return true;
  }

  async function check() {
    if (asked.checking) return;
    Object.assign(asked, { checking: true, error: "", current: false });
    clearTimeout(confirmed);
    render();
    const { json, error } = await call("POST", { action: "check" });
    asked.checking = false;
    if (json && !accept(json)) return;
    found(error ?? json.checkError);
    render();
  }

  // What a check the page asked for found: the button says so for a while.
  function found(error) {
    asked.error = error;
    if (!asked.error && server.status === "") {
      asked.current = true;
      confirmed = setTimeout(() => {
        asked.current = false;
        render();
      }, CONFIRM);
    }
  }

  // Switches the channel; the server checks it straight away.
  async function choose(channel) {
    if (choosing.busy || asked.checking || channel === server?.channel) return;
    Object.assign(choosing, { busy: true, error: "" });
    Object.assign(asked, { checking: true, error: "", current: false });
    clearTimeout(confirmed);
    render();
    const { json, error } = await call("POST", { action: "channel", channel });
    Object.assign(choosing, { busy: false, error: error ?? "" });
    asked.checking = false;
    if (json) {
      if (!accept(json)) return;
      found(json.checkError);
    }
    render();
  }

  // Clicked Update: downloads it and installs it straight away, so the
  // button needs no second click.
  async function download() {
    server = { ...server, status: "downloading" };
    render();
    const { json, error } = await call("POST", { action: "download" });
    if (json && !accept(json)) return;
    if (!json) server = { ...server, status: "failed", error: `can't download Bookkeeping ${server.version}: ${error}` };
    if (server.status === "downloaded") return install();
    render();
  }

  // Installing restarts the server; the page reloads from the new one.
  async function install() {
    restarting = true;
    const boot = server.boot;
    server = { ...server, status: "installing" };
    render();
    while (saving()) await sleep(100);
    const { json } = await call("POST", { action: "install" });
    if (json && !accept(json)) return;
    let misses = 0;
    while (server.status === "installing") {
      await sleep(RESTART_POLL);
      const { json } = await call("GET");
      if (json?.boot && json.boot !== boot) {
        await reload(json);
        return;
      }
      if (json) {
        // Still the old server: the install is under way, or failed before
        // the restart, and then the button says why.
        server = json;
        render();
      } else if (++misses >= RESTART_TRIES) {
        server = { ...server, status: "failed", error: "Bookkeeping did not start again. See: journalctl --user -u omarchy-bookkeeping" };
        render();
      }
    }
    restarting = false;
  }

  // Reloads the page from the new server json, once nothing would be lost.
  // Until then the page keeps working with it: a save goes to the new
  // server, which reads the same data.
  async function reload(json) {
    if (reloading) return;
    reloading = restarting = true;
    server = json;
    for (;;) {
      while (saving() || editing()) {
        if (!asked.reload && editing()) {
          asked.reload = true;
          render();
        }
        await sleep(100);
      }
      // A field that saves on change (Settings) saves when it loses focus;
      // saving() then waits for it.
      document.activeElement?.blur();
      if (!saving()) break;
    }
    location.reload();
  }

  function act() {
    if (reloading) return;
    const status = server?.status ?? "";
    if (status === "") check();
    else if (status === "available" || status === "failed") download();
    else if (status === "downloaded") install();
  }

  render();
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL);
  addEventListener("focus", refresh);
  return { channelSettings };
}
