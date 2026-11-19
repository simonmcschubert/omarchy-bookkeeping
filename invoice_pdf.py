"""Bookkeeping: makes an invoice into a ZUGFeRD e-invoice and checks it.

ZUGFeRD (Factur-X in France) is a normal PDF with the invoice data inside
as XML (factur-x.xml, UN/CEFACT CII, profile EN 16931), so people read the
PDF and programs read the data. The PDF has to be PDF/A-3, the archive
form of PDF that allows such an attached file. Three steps:

1. Chromium (Omarchy's browser) prints the invoice page to a PDF.
2. pikepdf (a Python library for editing PDFs, on Arch: python-pikepdf)
   makes that PDF/A-3u: it adds the colour profile and the metadata PDF/A
   asks for, and attaches the XML the way ZUGFeRD asks for.
3. The Mustang validator (a Java program, https://www.mustangproject.org)
   checks the PDF/A and the XML against the EN 16931 rules, as the
   receiver's software would. Only a valid invoice is kept.

The page writes the invoice page and the XML (invoice-html.mjs and
invoice-xml.mjs); this module only runs the tools. Standard library only,
except pikepdf, which is imported when an invoice is made.
"""

import datetime
import io
import os
import re
import shutil
import struct
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CSS = ROOT / "app" / "invoice.css"
# setup downloads the Mustang command line tool here (tools/ is not in git).
MUSTANG_JAR = ROOT / "tools" / "mustang-cli.jar"
CHROMIUM_NAMES = ("chromium", "chromium-browser", "google-chrome-stable", "google-chrome")
XML_NAME = "factur-x.xml"  # the attachment's name ZUGFeRD 2 and Factur-X ask for
TIMEOUT = 120  # seconds per tool run
FX_NAMESPACE = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#"


class InvoiceError(Exception):
    """A tool failed; the message says which and why, for the page."""


def find_tools(env=None):
    """Where the tools are: the paths, or None for each one missing. The
    BOOKKEEPING_CHROMIUM, BOOKKEEPING_JAVA and BOOKKEEPING_MUSTANG
    variables point elsewhere (tests and development)."""
    env = os.environ if env is None else env

    def program(variable, names):
        if env.get(variable):
            return shutil.which(env[variable])
        for name in names:
            path = shutil.which(name)
            if path:
                return path
        return None

    jar = Path(env.get("BOOKKEEPING_MUSTANG") or MUSTANG_JAR)
    try:
        import pikepdf  # noqa: F401

        has_pikepdf = True
    except ImportError:
        has_pikepdf = False
    return {
        "chromium": program("BOOKKEEPING_CHROMIUM", CHROMIUM_NAMES),
        "java": program("BOOKKEEPING_JAVA", ("java",)),
        "mustang": str(jar) if jar.is_file() else None,
        "pikepdf": has_pikepdf,
    }


def missing_tools(tools):
    """The names of what is missing, as setup would install it."""
    names = {
        "chromium": "Chromium",
        "java": "Java (jre-openjdk-headless)",
        "pikepdf": "pikepdf (python-pikepdf)",
        "mustang": "the Mustang validator",
    }
    return [label for key, label in names.items() if not tools.get(key)]


