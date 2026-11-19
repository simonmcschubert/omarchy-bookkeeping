"""Bookkeeping's updates, for the update button (app/update.mjs).

The Updater runs the update script next to this file: it checks for a
release (or, on the Preview channel, a preview of main), downloads it when
asked, and installs it with a restart of the server. server.py serves its
state at GET /api/update and passes the button's requests to answer().
Updates change only the code, never the data and receipts. The same as
Finance's Updater (omarchy-finance, server.py), with Bookkeeping's names.

Python standard library only (3.11 or newer).
"""

import os
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "update"
# Seconds: the first check for a release after the server starts, and then.
FIRST_CHECK = 15
CHECK_EVERY = 4 * 60 * 60
# The install restarts omarchy-bookkeeping.service, so it runs as a unit of
# its own.
INSTALL_UNIT = "omarchy-bookkeeping-update"
# Which updates Bookkeeping offers: releases, or previews of main (update
# script).
CHANNELS = ("stable", "preview")


def log_file():
    """Where the install unit writes what the update script says."""
    base = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
    return Path(base) / "omarchy-bookkeeping-update.log"


def reason(output):
    """The update script's reason for failing: its last line, after git's."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    return lines[-1].removeprefix("update: ") if lines else ""


class Updater:
    """Offers updates of Bookkeeping the way a desktop app offers them: it
    checks shortly after the server starts, every four hours, and when the
    update button asks; it downloads an update when asked, and installs it
    with a restart of the server. An update is a release, or on the preview
    channel the newest preview. The update script does the work; the page
    shows the state (app/update.mjs)."""

    def __init__(self, script=SCRIPT, log=None):
        self.script = Path(script)
        self.log = Path(log) if log else log_file()  # what the install unit writes
        # Tells the page that the server restarted, after an install.
        self.boot = secrets.token_hex(8)
        self.lock = threading.Lock()  # guards the fields below
        self.work = threading.Lock()  # one run of the script at a time
        # "": nothing to offer (up to date, not checked yet, offline, or no
        # git checkout). Otherwise available, downloading, downloaded,
        # installing, or failed (download or install; error says why).
        self.status = ""
        # What status is about: a release X.Y.Z, or a preview's commit id.
        self.version = ""
        self.error = ""
        self.checking = False
        ok, out, _ = self.run("version")
        # The installed release: "" before the first or without a checkout.
        self.installed = out.strip() if ok else ""
        ok, out, _ = self.run("channel")
        # stable or preview; "" without a checkout.
        self.channel = out.strip() if ok else ""

    def run(self, *args, timeout=60):
        """(ok, stdout, reason) of a run of the update script."""
        try:
            result = subprocess.run(
                [str(self.script), *args], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout
            )
        except subprocess.TimeoutExpired:
            return False, "", f"the update script did not finish within {timeout} seconds"
        except OSError as error:
            return False, "", f"can't run {self.script}: {error.strerror}"
        if result.returncode != 0:
            return False, result.stdout, reason(result.stderr) or "the update script failed"
        return True, result.stdout, ""

    def snapshot(self):
        with self.lock:
            return {
                "status": self.status,
                "version": self.version,
                "error": self.error,
                "installed": self.installed,
                "channel": self.channel,
                "checking": self.checking,
                "boot": self.boot,
            }

    def start(self):
        def checks():
            time.sleep(FIRST_CHECK)
            while True:
                self.check()
                time.sleep(CHECK_EVERY)

        threading.Thread(target=checks, daemon=True).start()

    def check(self, asked=False):
        """Looks for a newer release. Returns why the check failed, or "".
        A check on the timer keeps what an earlier one found when it fails
        (offline is no reason to hide a release), and leaves a failed update
        on show until the button is clicked."""
        with self.lock:
            if self.status == "installing" or (self.status == "failed" and not asked):
                return ""
        with self.work:
            with self.lock:
                self.checking = True
            ok, out, why = self.run("check")
            with self.lock:
                self.checking = False
                if not ok:
                    sys.stderr.write(f"update check failed: {why}\n")
                    return why
                if self.status in ("downloading", "installing"):
                    return ""  # what those find comes next
                words = out.split()
                if len(words) == 2 and words[0] in ("available", "downloaded"):
                    self.status, self.version = words
                else:
                    self.status, self.version = "", ""
                self.error = ""
        return ""

    def set_channel(self, channel):
        """Offers releases (stable) or previews from now on. Returns why it
        can't, or "". Check next: what was found before is forgotten."""
        busy = "can't change the channel while Bookkeeping updates; try again when it is done"
        with self.lock:
            if self.status in ("downloading", "installing"):
                return busy  # without waiting for the install to end
        with self.work:
            with self.lock:
                if self.status in ("downloading", "installing"):
                    return busy
            ok, _, why = self.run("channel", channel)
            if not ok:
                return why
            with self.lock:
                self.channel = channel
                # A download clicked meanwhile finishes for the channel before.
                if self.status not in ("downloading", "installing"):
                    self.status, self.version, self.error = "", "", ""
        return ""

    def download(self):
        with self.lock:
            if self.status not in ("available", "failed") or not self.version:
                return
            self.status, self.error = "downloading", ""
            version = self.version
        with self.work:
            ok, _, why = self.run("download", version, timeout=180)
        with self.lock:
            self.status = "downloaded" if ok else "failed"
            self.error = why

    def install(self):
        with self.lock:
            if self.status != "downloaded":
                return
            self.status, self.error = "installing", ""
            version = self.version
        threading.Thread(target=self.wait_for_install, args=(version,), daemon=True).start()

    def install_command(self, version):
        # --wait: it ends when the update script does. The log keeps what the
        # script says, as nothing here may be left to read it.
        return [
            "systemd-run", "--user", "--wait", "--quiet", "--collect", f"--unit={INSTALL_UNIT}",
            f"--property=StandardOutput=truncate:{self.log}", "--",
            str(self.script), "install", version,
        ]  # fmt: skip

    def wait_for_install(self, version):
        with self.work:
            self.log.unlink(missing_ok=True)
            try:
                result = subprocess.run(
                    self.install_command(version), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600
                )
                ok, why = result.returncode == 0, reason(result.stderr)
            except subprocess.TimeoutExpired:
                ok, why = False, "the update did not finish within 10 minutes"
            except OSError as error:
                ok, why = False, f"can't start the update: {error.strerror}"
            try:
                why = reason(self.log.read_text()) or why
            except OSError:
                pass  # systemd-run did not start the script
        # A successful install restarts this server, so it is still here
        # only when the install failed, or when it restarted the service
        # while this is another server (./server.py from the same checkout).
        with self.lock:
            if ok:
                self.status, self.version = "", ""
            else:
                self.status, self.error = "failed", why or "the update script failed"
        if ok:
            self.check()


def answer(updater, body):
    """(HTTP status, reply) for what the update button asks for: POST
    /api/update with {action: check, download, install, or channel}."""
    action = body.get("action") if isinstance(body, dict) else None
    if action == "check":
        why = updater.check(asked=True)
        return 200, {**updater.snapshot(), "checkError": why}
    if action == "download":
        updater.download()
        return 200, updater.snapshot()
    if action == "install":
        updater.install()
        return 200, updater.snapshot()
    if action == "channel" and body.get("channel") in CHANNELS:
        why = updater.set_channel(body["channel"])
        if why:
            return 409, {"error": why}
        why = updater.check(asked=True)
        return 200, {**updater.snapshot(), "checkError": why}
    channels = " or ".join(CHANNELS)
    return 400, {"error": f"Expected {{action: check, download, install, or channel with channel: {channels}}}"}
