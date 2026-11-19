#!/usr/bin/env python3
"""Bookkeeping: serves the web app, saves its data file and keeps receipts.

Listens on 127.0.0.1 only. The data lives in one JSON file,
~/.local/state/omarchy-bookkeeping/bookkeeping.json, in a directory only the
owner can open; receipt files sit next to it in receipts/, named by their
content, and e-invoices among them are read for the page (einvoice_reader).
The page's colors come from the current Omarchy theme.

Python standard library only (3.11 or newer).
"""

import argparse
import datetime
import hashlib
import http.server
import json
import os
import re
import sys
import tempfile
import threading
import tomllib
import traceback
from pathlib import Path

import einvoice_reader

PORT = 47221
APP_DIR = Path(__file__).resolve().parent / "app"
SETUP_SCRIPT = Path(__file__).resolve().parent / "setup"
BACKUP_SCRIPT = Path(__file__).resolve().parent / "backup"
MAX_BODY = 20 * 1024 * 1024
MAX_RECEIPT = 25 * 1024 * 1024
NO_FILE = "none"
VERSION = 1  # data file version; matches VERSION in app/books.mjs
NO_BODY = object()  # read_body found none it accepts, and said so

# Dated copies of the data file kept in backups/ next to it: one a day.
BACKUPS_KEPT = 60

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.mjs": ("app.mjs", "text/javascript; charset=utf-8"),
    "/books.mjs": ("books.mjs", "text/javascript; charset=utf-8"),
    "/import.mjs": ("import.mjs", "text/javascript; charset=utf-8"),
    "/backup.mjs": ("backup.mjs", "text/javascript; charset=utf-8"),
    "/assets.mjs": ("assets.mjs", "text/javascript; charset=utf-8"),
    "/assets-view.mjs": ("assets-view.mjs", "text/javascript; charset=utf-8"),
    "/einvoice.mjs": ("einvoice.mjs", "text/javascript; charset=utf-8"),
    "/einvoice.css": ("einvoice.css", "text/css; charset=utf-8"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
}

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    "connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
)

# Receipt types: what the page may send, and how a file is served back.
# XML (e-invoices) is served as plain text, so it is never run as a page.
RECEIPT_TYPES = {
    "application/pdf": ("pdf", "application/pdf"),
    "image/jpeg": ("jpg", "image/jpeg"),
    "image/png": ("png", "image/png"),
    "image/webp": ("webp", "image/webp"),
    "application/xml": ("xml", "text/plain; charset=utf-8"),
    "text/xml": ("xml", "text/plain; charset=utf-8"),
}
SERVED_TYPES = {ext: served for ext, served in RECEIPT_TYPES.values()}
RECEIPT_NAME = re.compile(r"^[0-9a-f]{64}\.(pdf|jpg|png|webp|xml)$")

# Tokyo Night, Omarchy's default theme: used when no theme file is found.
DEFAULT_THEME = {
    "background": "#1a1b26",
    "lighter_background": "#24283b",
    "dark_background": "#13141c",
    "foreground": "#a9b1d6",
    "bright_foreground": "#c0caf5",
    "dark_foreground": "#565f89",
    "muted": "#414868",
    "selection": "#292e42",
    "accent": "#7aa2f7",
    "red": "#f7768e",
    "green": "#9ece6a",
    "yellow": "#e0af68",
}

# CSS variable -> colors.toml keys to try, in order. The fallbacks follow
# omarchy-theme-color: canonical names, legacy short names, ANSI colors.
THEME_VARIABLES = {
    "bg": ["background", "bg", "color0"],
    "surface": ["lighter_background", "lighter_bg", "background", "bg", "color0"],
    "sunken": ["dark_background", "dark_bg", "background", "bg", "color0"],
    "fg": ["foreground", "fg", "color7"],
    "fg-strong": ["bright_foreground", "bright_fg", "color15", "foreground", "fg", "color7"],
    "fg-muted": ["dark_foreground", "dark_fg", "color8", "foreground", "fg", "color7"],
    "border": ["muted", "color8", "dark_foreground", "dark_fg"],
    "selection": ["selection", "selection_background", "color8"],
    "accent": ["accent", "blue", "color4"],
    "red": ["red", "color1"],
    "green": ["green", "color2"],
    "yellow": ["yellow", "color3"],
}

HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


def state_dir():
    base = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(base) / "omarchy-bookkeeping"


def theme_file():
    return Path.home() / ".local" / "state" / "omarchy" / "current" / "theme" / "colors.toml"


def revision_of(data):
    return NO_FILE if data is None else hashlib.sha256(data).hexdigest()