def run(args, what, cwd, env=None):
    try:
        result = subprocess.run(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        raise InvoiceError(f"{what} took longer than {TIMEOUT} seconds") from None
    except OSError as error:
        raise InvoiceError(f"{what} could not start: {error.strerror}") from None
    return result


def last_lines(data, count=5):
    lines = [line for line in data.decode("utf-8", "replace").splitlines() if line.strip()]
    return " / ".join(lines[-count:])


def print_pdf(chromium, html, workdir):
    """The invoice page printed by Chromium, as PDF bytes. The page links
    invoice.css, copied next to it. Chromium runs headless with a fresh
    profile, so it never touches the everyday browser, and with the network
    blocked: the page loads nothing but its stylesheet.

    Arch's chromium command adds the flags in
    $XDG_CONFIG_HOME/chromium-flags.conf (Omarchy keeps Wayland and
    extension flags there); an empty config folder leaves them out, and
    without the display variables it can't reach the desktop."""
    workdir = Path(workdir)
    (workdir / "config").mkdir()
    env = {key: value for key, value in os.environ.items() if key not in ("DISPLAY", "WAYLAND_DISPLAY")}
    env["XDG_CONFIG_HOME"] = str(workdir / "config")
    (workdir / "invoice.html").write_text(html, encoding="utf-8")
    shutil.copyfile(CSS, workdir / "invoice.css")
    out = workdir / "printed.pdf"
    args = [
        chromium,
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--password-store=basic",
        "--proxy-server=socks5://127.0.0.1:9",
        "--proxy-bypass-list=<-loopback>",
        f"--user-data-dir={workdir / 'profile'}",
        "--no-pdf-header-footer",
        f"--print-to-pdf={out}",
    ]
    # Chromium's sandbox needs user namespaces, which Ubuntu's AppArmor
    # blocks (CI and test machines); Arch allows them, so Omarchy keeps it.
    if os.environ.get("BOOKKEEPING_CHROMIUM_NO_SANDBOX") == "1":
        args.append("--no-sandbox")
    args.append((workdir / "invoice.html").as_uri())
    result = run(args, "Chromium", workdir, env)
    if not out.is_file() or not out.read_bytes().startswith(b"%PDF-"):
        raise InvoiceError(f"Chromium made no PDF (exit {result.returncode}): {last_lines(result.stderr)}")
    return out.read_bytes()


def pdf_date(moment):
    return moment.strftime("D:%Y%m%d%H%M%S+00'00'")


def xml_text(value):
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def xmp_packet(title, moment, conformance_level):
    """The PDF's XMP metadata: PDF/A-3u, the title and dates (the same as
    in the document info), and the Factur-X fields with their schema, which
    PDF/A wants declared for any field it doesn't know."""
    iso = moment.isoformat()
    title = xml_text(title)
    properties = [
        ("DocumentFileName", "The name of the embedded XML document"),
        ("DocumentType", "The type of the hybrid document in capital letters, e.g. INVOICE or ORDER"),
        ("Version", "The actual version of the standard applying to the embedded XML document"),
        ("ConformanceLevel", "The conformance level of the embedded XML document"),
    ]
    schema = "".join(
        '<rdf:li rdf:parseType="Resource">'
        f"<pdfaProperty:name>{name}</pdfaProperty:name>"
        "<pdfaProperty:valueType>Text</pdfaProperty:valueType>"
        "<pdfaProperty:category>external</pdfaProperty:category>"
        f"<pdfaProperty:description>{description}</pdfaProperty:description>"
        "</rdf:li>"
        for name, description in properties
    )
    return f"""<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>U</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">{title}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>Bookkeeping</xmp:CreatorTool>
   <xmp:CreateDate>{iso}</xmp:CreateDate>
   <xmp:ModifyDate>{iso}</xmp:ModifyDate>
   <xmp:MetadataDate>{iso}</xmp:MetadataDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>Bookkeeping</pdf:Producer>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="{FX_NAMESPACE}">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>{XML_NAME}</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>{conformance_level}</fx:ConformanceLevel>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
    <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
    <pdfaSchema:namespaceURI>{FX_NAMESPACE}</pdfaSchema:namespaceURI>
    <pdfaSchema:prefix>fx</pdfaSchema:prefix>
    <pdfaSchema:property><rdf:Seq>{schema}</rdf:Seq></pdfaSchema:property>
   </rdf:li></rdf:Bag></pdfaExtension:schemas>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>""".encode()


def make_pdfa(printed, xml, title, moment=None):
    """The printed PDF as PDF/A-3u with the XML attached as factur-x.xml.
    The values (fx:Version 1.0, ConformanceLevel "EN 16931", the file name,
    AFRelationship Data, PDF/A-3u) are those of FeRD's official ZUGFeRD
    2.5.2 sample PDFs; U means its text can be copied out, which Chromium's
    fonts allow."""
    import pikepdf
    from pikepdf import Name
    from PIL import ImageCms

    moment = (moment or datetime.datetime.now(datetime.timezone.utc)).replace(microsecond=0)
    with pikepdf.open(io.BytesIO(printed)) as pdf:
        # PDF/A needs to know which colours the page means: Chromium paints
        # in RGB, so the output intent is sRGB. Pillow's colour management
        # (LittleCMS) makes the profile.
        profile = bytearray(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
        # The profile's header says when it was made (bytes 24 to 35); it
        # gets the PDF's moment, so the PDF depends only on the invoice and
        # the moment. Its profile ID (MD5) is left empty, so no checksum
        # changes with it.
        profile[24:36] = struct.pack(">6H", moment.year, moment.month, moment.day, moment.hour, moment.minute, moment.second)
        icc = pikepdf.Stream(pdf, bytes(profile))
        icc.N = 3
        intent = pikepdf.Dictionary(
            Type=Name.OutputIntent,
            S=Name.GTS_PDFA1,
            OutputConditionIdentifier=pikepdf.String("sRGB IEC61966-2.1"),
            Info=pikepdf.String("sRGB IEC61966-2.1"),
            DestOutputProfile=icc,
        )
        pdf.Root.OutputIntents = pikepdf.Array([pdf.make_indirect(intent)])

        # The XML as an associated file of the document.
        data = pikepdf.Stream(pdf, xml)
        data.Type = Name.EmbeddedFile
        data.Subtype = Name("/text/xml")
        data.Params = pikepdf.Dictionary(ModDate=pikepdf.String(pdf_date(moment)), Size=len(xml))
        spec = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=Name.Filespec,
                F=pikepdf.String(XML_NAME),
                UF=pikepdf.String(XML_NAME),
                Desc=pikepdf.String("Rechnungsdaten (ZUGFeRD, EN 16931)"),
                AFRelationship=Name.Data,
                EF=pikepdf.Dictionary(F=data, UF=data),
            )
        )
        if "/Names" not in pdf.Root:
            pdf.Root.Names = pikepdf.Dictionary()
        pdf.Root.Names.EmbeddedFiles = pikepdf.Dictionary(Names=pikepdf.Array([pikepdf.String(XML_NAME), spec]))
        pdf.Root.AF = pikepdf.Array([spec])

        metadata = pikepdf.Stream(pdf, xmp_packet(title, moment, "EN 16931"))
        metadata.Type = Name.Metadata
        metadata.Subtype = Name.XML
        pdf.Root.Metadata = metadata
        # PDF/A: the document info must say the same as the XMP.
        stamp = pikepdf.String(pdf_date(moment))
        pdf.docinfo = pdf.make_indirect(
            pikepdf.Dictionary(
                Title=pikepdf.String(title),
                Creator=pikepdf.String("Bookkeeping"),
                Producer=pikepdf.String("Bookkeeping"),
                CreationDate=stamp,
                ModDate=stamp,
            )
        )
        out = io.BytesIO()
        # The file ID (PDF/A wants one) comes from the content, not from the
        # clock, so the PDF depends only on the invoice and the moment.
        pdf.save(out, min_version="1.7", fix_metadata_version=False, deterministic_id=True)
        return out.getvalue()


