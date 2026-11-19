"""invoice_pdf.py and POST /api/invoices, with small fake programs in place
of Chromium and the Mustang validator, so the steps around them are
checked anywhere. test/invoice-pdf.test.mjs runs the real tools."""

import http.client
import json
import os
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import invoice_pdf  # noqa: E402
import server  # noqa: E402

try:
    import pikepdf
except ImportError:
    pikepdf = None

# Mustang's report, as the validator prints it (shortened).
VALID_REPORT = """<?xml version="1.0" encoding="UTF-8"?>

<validation filename="invoice.pdf" datetime="2026-11-19 14:43:49">
  <pdf>ValidationResult [flavour=3u, totalAssertions=3638, assertions=[], isCompliant=true]
    <info><signature>unknown</signature></info>
    <summary status="valid"/>
  </pdf>
  <xml>
    <info>
      <version>2</version>
      <profile>urn:cen.eu:en16931:2017</profile>
      <validator version="2.26.0"/>
    </info>
    <summary status="valid"/>
  </xml>
  <summary status="valid"/>
</validation>
"""

INVALID_REPORT = """<?xml version="1.0" encoding="UTF-8"?>
<validation filename="invoice.pdf" datetime="2026-11-19 14:43:09">
  <pdf>ValidationResult [flavour=3u, totalAssertions=3638, assertions=[], isCompliant=true]
    <summary status="valid"/>
  </pdf>
  <xml>
    <info><profile>urn:cen.eu:en16931:2017</profile><validator version="2.26.0"/></info>
    <messages>
      <error type="4" location="/*:CrossIndustryInvoice[1]/*:SellerTradeParty[1]" criterion="(ram:ID)">[BR-CO-26]-In order for the buyer
        to automatically identify a supplier, the Seller identifier (BT-29) shall be present.</error>
      <warning type="27" location="/x">[PEPPOL-EN16931-R008]-Document MUST not contain empty elements.</warning>
    </messages>
    <summary status="invalid"/>
  </xml>
  <messages></messages>
  <summary status="invalid"/>
</validation>
"""


