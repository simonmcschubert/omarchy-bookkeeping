"""The update button's server side (updates.py, /api/update), with a
stand-in for the update script. Ported from Finance's tests."""

import http.client
import json
import re
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import server  # noqa: E402
import updates  # noqa: E402

# Stands in for the update script. Files next to it decide what it does:
# check.out is what check prints; channel holds the channel; check.fail,
# download.fail, install.fail and channel.fail make those fail the way the
# script does. It logs its calls to calls.
FAKE_UPDATE = """#!/bin/bash
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
case $1 in
  version) echo 0.1.0 ;;
  commit) echo 1a2b3c4d1a2b3c4d1a2b3c4d1a2b3c4d1a2b3c4d ;;
  check)
    [[ ! -e $dir/check.fail ]] || { echo "fatal: unable to access origin" >&2; echo "update: can't reach origin" >&2; exit 1; }
    cat "$dir/check.out" ;;
  download)
    [[ ! -e $dir/download.fail ]] || { echo "update: can't download Bookkeeping $2" >&2; exit 1; }
    echo "downloaded $2" > "$dir/check.out" ;;
  install)
    [[ ! -e $dir/install.fail ]] || { echo "update: can't update to $2: /app has local changes" >&2; exit 1; }
    echo current > "$dir/check.out" ;;
  channel)
    if [[ -n $2 ]]; then
      [[ ! -e $dir/channel.fail ]] || { echo "update: /app is not a git checkout, so there is nothing to update from" >&2; exit 1; }
      echo "$2" > "$dir/channel"
    else
      cat "$dir/channel" 2>/dev/null || echo stable
    fi ;;
esac
"""