def read_file(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def write_atomic(path, data):
    """Writes data to path so a crash leaves the old file or the new one."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".bookkeeping-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    dir_fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)


def backup_dir(data_file):
    return Path(data_file).parent / "backups"


def receipt_dir(data_file):
    return Path(data_file).parent / "receipts"


def backup_status(data_file):
    """The nightly copy to another computer, as the backup script last wrote
    it to backup-status next to the data file; None when none is set up."""
    raw = read_file(Path(data_file).parent / "backup-status")
    if raw is None:
        return None
    fields = {}
    for line in raw.decode("utf-8", "replace").splitlines():
        key, found, value = line.partition("=")
        if found:
            fields[key.strip()] = value.strip()
    return {
        "destination": fields.get("destination", ""),
        "lastAttempt": fields.get("last_attempt") or None,
        "result": fields.get("result") or None,  # ok, unreachable or failed
        "message": fields.get("message", ""),
        "lastSuccess": fields.get("last_success") or None,
        "lastRevision": fields.get("last_revision") or None,
    }


def home_short(path):
    """The path as typed in a terminal: ~/.local/share/… for one at home."""
    home = Path.home()
    return f"~/{Path(path).relative_to(home)}" if Path(path).is_relative_to(home) else str(path)


def today():
    """The local date, as backups are named: 2026-11-19."""
    return datetime.date.today().isoformat()


def back_up(data_file, raw):
    """Before the first save of a day, keeps the file as it was in
    backups/<name>-<date>.json, and the BACKUPS_KEPT newest of those. A later
    save that day keeps the copy from before the first one, so a bad import
    or a slip can be undone with the file from that morning."""
    if raw is None:
        return
    data_file = Path(data_file)
    directory = backup_dir(data_file)
    target = directory / f"{data_file.stem}-{today()}.json"
    if target.exists():
        return
    write_atomic(target, raw)
    copies = sorted(directory.glob(f"{data_file.stem}-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json"))
    for old in copies[:-BACKUPS_KEPT]:
        old.unlink(missing_ok=True)


def read_einvoice(body, ext):
    """What einvoice_reader finds in a receipt file. An error in the reader
    is logged and said, so the file still works as a plain receipt."""
    try:
        return einvoice_reader.read_receipt(body, ext)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return {"status": "problem", "message": "The app failed to read this file as an e-invoice (see the server log)."}


def luminance_is_light(color):
    value = color.lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    r, g, b = (int(value[i : i + 2], 16) for i in (0, 2, 4))
    return r + g + b > 382


def theme_css(path):
    """CSS variables from an Omarchy colors.toml; defaults for anything missing."""
    colors = {}
    try:
        with open(path, "rb") as f:
            colors = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        colors = {}

    def pick(keys):
        for key in keys:
            value = colors.get(key)
            if isinstance(value, str) and HEX_COLOR.match(value.strip()):
                return value.strip()
        return None

    lines = []
    for variable, keys in THEME_VARIABLES.items():
        lines.append(f"  --{variable}: {pick(keys) or DEFAULT_THEME[keys[0]]};")

    mode = str(colors.get("mode") or colors.get("theme_type") or "").lower()
    if mode not in ("light", "dark"):
        if (Path(path).parent / "light.mode").exists():
            mode = "light"
        else:
            background = pick(THEME_VARIABLES["bg"])
            mode = "light" if background and luminance_is_light(background) else "dark"
    lines.append(f"  color-scheme: {mode};")
    return ":root {\n" + "\n".join(lines) + "\n}\n"


class BookkeepingServer(http.server.ThreadingHTTPServer):
    """A thread per connection, so an idle browser connection blocks nothing.
    Saves hold a lock, so they never overlap."""

    daemon_threads = True

    def __init__(self, port, data_file, theme_path):
        self.data_file = Path(data_file)
        self.theme_path = Path(theme_path)
        self.saving = threading.Lock()
        super().__init__(("127.0.0.1", port), Handler)
        bound = self.server_address[1]
        self.hosts = {f"127.0.0.1:{bound}", f"localhost:{bound}"}
        self.origins = {f"http://{host}" for host in self.hosts}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "Bookkeeping"
    sys_version = ""
    timeout = 30  # seconds; drops connections that never send a request

    def log_message(self, format, *args):
        pass  # no access log; errors go to stderr through log_error

    def log_error(self, format, *args):
        sys.stderr.write("%s\n" % (format % args))

    def send_body(self, status, body, content_type, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, value, extra=None):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_body(status, body, "application/json; charset=utf-8", extra)

    def allowed(self):
        # The Host check stops other websites from reaching this server
        # through DNS rebinding; the Origin check stops cross-site writes.
        if self.headers.get("Host") not in self.server.hosts:
            self.send_json(403, {"error": "Unknown host"})
            return False
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self.server.origins:
            self.send_json(403, {"error": "Unknown origin"})
            return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.allowed():
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/data":
            self.send_json(200, self.current())
        elif path == "/api/backup":
            status = backup_status(self.server.data_file)
            self.send_json(200, {"status": status, "setup": home_short(SETUP_SCRIPT), "backup": home_short(BACKUP_SCRIPT)})
        elif path.startswith("/api/receipts/"):
            self.get_receipt(path.removeprefix("/api/receipts/"))
        elif path.startswith("/api/einvoice/"):
            self.get_einvoice(path.removeprefix("/api/einvoice/"))
        elif path == "/theme.css":
            body = theme_css(self.server.theme_path).encode()
            self.send_body(200, body, "text/css; charset=utf-8")
        elif path in STATIC:
            name, content_type = STATIC[path]
            body = (APP_DIR / name).read_bytes()
            extra = {"Content-Security-Policy": CSP} if name.endswith(".html") else None
            self.send_body(200, body, content_type, extra)
        else:
            self.send_json(404, {"error": "Not found"})

    def current(self):
        """The file as GET returns it: revision, data, and error if unreadable."""
        raw = read_file(self.server.data_file)
        result = {
            "revision": revision_of(raw),
            "file": str(self.server.data_file),
            "backups": str(backup_dir(self.server.data_file)),
            "receipts": str(receipt_dir(self.server.data_file)),
            "data": None,
        }
        if raw is not None:
            try:
                result["data"] = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                result["error"] = f"The data file is not valid JSON ({error})"
        return result

    def get_receipt(self, name):
        if not RECEIPT_NAME.match(name):
            self.send_json(404, {"error": "Not found"})
            return
        body = read_file(receipt_dir(self.server.data_file) / name)
        if body is None:
            self.send_json(404, {"error": "Not found"})
            return
        served = SERVED_TYPES[name.rsplit(".", 1)[1]]
        self.send_body(200, body, served, {"Content-Disposition": f'inline; filename="{name}"'})

    def get_einvoice(self, name):
        """The receipt read as an e-invoice, for the page to show: the XML
        itself is only ever served as plain text."""
        body = read_file(receipt_dir(self.server.data_file) / name) if RECEIPT_NAME.match(name) else None
        if body is None:
            self.send_json(404, {"error": "Not found"})
            return
        self.send_json(200, read_einvoice(body, name.rsplit(".", 1)[1]))

    def read_body(self, limit):
        """The request's body, or NO_BODY after replying with the problem."""
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self.send_json(411, {"error": "Content-Length required"})
            return NO_BODY
        if length < 0 or length > limit:
            self.send_json(413, {"error": "Too large"})
            return NO_BODY
        return self.rfile.read(length)

    def read_json(self):
        """The request's JSON body, or NO_BODY after replying with the problem.
        Only JSON: a web page cannot send that to another site without the
        browser asking this server first, which it never allows."""
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"error": "Send JSON"})
            return NO_BODY
        raw = self.read_body(MAX_BODY)
        if raw is NO_BODY:
            return NO_BODY
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return NO_BODY

    def do_POST(self):
        if not self.allowed():
            return
        if self.path.split("?", 1)[0] != "/api/receipts":
            self.send_json(404, {"error": "Not found"})
            return
        content_type = self.headers.get_content_type()
        if content_type not in RECEIPT_TYPES:
            self.send_json(415, {"error": "Send a PDF, JPEG, PNG, WebP or XML file"})
            return
        body = self.read_body(MAX_RECEIPT)
        if body is NO_BODY:
            return
        if not body:
            self.send_json(400, {"error": "The file is empty"})
            return
        ext = RECEIPT_TYPES[content_type][0]
        name = f"{hashlib.sha256(body).hexdigest()}.{ext}"
        target = receipt_dir(self.server.data_file) / name
        try:
            if not target.exists():
                write_atomic(target, body)
        except OSError as error:
            self.log_error("saving a receipt failed: %s", error)
            self.send_json(500, {"error": f"Could not save: {error.strerror}"})
            return
        self.send_json(200, {"file": name, "size": len(body), "einvoice": read_einvoice(body, ext)})

    def do_PUT(self):
        if not self.allowed():
            return
        if self.path.split("?", 1)[0] != "/api/data":
            self.send_json(404, {"error": "Not found"})
            return
        body = self.read_json()
        if body is NO_BODY:
            return
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict) or data.get("version") != VERSION:
            # Also refuses a window still running an older version of the page.
            self.send_json(400, {"error": f"Expected {{revision, data}} with data.version {VERSION}; reload the page"})
            return

        out = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode()
        with self.server.saving:
            current = self.current()
            if body.get("revision") != current["revision"] or "error" in current:
                # Another window saved first, or the file was edited by hand.
                # Same shape as GET, so the page can show the latest.
                status, reply = 409, {**current, "conflict": True}
            else:
                try:
                    back_up(self.server.data_file, read_file(self.server.data_file))
                except OSError as error:
                    # A missing copy is no reason to lose the change.
                    self.log_error("backup failed: %s", error)
                try:
                    write_atomic(self.server.data_file, out)
                    status, reply = 200, {"revision": revision_of(out)}
                except OSError as error:
                    self.log_error("save failed: %s", error)
                    status, reply = 500, {"error": f"Could not save: {error.strerror}"}
        self.send_json(status, reply)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--data", default=None, help="data file (default: ~/.local/state/omarchy-bookkeeping/bookkeeping.json)")
    args = parser.parse_args()
    data_file = Path(args.data) if args.data else state_dir() / "bookkeeping.json"
    try:
        server = BookkeepingServer(args.port, data_file, theme_file())
    except OSError as error:
        sys.exit(f"bookkeeping: cannot listen on 127.0.0.1:{args.port}: {error.strerror}")
    print(f"Bookkeeping on http://127.0.0.1:{server.server_address[1]}/ (data: {data_file})", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