def parse_report(text):
    """Mustang's XML report as {valid, pdf, xml, profile, validator, messages}."""
    start = text.find("<validation")
    end = text.rfind("</validation>")
    if start < 0 or end < 0:
        raise InvoiceError("the validator gave no report")
    root = ET.fromstring(text[start : end + len("</validation>")])

    def status(element):
        summary = element.find("summary") if element is not None else None
        return None if summary is None else summary.get("status") == "valid"

    pdf = root.find("pdf")
    flavour = re.search(r"flavour=(\w+)", "".join(pdf.itertext())) if pdf is not None else None
    validator = root.find("xml/info/validator")
    messages = []
    for level in ("error", "warning", "notice"):
        for message in root.iter(level):
            messages.append(
                {
                    "level": level,
                    "text": " ".join("".join(message.itertext()).split()),
                    "location": message.get("location") or "",
                }
            )
    return {
        "valid": status(root) is True,
        "pdf": status(pdf),
        "pdfa": flavour.group(1) if flavour else None,
        "xml": status(root.find("xml")),
        "profile": root.findtext("xml/info/profile"),
        "validator": f"Mustang {validator.get('version')}" if validator is not None else "Mustang",
        "messages": messages,
    }


def validate(java, jar, pdf_path):
    """Mustang's verdict on the PDF. Notices are left out: they list what
    XRechnung (the public sector's stricter form) would want in addition."""
    args = [java, "-Djava.awt.headless=true", "-jar", jar, "--disable-file-logging", "--action", "validate", "--no-notices", "--source", str(pdf_path)]
    result = run(args, "The Mustang validator", Path(pdf_path).parent)
    try:
        return parse_report(result.stdout.decode("utf-8", "replace"))
    except (InvoiceError, ET.ParseError):
        raise InvoiceError(f"the Mustang validator failed (exit {result.returncode}): {last_lines(result.stderr or result.stdout)}") from None


def make_invoice(html, xml, title, tools):
    """The e-invoice PDF and Mustang's report on it."""
    with tempfile.TemporaryDirectory(prefix="bookkeeping-invoice-") as workdir:
        printed = print_pdf(tools["chromium"], html, workdir)
        try:
            pdf = make_pdfa(printed, xml.encode("utf-8"), title)
        except Exception as error:  # pikepdf raises its own errors
            raise InvoiceError(f"pikepdf could not make the PDF/A: {error}") from None
        path = Path(workdir) / "invoice.pdf"
        path.write_bytes(pdf)
        return pdf, validate(tools["java"], tools["mustang"], path)
