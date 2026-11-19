import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import einvoice_reader as reader  # noqa: E402
import einvoice_samples as samples  # noqa: E402


def fixture(name):
    return (samples.FIXTURES / name).read_bytes()


def read(data, ext="xml"):
    return reader.read_receipt(data if isinstance(data, bytes) else data.encode(), ext)


class FixturesTest(unittest.TestCase):
    def test_fixtures_match_the_generator(self):
        for name, make in {**samples.SAMPLES, "readings.json": samples.readings}.items():
            self.assertEqual(fixture(name), make(), f"{name} is out of date: run python3 test/einvoice_samples.py")


class EInvoiceTest(unittest.TestCase):
    def test_ubl_invoice(self):
        result = read(fixture("xrechnung-ubl.xml"))
        self.assertEqual(result["status"], "invoice")
        invoice = result["invoice"]
        self.assertEqual(invoice["syntax"], "UBL")
        self.assertEqual(invoice["format"], "XRechnung 3.0")
        self.assertEqual(invoice["container"], "xml")
        self.assertEqual(invoice["seller"]["name"], "Beispiel Hosting GmbH")
        self.assertEqual(invoice["seller"]["vatId"], "DE999999999")
        self.assertEqual(invoice["number"], "BH-2025-0117")
        self.assertEqual((invoice["issueDate"], invoice["dueDate"]), ("2025-01-15", "2025-01-29"))
        self.assertEqual((invoice["periodStart"], invoice["periodEnd"]), ("2025-01-01", "2025-01-31"))
        self.assertEqual(invoice["currency"], "EUR")
        self.assertEqual(invoice["totals"], {"lines": 2190, "net": 2190, "vat": 416, "gross": 2606, "payable": 2606})
        self.assertEqual(invoice["vat"], [{"category": "S", "rate": "19", "base": 2190, "amount": 416}])
        self.assertEqual([(line["name"], line["quantity"], line["unit"], line["net"]) for line in invoice["lines"]], [
            ("Webhosting Paket M, Januar 2025", "1", "MON", 990),
            ("Domain musterwerkstatt.example", "1", "ANN", 1200),
        ])
        self.assertEqual(invoice["payment"]["iban"], samples.SELLER_IBAN)
        self.assertFalse(invoice["credit"])
        self.assertEqual(invoice["warnings"], [])

    def test_ubl_credit_note(self):
        invoice = read(fixture("xrechnung-ubl-credit-note.xml"))["invoice"]
        self.assertEqual(invoice["type"], "381")
        self.assertTrue(invoice["credit"])
        self.assertEqual(invoice["totals"]["payable"], 590)
        self.assertEqual(invoice["precedingInvoice"], "BH-2025-0117")
        self.assertEqual(invoice["lines"][0]["quantity"], "15")

    def test_cii_from_a_kleinunternehmer(self):
        invoice = read(fixture("xrechnung-cii.xml"))["invoice"]
        self.assertEqual((invoice["syntax"], invoice["format"]), ("CII", "XRechnung 3.0"))
        self.assertEqual(invoice["seller"]["taxNumber"], "12/345/67890")
        self.assertNotIn("vatId", invoice["seller"])
        self.assertEqual(invoice["vat"], [{"category": "E", "rate": "0", "base": 27000, "amount": 0, "reason": "Kleinunternehmer gemäß § 19 UStG"}])
        self.assertEqual((invoice["issueDate"], invoice["dueDate"], invoice["deliveryDate"]), ("2025-03-03", "2025-03-17", "2025-02-28"))
        self.assertEqual(invoice["totals"]["payable"], 27000)
        self.assertEqual(invoice["warnings"], [])

    def test_zugferd_pdf(self):
        result = read(fixture("zugferd-en16931.pdf"), "pdf")
        self.assertEqual(result["status"], "invoice")
        invoice = result["invoice"]
        self.assertEqual((invoice["container"], invoice["format"]), ("pdf", "EN 16931"))
        self.assertEqual(invoice["seller"]["name"], "Bürobedarf Beispiel GmbH")
        self.assertEqual([(v["rate"], v["base"], v["amount"]) for v in invoice["vat"]], [("19", 2985, 567), ("7", 2490, 174)])
        self.assertEqual(invoice["allowances"], [{"charge": True, "reason": "Versand", "amount": 490}])
        self.assertEqual(invoice["totals"]["payable"], 6216)
        self.assertEqual(invoice["warnings"], [])

    def test_zugferd_pdf_with_object_streams(self):
        # Newer PDF writers pack dictionaries into compressed object streams;
        # the embedded file itself is a stream and stays outside.
        data = samples.zugferd_pdf(object_streams=True)
        for packed in (b"/Type /ObjStm", b"/Type /XRef", b"/Length 10 0 R"):
            self.assertIn(packed, data)
        self.assertNotIn(b"/Type /Catalog", data)  # compressed
        result = read(data, "pdf")
        self.assertEqual(result["status"], "invoice")
        self.assertEqual(result["invoice"]["number"], "2025-10442")

    def test_minimum_profile_is_no_einvoice(self):
        result = read(samples.pdf(["Kiosk"], samples.cii_minimum(), level="MINIMUM"), "pdf")
        invoice = result["invoice"]
        self.assertEqual(invoice["format"], "ZUGFeRD / Factur-X MINIMUM")
        self.assertEqual(invoice["totals"]["payable"], 1190)
        self.assertIn("Profile MINIMUM", invoice["warnings"][0])

    def test_attachment_type(self):
        # The MIME type may be unknown (octet-stream) or missing.
        for mime in (b"application#2Foctet-stream", b"application#2Fxml"):
            self.assertEqual(read(samples.pdf(["x"], samples.cii_en16931(), mime=mime), "pdf")["status"], "invoice")
        # Other attachments are no problem, even if they can't be read as XML.
        self.assertEqual(read(samples.pdf(["x"], "%PDF-1.4 a delivery note", mime=b"application#2Fpdf"), "pdf"), {"status": "plain"})
        self.assertEqual(read(samples.pdf(["x"], "plain text", mime=b"application#2Foctet-stream"), "pdf"), {"status": "plain"})

    def test_peppol_envelope(self):
        body = fixture("xrechnung-ubl.xml").decode().split("?>", 1)[1]
        wrapped = f'<StandardBusinessDocument xmlns="{reader.SBDH}"><StandardBusinessDocumentHeader/>{body}</StandardBusinessDocument>'
        self.assertEqual(read(wrapped)["invoice"]["number"], "BH-2025-0117")

    def test_other_currency(self):
        xml = fixture("xrechnung-ubl.xml").replace(b">EUR<", b">USD<").replace(b'"EUR"', b'"USD"')
        invoice = read(xml)["invoice"]
        self.assertEqual((invoice["currency"], invoice["totals"]["payable"], invoice["totals"]["vat"]), ("USD", 2606, 416))

    def test_totals_that_dont_add_up(self):
        xml = fixture("xrechnung-ubl.xml").replace(b'<cbc:PayableAmount currencyID="EUR">26.06', b'<cbc:PayableAmount currencyID="EUR">62.06')
        warnings = read(xml)["invoice"]["warnings"]
        self.assertEqual(warnings, ["The amount payable 62,06 EUR should be 26,06 EUR by the totals."])

    def test_missing_number_and_supplier(self):
        xml = fixture("xrechnung-ubl.xml").replace(b"<cbc:ID>BH-2025-0117</cbc:ID>", b"")
        xml = xml.replace(b"<cbc:RegistrationName>Beispiel Hosting GmbH</cbc:RegistrationName>", b"")
        invoice = read(xml)["invoice"]
        self.assertEqual(invoice["seller"]["name"], "Beispiel Hosting")  # the trading name
        self.assertEqual(invoice["warnings"], ["Not found in the e-invoice: invoice number."])

    def test_whitespace_in_names(self):
        xml = fixture("xrechnung-cii.xml").replace(b"<ram:Name>Grafikb\xc3\xbcro Max Mustermann", b"<ram:Name>\n   Grafikb\xc3\xbcro\n  Max Mustermann ")
        self.assertEqual(read(xml)["invoice"]["seller"]["name"], "Grafikbüro Max Mustermann")


