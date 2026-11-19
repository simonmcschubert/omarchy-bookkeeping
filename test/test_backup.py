"""The backup script and setup --backup, run for real against temporary
directories. Stand-ins for ssh (a destination that can't be reached, or
refuses the key) and for systemctl (runs the service's command at once)."""

import hashlib
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKUP = ROOT / "backup"
SETUP = ROOT / "setup"
UNIT = "omarchy-bookkeeping-backup"

# Records each call; `start` runs the service's ExecStart, as systemd would.
FAKE_SYSTEMCTL = """#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
if [[ $1 == --user && $2 == start ]]; then
  command=$(sed -n 's/^ExecStart=//p' "$XDG_CONFIG_HOME/systemd/user/$3")
  $command
fi
exit 0
"""


def fake_ssh(message):
    return f"#!/usr/bin/env bash\necho '{message}' >&2\nexit 255\n"


@unittest.skipUnless(shutil.which("rsync"), "rsync is not installed")
class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.state = root / "state" / "omarchy-bookkeeping"
        self.config = root / "config" / "omarchy-bookkeeping" / "backup.conf"
        self.dest = root / "server" / "backups" / "books"
        self.bin = root / "bin"
        self.bin.mkdir()
        self.log = root / "systemctl.log"
        self.env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "HOME": str(root / "home"),
            "XDG_STATE_HOME": str(root / "state"),
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_RUNTIME_DIR": str(root),
            "FAKE_LOG": str(self.log),
        }
        (self.state / "backups").mkdir(parents=True)
        (self.state / "receipts").mkdir()
        (self.state / "browser" / "Default").mkdir(parents=True)
        self.write("bookkeeping.json", '{"version": 1, "entries": []}\n')
        self.write("backups/bookkeeping-2026-11-18.json", '{"version": 1}\n')
        self.write("receipts/" + "a" * 64 + ".pdf", "%PDF-1.4 receipt")
        self.write("browser/Default/Cookies", "not for the backup")
        self.write(".bookkeeping-x1.tmp", "half a save")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, name, text):
        (self.state / name).write_text(text)

    def configure(self, destination):
        self.config.parent.mkdir(parents=True, exist_ok=True)
        self.config.write_text(f"destination={destination}\n")

    def tool(self, name, script):
        path = self.bin / name
        path.write_text(script)
        path.chmod(0o755)

    def run_script(self, *args, extra=None, script=BACKUP):
        return subprocess.run([str(script), *args], env={**self.env, **(extra or {})}, capture_output=True, text=True, timeout=60)

    def status(self):
        lines = (self.state / "backup-status").read_text().splitlines()
        return dict(line.split("=", 1) for line in lines)

    def copied(self):
        return sorted(str(p.relative_to(self.dest)) for p in self.dest.rglob("*") if p.is_file())

    def test_copies_all_but_the_browser_profile(self):
        self.configure(self.dest)
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("3 files copied", result.stdout)
        self.assertEqual(self.copied(), ["backups/bookkeeping-2026-11-18.json", "bookkeeping.json", "receipts/" + "a" * 64 + ".pdf"])
        self.assertEqual(stat.S_IMODE(self.dest.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.dest / "bookkeeping.json").stat().st_mode), 0o600)
        status = self.status()
        self.assertEqual(status["result"], "ok")
        self.assertEqual(status["destination"], str(self.dest))
        revision = hashlib.sha256((self.state / "bookkeeping.json").read_bytes()).hexdigest()
        self.assertEqual(status["last_revision"], revision, "the revision the app compares with")

    def test_nothing_there_is_deleted_and_old_versions_stay(self):
        self.configure(self.dest)
        self.run_script()
        old = (self.state / "bookkeeping.json").read_text()
        (self.state / "receipts" / ("a" * 64 + ".pdf")).unlink()
        (self.state / "backups" / "bookkeeping-2026-11-18.json").unlink()
        self.write("bookkeeping.json", '{"version": 1, "entries": ["changed"]}\n')
        os.utime(self.state / "bookkeeping.json", (1, 1))  # surely not the old time

        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("receipts/" + "a" * 64 + ".pdf", self.copied())
        self.assertIn("backups/bookkeeping-2026-11-18.json", self.copied())
        self.assertIn("changed", (self.dest / "bookkeeping.json").read_text())
        replaced = list((self.dest / "replaced").glob("*/bookkeeping.json"))
        self.assertEqual(len(replaced), 1)
        self.assertEqual(replaced[0].read_text(), old)

    def test_a_same_size_edit_in_the_same_second_is_copied(self):
        self.configure(self.dest)
        self.run_script()
        data = self.state / "bookkeeping.json"
        before = data.stat()
        data.write_text(data.read_text().replace("[]", "{}"))
        os.utime(data, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(data.stat().st_size, before.st_size)

        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual((self.dest / "bookkeeping.json").read_text(), data.read_text())
        self.assertEqual(self.status()["last_revision"], hashlib.sha256(data.read_bytes()).hexdigest())

    def test_the_timer_copies_once_a_day(self):
        self.configure(self.dest)
        self.assertEqual(self.run_script("--daily").returncode, 0)
        self.write("bookkeeping.json", '{"version": 1, "entries": ["later"]}\n')
        result = self.run_script("--daily")
        self.assertEqual((result.returncode, result.stdout), (0, ""), "quiet when today's copy is done")
        self.assertNotIn("later", (self.dest / "bookkeeping.json").read_text())

        other = Path(self.tmp.name) / "other"
        self.configure(other)
        self.assertEqual(self.run_script("--daily").returncode, 0)
        self.assertIn("later", (other / "bookkeeping.json").read_text(), "a new destination gets its copy the same day")

    def test_without_a_destination(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn("setup --backup", result.stderr)

    def test_quiet_when_the_server_cannot_be_reached(self):
        self.tool("ssh", fake_ssh("ssh: connect to host server port 22: Connection timed out"))
        self.configure("user@server:backups/books")
        success = "2026-11-18T03:00:00+01:00"
        (self.state / "backup-status").write_text(f"destination=user@server:backups/books\nresult=ok\nlast_success={success}\nlast_revision=abc\n")
        result = self.run_script("--daily", extra={"RSYNC_RSH": "ssh"})
        self.assertEqual(result.returncode, 0, "no failed unit while offline")
        self.assertEqual(result.stdout, "server not reachable; the timer tries again in an hour.\n")
        self.assertEqual(result.stderr, "", "quiet")
        status = self.status()
        self.assertEqual(status["result"], "unreachable")
        self.assertEqual((status["last_success"], status["last_revision"]), (success, "abc"), "the last copy that worked stays on show")

        self.configure("user@other:backups/books")
        self.run_script("--daily", extra={"RSYNC_RSH": "ssh"})
        self.assertEqual(self.status()["last_success"], "", "a copy to the old destination is none to the new one")

    def test_no_status_after_the_backup_was_turned_off_while_running(self):
        # The "server" is reached just as setup --no-backup removes the config.
        self.tool("ssh", f"#!/usr/bin/env bash\nrm -f '{self.config}'\necho 'ssh: connect to host server port 22: Connection timed out' >&2\nexit 255\n")
        self.configure("user@server:backups/books")
        self.run_script(extra={"RSYNC_RSH": "ssh"})
        self.assertFalse((self.state / "backup-status").exists())

    def test_a_refused_key_is_an_error_with_a_reason(self):
        self.tool("ssh", fake_ssh("user@server: Permission denied (publickey)."))
        self.configure("user@server:backups/books")
        result = self.run_script(extra={"RSYNC_RSH": "ssh"})
        self.assertEqual(result.returncode, 1)
        status = self.status()
        self.assertEqual(status["result"], "failed")
        self.assertIn("server refused the SSH key", status["message"])

    def test_setup_backup_installs_the_timer_and_makes_the_first_copy(self):
        self.tool("systemctl", FAKE_SYSTEMCTL)
        self.tool("journalctl", "#!/bin/sh\n")
        for wrong in ("server:", "server:~", "server:/", "relative/path", "/"):
            result = self.run_script("--backup", wrong, script=SETUP)
            self.assertEqual(result.returncode, 1, wrong)
        self.assertFalse(self.config.exists())

        result = self.run_script("--backup", str(self.dest), extra={"SSH_AUTH_SOCK": f"{self.tmp.name}/agent.sock"}, script=SETUP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Done: 3 files copied", result.stdout)
        self.assertEqual(len(self.copied()), 3)
        config = self.config.read_text()
        self.assertIn(f"destination={self.dest}\n", config)
        self.assertIn(f"ssh_auth_sock={self.tmp.name}/agent.sock\n", config, "the timer gets the session's SSH agent")
        units = Path(self.env["XDG_CONFIG_HOME"]) / "systemd" / "user"
        self.assertIn(f"ExecStart={BACKUP} --daily", (units / f"{UNIT}.service").read_text())
        timer = (units / f"{UNIT}.timer").read_text()
        self.assertIn("OnCalendar=hourly", timer)
        self.assertIn("Persistent=true", timer)
        self.assertIn(f"--user enable --now {UNIT}.timer", self.log.read_text())

        result = self.run_script("--no-backup", script=SETUP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"--user stop {UNIT}.service", self.log.read_text(), "a copy running right now stops too")
        self.assertFalse((units / f"{UNIT}.timer").exists())
        self.assertFalse(self.config.exists())
        self.assertFalse((self.state / "backup-status").exists(), "Settings › Backup says: not set up")
        self.assertEqual(len(self.copied()), 3, "the copies stay")


if __name__ == "__main__":
    unittest.main()