class DirectUpdater(updates.Updater):
    """Runs the install straight away, not as a systemd unit."""

    def install_command(self, version):
        return [str(self.script), "install", version]


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.script = self.dir / "update"
        self.script.write_text(FAKE_UPDATE)
        self.script.chmod(0o755)
        self.offer("current")
        self.start(DirectUpdater)

    def start(self, kind):
        self.updater = kind(self.script, self.dir / "update.log")
        self.server = server.BookkeepingServer(0, self.dir / "bookkeeping.json", self.dir / "colors.toml", self.updater)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def offer(self, line):
        (self.dir / "check.out").write_text(line + "\n")

    def calls(self):
        path = self.dir / "calls"
        return path.read_text().split("\n")[:-1] if path.exists() else []

    def request(self, method, body=None, headers=None, path="/api/update"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        all_headers = {"Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}"}
        if body is not None:
            all_headers["Content-Type"] = "application/json"
            body = json.dumps(body).encode()
        all_headers.update(headers or {})
        conn.request(method, path, body=body, headers=all_headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response.status, json.loads(data)

    def act(self, action, **fields):
        status, body = self.request("POST", {"action": action, **fields})
        self.assertEqual(status, 200, body)
        return body

    def settled(self):
        """The state once the install has finished."""
        for _ in range(100):
            body = self.request("GET")[1]
            if body["status"] != "installing":
                return body
            time.sleep(0.05)
        self.fail("the install did not finish")

    def test_reports_the_installed_release(self):
        status, body = self.request("GET")
        self.assertEqual(status, 200)
        self.assertEqual(body["installed"], "0.1.0")
        self.assertEqual(body["commit"], "1a2b3c4d" * 5)
        self.assertEqual(body["channel"], "stable")
        self.assertEqual((body["status"], body["version"], body["checking"]), ("", "", False))
        self.assertRegex(body["boot"], r"^[0-9a-f]{16}$")
        self.assertEqual(self.calls(), ["version", "commit", "channel"], "no check before the timer or the button asks")

    def test_serves_the_button(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/update.mjs", headers={"Host": f"127.0.0.1:{self.port}"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn(b"export function startUpdates", response.read())
        conn.close()

    def test_check_download_and_install(self):
        body = self.act("check")
        self.assertEqual((body["status"], body["checkError"]), ("", ""), "up to date")

        self.offer("available 0.2.0")
        body = self.act("check")
        self.assertEqual((body["status"], body["version"], body["checkError"]), ("available", "0.2.0", ""))

        body = self.act("download")
        self.assertEqual((body["status"], body["version"]), ("downloaded", "0.2.0"))

        body = self.act("install")
        self.assertEqual(body["status"], "installing")
        # Still here after a successful install: not run by the service, so
        # it was not restarted. It checks again.
        self.assertEqual(self.settled()["status"], "")
        self.assertEqual(self.calls(), ["version", "commit", "channel", "check", "check", "download 0.2.0", "install 0.2.0", "check"])

    def test_install_and_download_only_in_turn(self):
        self.offer("available 0.2.0")
        self.act("check")
        self.assertEqual(self.act("install")["status"], "available", "not downloaded yet")
        self.act("download")
        self.assertEqual(self.act("download")["status"], "downloaded")
        self.assertNotIn("install 0.2.0", self.calls())
        self.assertEqual(self.calls().count("download 0.2.0"), 1)

    def test_a_failed_check_says_why_and_keeps_the_release(self):
        self.offer("available 0.2.0")
        self.act("check")
        (self.dir / "check.fail").touch()
        body = self.act("check")
        self.assertEqual(body["checkError"], "can't reach origin")
        self.assertEqual((body["status"], body["version"]), ("available", "0.2.0"))
        self.assertEqual(self.updater.check(), "can't reach origin", "the timer's check too")
        self.assertEqual(self.request("GET")[1]["status"], "available")

    def test_a_failed_download_says_why_until_clicked(self):
        self.offer("available 0.2.0")
        self.act("check")
        (self.dir / "download.fail").touch()
        body = self.act("download")
        self.assertEqual((body["status"], body["error"]), ("failed", "can't download Bookkeeping 0.2.0"))
        self.updater.check()
        self.assertEqual(self.request("GET")[1]["status"], "failed", "the timer leaves it on show")

        # Clicking it downloads again.
        (self.dir / "download.fail").unlink()
        body = self.act("download")
        self.assertEqual((body["status"], body["error"]), ("downloaded", ""))

    def test_a_failed_install_says_why(self):
        self.offer("available 0.2.0")
        self.act("check")
        self.act("download")
        (self.dir / "install.fail").touch()
        self.act("install")
        body = self.settled()
        self.assertEqual((body["status"], body["version"]), ("failed", "0.2.0"))
        self.assertEqual(body["error"], "can't update to 0.2.0: /app has local changes")

    def test_the_install_reason_comes_from_its_log(self):
        log = self.dir / "update.log"
        commands = [
            # As under systemd-run: the script's output goes to the log.
            f"echo 'fatal: git said' > {log}; echo 'update: reason from the log' >> {log}; exit 1",
            # systemd-run itself failed: its own reason, not an earlier log's.
            "echo 'Failed to start transient service unit' >&2; exit 1",
        ]

        class SystemdUpdater(updates.Updater):
            def install_command(self, version):
                return ["bash", "-c", commands.pop(0)]

        self.server.shutdown()
        self.server.server_close()
        self.start(SystemdUpdater)
        self.offer("downloaded 0.2.0")
        self.act("check")
        self.act("install")
        self.assertEqual(self.settled()["error"], "reason from the log")

        self.act("download")  # as the button does after a failure
        log.write_text("update: an earlier install\n")
        self.act("install")
        self.assertEqual(self.settled()["error"], "Failed to start transient service unit")

    def test_the_install_runs_as_its_own_systemd_unit(self):
        command = updates.Updater(self.script, "/run/user/1000/omarchy-bookkeeping-update.log").install_command("0.2.0")
        self.assertEqual(command[:2], ["systemd-run", "--user"])
        self.assertIn("--wait", command)
        self.assertIn("--unit=omarchy-bookkeeping-update", command)
        self.assertIn("--property=StandardOutput=truncate:/run/user/1000/omarchy-bookkeeping-update.log", command)
        self.assertEqual(command[-3:], [str(self.script), "install", "0.2.0"])

    def test_refuses_other_origins_and_anything_but_json(self):
        status, _ = self.request("POST", {"action": "check"}, {"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", {"action": "check"}, {"Host": "evil.example"})
        self.assertEqual(status, 403)
        status, _ = self.request("POST", {"action": "check"}, {"Content-Type": "text/plain"})
        self.assertEqual(status, 415)
        for body in [{"action": "reboot"}, {"action": "channel"}, {"action": "channel", "channel": "beta"}, "check"]:
            status, _ = self.request("POST", body)
            self.assertEqual(status, 400, body)
        # JSON null is JSON, and still no request.
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("POST", "/api/update", body=b"null", headers={"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"})
        self.assertEqual(conn.getresponse().status, 400)
        conn.close()
        self.assertEqual(self.calls(), ["version", "commit", "channel"])

    def test_switching_the_channel_checks_it(self):
        self.offer("available 0.2.0")
        self.act("check")
        preview = "1a2b3c4d" * 5
        self.offer(f"available {preview}")
        body = self.act("channel", channel="preview")
        self.assertEqual((body["channel"], body["status"], body["version"], body["checkError"]), ("preview", "available", preview, ""))
        self.assertEqual(self.calls()[-2:], ["channel preview", "check"])
        self.assertEqual(self.request("GET")[1]["channel"], "preview")

        # A new server reads it back.
        self.server.shutdown()
        self.server.server_close()
        self.start(DirectUpdater)
        self.assertEqual(self.request("GET")[1]["channel"], "preview")

    def test_switching_the_channel_forgets_what_the_other_one_found(self):
        self.offer("available 0.2.0")
        self.act("check")
        (self.dir / "check.fail").touch()
        body = self.act("channel", channel="preview")
        self.assertEqual(body["checkError"], "can't reach origin")
        self.assertEqual((body["channel"], body["status"], body["version"]), ("preview", "", ""))

    def test_the_channel_stays_while_bookkeeping_updates(self):
        with self.updater.lock:
            self.updater.status = "installing"
        status, body = self.request("POST", {"action": "channel", "channel": "preview"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "can't change the channel while Bookkeeping updates; try again when it is done")
        self.assertEqual(self.request("GET")[1]["channel"], "stable")
        self.assertNotIn("channel preview", self.calls())

    def test_a_failed_channel_change_says_why(self):
        (self.dir / "channel.fail").touch()
        status, body = self.request("POST", {"action": "channel", "channel": "preview"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "/app is not a git checkout, so there is nothing to update from")
        self.assertEqual(self.request("GET")[1]["channel"], "stable")

    def test_without_an_updater_there_is_no_api(self):
        self.server.shutdown()
        self.server.server_close()
        self.server = server.BookkeepingServer(0, self.dir / "bookkeeping.json", self.dir / "colors.toml")
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.assertEqual(self.request("GET")[0], 404)
        self.assertEqual(self.request("POST", {"action": "check"})[0], 404)


class NamesAgreeTest(unittest.TestCase):
    """setup installs the unit and port that the update script restarts and
    asks, and the server listens on."""

    def value(self, script, name):
        found = re.search(rf"^{name}=(\S+)$", (ROOT / script).read_text(), re.MULTILINE)
        self.assertIsNotNone(found, f"{name}= in {script}")
        return found.group(1)

    def test_setup_update_and_server(self):
        unit = self.value("setup", "UNIT")
        self.assertEqual(unit, "omarchy-bookkeeping.service")
        self.assertEqual(self.value("update", "UNIT"), unit)
        self.assertEqual(int(self.value("setup", "PORT")), server.PORT)
        self.assertEqual(self.value("update", "URL"), f"http://127.0.0.1:{server.PORT}/")
        self.assertEqual(updates.INSTALL_UNIT, unit.removesuffix(".service") + "-update")
        self.assertEqual(updates.SCRIPT, ROOT / "update")


if __name__ == "__main__":
    unittest.main()