class NoEInvoiceTest(unittest.TestCase):
    def test_plain_receipts(self):
        self.assertEqual(read(samples.plain_pdf(), "pdf"), {"status": "plain"})
        self.assertEqual(read(b"\xff\xd8\xff\xe0 photo", "jpg"), {"status": "plain"})
        self.assertEqual(read(b"not a pdf at all", "pdf"), {"status": "plain"})
        self.assertEqual(read(samples.pdf(["x"], "<note>Lieferschein</note>"), "pdf"), {"status": "plain"})

    def test_xml_that_is_no_einvoice(self):
        result = read("<note><to>Erika</to></note>")
        self.assertEqual(result["status"], "problem")
        self.assertIn("no e-invoice", result["message"])
        self.assertIn("<note>", result["message"])
        result = read('<Invoice xmlns="urn:example:other"/>')
        self.assertIn("another standard", result["message"])

    def test_broken_xml(self):
        result = read("<Invoice>\n<cbc:ID>1</Invoice>")
        self.assertEqual(result["status"], "problem")
        self.assertIn("not well-formed XML", result["message"])
        self.assertIn("line 2", result["message"])
        self.assertIn("not well-formed", read("<a>&undefined;</a>")["message"])

    def test_zugferd_1_is_not_read(self):
        result = read(f'<rsm:CrossIndustryDocument xmlns:rsm="{reader.ZUGFERD_1}"/>')
        self.assertIn("ZUGFeRD 1.0", result["message"])

    def test_broken_xml_inside_a_pdf(self):
        result = read(samples.pdf(["x"], samples.cii_en16931()[:-40]), "pdf")
        self.assertEqual(result["status"], "problem")
        self.assertIn("This PDF carries an XML file", result["message"])

    def test_damaged_pdf_stream(self):
        data = bytearray(samples.zugferd_pdf())
        at = data.index(b"stream\n", data.index(b"/Type /EmbeddedFile")) + 7
        data[at + 20 : at + 80] = b"\x00" * 60
        result = read(bytes(data), "pdf")
        self.assertEqual(result["status"], "problem")
        self.assertIn("inside the PDF", result["message"])


