import http.client
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.data_file = Path(self.dir.name) / "bookkeeping.json"
        self.httpd = server.BookkeepingServer(0, self.data_file, Path(self.dir.name) / "colors.toml")
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.dir.cleanup()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        all_headers = {"Host": f"127.0.0.1:{self.port}", **(headers or {})}
        conn.request(method, path, body=body, headers=all_headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        return response, data

    def put(self, revision, data):
        body = json.dumps({"revision": revision, "data": data})
        return self.request("PUT", "/api/data", body, {"Content-Type": "application/json"})

    def test_page_and_scripts(self):
        response, body = self.request("GET", "/")
        self.assertEqual(response.status, 200)
        self.assertIn(b"Bookkeeping", body)
        self.assertIn("script-src 'self'", response.getheader("Content-Security-Policy"))
        for path in ("/app.mjs", "/books.mjs", "/import.mjs", "/backup.mjs", "/style.css", "/icon.svg"):
            self.assertEqual(self.request("GET", path)[0].status, 200, path)

    def test_save_and_conflict(self):
        response, body = self.request("GET", "/api/data")
        current = json.loads(body)
        self.assertIsNone(current["data"])
        self.assertEqual(current["revision"], "none")

        data = {"version": server.VERSION, "entries": []}
        response, body = self.put("none", data)
        self.assertEqual(response.status, 200)
        revision = json.loads(body)["revision"]
        self.assertEqual(json.loads(self.data_file.read_text())["entries"], [])

        # A second save from the old revision is refused with the latest.
        response, body = self.put("none", {**data, "entries": [1]})
        self.assertEqual(response.status, 409)
        self.assertEqual(json.loads(body)["revision"], revision)

        response, _ = self.put(revision, {"version": 999})
        self.assertEqual(response.status, 400)

    def test_backup_before_first_save_of_the_day(self):
        data = {"version": server.VERSION, "entries": []}
        _, body = self.put("none", data)
        self.put(json.loads(body)["revision"], {**data, "entries": [1]})
        copies = list((Path(self.dir.name) / "backups").glob("bookkeeping-*.json"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(json.loads(copies[0].read_text())["entries"], [])

    def test_receipts(self):
        pdf = b"%PDF-1.4 test"
        response, body = self.request("POST", "/api/receipts", pdf, {"Content-Type": "application/pdf"})
        self.assertEqual(response.status, 200)
        name = json.loads(body)["file"]
        self.assertTrue(name.endswith(".pdf"))
        response, body = self.request("GET", f"/api/receipts/{name}")
        self.assertEqual(response.status, 200)
        self.assertEqual(body, pdf)
        self.assertEqual(response.getheader("Content-Type"), "application/pdf")

        response, _ = self.request("POST", "/api/receipts", b"<x/>", {"Content-Type": "application/xml"})
        name = json.loads(_)["file"]
        response, _ = self.request("GET", f"/api/receipts/{name}")
        self.assertTrue(response.getheader("Content-Type").startswith("text/plain"))

        self.assertEqual(self.request("POST", "/api/receipts", b"x", {"Content-Type": "text/html"})[0].status, 415)
        self.assertEqual(self.request("GET", "/api/receipts/../bookkeeping.json")[0].status, 404)
        self.assertEqual(self.request("GET", "/api/receipts/abc.pdf")[0].status, 404)

    def test_other_hosts_and_origins_are_refused(self):
        self.assertEqual(self.request("GET", "/api/data", headers={"Host": "evil.example"})[0].status, 403)
        response, _ = self.request("POST", "/api/receipts", b"x", {"Content-Type": "application/pdf", "Origin": "http://evil.example"})
        self.assertEqual(response.status, 403)

    def test_backup_status(self):
        _, body = self.request("GET", "/api/backup")
        reply = json.loads(body)
        self.assertIsNone(reply["status"], "no backup set up")
        self.assertTrue(reply["setup"].endswith("/setup"))
        self.assertTrue(reply["backup"].endswith("/backup"))

        (Path(self.dir.name) / "backup-status").write_text(
            "destination=user@server:backups/books\n"
            "last_attempt=2026-11-19T14:00:00+01:00\n"
            "result=unreachable\n"
            "message=server not reachable\n"
            "last_success=2026-11-19T03:00:00+01:00\n"
            "last_revision=abc\n"
        )
        _, body = self.request("GET", "/api/backup")
        self.assertEqual(
            json.loads(body)["status"],
            {
                "destination": "user@server:backups/books",
                "lastAttempt": "2026-11-19T14:00:00+01:00",
                "result": "unreachable",
                "message": "server not reachable",
                "lastSuccess": "2026-11-19T03:00:00+01:00",
                "lastRevision": "abc",
            },
        )

    def test_theme(self):
        (Path(self.dir.name) / "colors.toml").write_text('background = "#ffffff"\naccent = "#123456"\n')
        _, body = self.request("GET", "/theme.css")
        self.assertIn(b"--accent: #123456;", body)
        self.assertIn(b"color-scheme: light;", body)


if __name__ == "__main__":
    unittest.main()