def minimal_pdf():
    """A one-page PDF, written by hand."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n" % (len(objects) + 1, xref)
    return out + b"%%EOF\n"


def fake_program(path, body):
    path.write_text(f"#!{sys.executable}\n" + textwrap.dedent(body))
    path.chmod(0o755)
    return str(path)


class ReportTest(unittest.TestCase):
    def test_valid(self):
        report = invoice_pdf.parse_report("log line\n" + VALID_REPORT)
        self.assertEqual(
            report,
            {
                "valid": True,
                "pdf": True,
                "pdfa": "3u",
                "xml": True,
                "profile": "urn:cen.eu:en16931:2017",
                "validator": "Mustang 2.26.0",
                "messages": [],
            },
        )

    def test_invalid(self):
        report = invoice_pdf.parse_report(INVALID_REPORT)
        self.assertFalse(report["valid"])
        self.assertTrue(report["pdf"])
        self.assertFalse(report["xml"])
        self.assertEqual([m["level"] for m in report["messages"]], ["error", "warning"])
        self.assertTrue(report["messages"][0]["text"].startswith("[BR-CO-26]-In order for the buyer to automatically"))

    def test_no_report(self):
        with self.assertRaises(invoice_pdf.InvoiceError):
            invoice_pdf.parse_report("Exception in thread main")


class ToolsTest(unittest.TestCase):
    def test_found_and_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            chromium = fake_program(Path(tmp) / "chromium", "")
            jar = Path(tmp) / "mustang.jar"
            env = {"BOOKKEEPING_CHROMIUM": chromium, "BOOKKEEPING_JAVA": str(Path(tmp) / "no-java"), "BOOKKEEPING_MUSTANG": str(jar), "PATH": ""}
            tools = invoice_pdf.find_tools(env)
            self.assertEqual(tools["chromium"], chromium)
            self.assertIsNone(tools["java"])
            self.assertIsNone(tools["mustang"])
            missing = invoice_pdf.missing_tools(tools)
            self.assertIn("Java (jre-openjdk-headless)", missing)
            self.assertIn("the Mustang validator", missing)
            jar.write_bytes(b"PK")
            self.assertEqual(invoice_pdf.find_tools(env)["mustang"], str(jar))


@unittest.skipIf(pikepdf is None, "needs pikepdf (python-pikepdf)")
class PdfaTest(unittest.TestCase):
    def test_pdfa_with_the_xml(self):
        xml = b"<rsm:CrossIndustryInvoice/>"
        out = invoice_pdf.make_pdfa(minimal_pdf(), xml, "Rechnung 42 & <mehr>")
        with pikepdf.open(__import__("io").BytesIO(out)) as pdf:
            self.assertEqual(pdf.pdf_version, "1.7")
            spec = pdf.Root.AF[0]
            self.assertEqual(str(spec.UF), "factur-x.xml")
            self.assertEqual(spec.AFRelationship, pikepdf.Name.Data)
            self.assertEqual(spec.EF.F.read_bytes(), xml)
            self.assertEqual(spec.EF.F.Subtype, pikepdf.Name("/text/xml"))
            self.assertEqual(str(pdf.Root.Names.EmbeddedFiles.Names[0]), "factur-x.xml")
            intent = pdf.Root.OutputIntents[0]
            self.assertEqual(intent.S, pikepdf.Name.GTS_PDFA1)
            self.assertEqual(intent.DestOutputProfile.N, 3)
            xmp = pdf.Root.Metadata.read_bytes().decode()
            for part in ("<pdfaid:part>3</pdfaid:part>", "<pdfaid:conformance>U</pdfaid:conformance>", "<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>", "<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>", "Rechnung 42 &amp; &lt;mehr&gt;"):
                self.assertIn(part, xmp)
            self.assertEqual(str(pdf.docinfo.Title), "Rechnung 42 & <mehr>")
            self.assertEqual(str(pdf.docinfo.Producer), "Bookkeeping")


class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        tmp = Path(self.dir.name)
        self.data_file = tmp / "bookkeeping.json"
        (tmp / "printed.pdf").write_bytes(minimal_pdf())
        self.report = tmp / "report.xml"
        self.report.write_text(VALID_REPORT)
        self.calls = tmp / "calls.log"
        chromium = fake_program(
            tmp / "chromium",
            f"""
            import shutil, sys
            out = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--print-to-pdf=")][0]
            assert sys.argv[-1].startswith("file://") and sys.argv[-1].endswith("/invoice.html")
            open({str(self.calls)!r}, "a").write("chromium " + " ".join(sys.argv[1:]) + "\\n")
            shutil.copyfile({str(tmp / "printed.pdf")!r}, out)
            """,
        )
        java = fake_program(
            tmp / "java",
            f"""
            import sys
            open({str(self.calls)!r}, "a").write("java " + " ".join(sys.argv[1:]) + "\\n")
            print(open({str(self.report)!r}).read())
            sys.exit(0 if "invalid" not in open({str(self.report)!r}).read() else 255)
            """,
        )
        jar = tmp / "mustang.jar"
        jar.write_bytes(b"PK")
        self.env = mock.patch.dict(os.environ, {"BOOKKEEPING_CHROMIUM": chromium, "BOOKKEEPING_JAVA": java, "BOOKKEEPING_MUSTANG": str(jar)})
        self.env.start()
        self.httpd = server.BookkeepingServer(0, self.data_file, tmp / "colors.toml")
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.env.stop()
        self.dir.cleanup()

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        headers = {"Host": f"127.0.0.1:{self.port}", "Content-Type": "application/json"}
        conn.request(method, path, body=None if body is None else json.dumps(body), headers=headers)
        response = conn.getresponse()
        data = json.loads(response.read())
        conn.close()
        return response.status, data

    def invoice(self):
        return {"html": "<!doctype html><title>Rechnung 42</title>", "xml": "<rsm:CrossIndustryInvoice/>", "title": "Rechnung 42"}

    def receipts(self):
        directory = self.data_file.parent / "receipts"
        return sorted(p.name for p in directory.glob("*")) if directory.exists() else []

    def test_tools_and_bad_requests(self):
        status, body = self.request("GET", "/api/invoices/tools")
        self.assertEqual(status, 200)
        self.assertEqual(body["ready"], invoice_pdf.find_tools()["pikepdf"])
        self.assertEqual(self.request("POST", "/api/invoices", {"html": "x"})[0], 400)
        with mock.patch.dict(os.environ, {"BOOKKEEPING_JAVA": "/nonexistent/java"}):
            status, body = self.request("POST", "/api/invoices", self.invoice())
            self.assertEqual(status, 503)
            self.assertIn("Java (jre-openjdk-headless)", body["missing"])
            self.assertIn("Run setup", body["error"])

    @unittest.skipIf(pikepdf is None, "needs pikepdf (python-pikepdf)")
    def test_valid_invoice_is_kept(self):
        status, body = self.request("POST", "/api/invoices", self.invoice())
        self.assertEqual(status, 200, body)
        self.assertTrue(body["validation"]["valid"])
        self.assertEqual(self.receipts(), [body["file"]])
        self.assertTrue(body["file"].endswith(".pdf"))
        kept = (self.data_file.parent / "receipts" / body["file"]).read_bytes()
        self.assertEqual(len(kept), body["size"])
        self.assertIn(b"factur-x.xml", kept)
        calls = self.calls.read_text()
        self.assertIn("--headless", calls)
        self.assertIn("--proxy-server=socks5://127.0.0.1:9", calls)
        self.assertIn("--action validate --no-notices --source", calls)
        # The same invoice again is the same file.
        self.assertEqual(self.request("POST", "/api/invoices", self.invoice())[1]["file"], body["file"])

    @unittest.skipIf(pikepdf is None, "needs pikepdf (python-pikepdf)")
    def test_invalid_invoice_is_not_kept(self):
        self.report.write_text(INVALID_REPORT)
        status, body = self.request("POST", "/api/invoices", self.invoice())
        self.assertEqual(status, 422)
        self.assertFalse(body["validation"]["valid"])
        self.assertIn("BR-CO-26", body["validation"]["messages"][0]["text"])
        self.assertEqual(self.receipts(), [])

    @unittest.skipIf(pikepdf is None, "needs pikepdf (python-pikepdf)")
    def test_tool_failures_are_reported(self):
        self.report.write_text("Exception in thread main: out of memory")
        status, body = self.request("POST", "/api/invoices", self.invoice())
        self.assertEqual(status, 500)
        self.assertIn("Mustang validator failed", body["error"])
        (Path(self.dir.name) / "printed.pdf").write_bytes(b"not a pdf")
        status, body = self.request("POST", "/api/invoices", self.invoice())
        self.assertEqual(status, 500)
        self.assertIn("Chromium made no PDF", body["error"])


if __name__ == "__main__":
    unittest.main()