class SafetyTest(unittest.TestCase):
    def test_entity_expansion_is_refused(self):
        entities = "".join(f'<!ENTITY lol{i} "{f"&lol{i - 1};" * 10}">' for i in range(1, 10))
        bomb = f'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol0 "lol">{entities}]><lolz>&lol9;</lolz>'
        started = time.monotonic()
        result = read(bomb)
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(result["status"], "problem")
        self.assertIn("DOCTYPE", result["message"])

    def test_external_entities_are_refused(self):
        xxe = f'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY secret SYSTEM "file://{__file__}">]><Invoice>&secret;</Invoice>'
        result = read(xxe)
        self.assertIn("DOCTYPE", result["message"])
        self.assertNotIn("unittest", result["message"])

    def test_zip_bomb_in_a_pdf(self):
        huge = "<a>" + " " * (reader.MAX_XML + 1) + "</a>"
        result = read(samples.pdf(["x"], huge), "pdf")
        self.assertEqual(result["status"], "problem")
        self.assertIn("too large", result["message"])


class ValuesTest(unittest.TestCase):
    def test_cents(self):
        self.assertEqual(reader.cents("1234.56"), 123456)
        self.assertEqual(reader.cents(" 12.345 "), 1235)  # rounded half up
        self.assertEqual(reader.cents("-0.5"), -50)
        self.assertEqual(reader.cents("+7"), 700)
        self.assertIsNone(reader.cents("1e5"))
        self.assertIsNone(reader.cents("12,50"))
        self.assertIsNone(reader.cents("9" * 30))
        self.assertIsNone(reader.cents(None))

    def test_dates(self):
        self.assertEqual(reader.iso_date("20250115"), "2025-01-15")
        self.assertEqual(reader.iso_date("2025-01-15"), "2025-01-15")
        self.assertEqual(reader.iso_date("2025-01-15+01:00"), "2025-01-15")
        self.assertIsNone(reader.iso_date("20250230"))
        self.assertIsNone(reader.iso_date("202501"))
        self.assertIsNone(reader.iso_date(None))

    def test_profiles(self):
        self.assertEqual(reader.profile_of(samples.XRECHNUNG_3), ("XRechnung 3.0", None))
        self.assertEqual(reader.profile_of("urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_2.3"), ("XRechnung 2.3", None))
        self.assertEqual(reader.profile_of("urn:cen.eu:en16931:2017#compliant#urn:factur-x.eu:1p0:basic"), ("ZUGFeRD / Factur-X BASIC", "BASIC"))
        self.assertEqual(reader.profile_of("urn:factur-x.eu:1p0:basicwl"), ("ZUGFeRD / Factur-X BASIC WL", "BASIC WL"))
        self.assertEqual(reader.profile_of("urn:cen.eu:en16931:2017#conformant#urn:factur-x.eu:1p0:extended"), ("ZUGFeRD / Factur-X EXTENDED", "EXTENDED"))
        self.assertEqual(reader.profile_of("urn:cen.eu:en16931:2017"), ("EN 16931", "EN 16931"))


if __name__ == "__main__":
    unittest.main()
