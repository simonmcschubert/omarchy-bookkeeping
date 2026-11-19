"""Reads received e-invoices for Bookkeeping: XRechnung and other EN 16931
invoices in UBL or CII syntax, as an XML file or inside a ZUGFeRD /
Factur-X PDF. Python standard library only.

read_receipt(data, ext) says what a receipt file holds:
  {"status": "invoice", "invoice": {...}}   an e-invoice, read
  {"status": "plain"}                       a photo, or a PDF without one
  {"status": "problem", "message": "..."}   no e-invoice, or a broken one

Reading is not validating: the invoice's figures are taken as they are,
with a warning when its totals don't add up. Amounts are whole cents;
dates are ISO dates; quantities and unit prices stay decimal strings, as
they may have more than two decimals.
"""

import datetime
import pyexpat
import re
import zlib
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from xml.etree import ElementTree as ET

UBL_INVOICE = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
UBL_CREDIT_NOTE = "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
CII = "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
# ZUGFeRD 1.0's own syntax: older than EN 16931, and not read here.
ZUGFERD_1 = "urn:ferd:CrossIndustryDocument:invoice:1p0"
# Peppol wraps a UBL invoice in a Standard Business Document Header.
SBDH = "http://www.unece.org/cefact/namespaces/StandardBusinessDocumentHeader"

NS = {
    "cac": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "cbc": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "rsm": CII,
    "ram": "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
    "udt": "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
}

# Invoice type codes (BT-3, UNTDID 1001) that mean a credit note. The type
# code says that a document credits; the sign of its amounts stays as it is
# (Peppol BIS Billing 3.0, 5.6.1, on EN 16931), so a credit note's positive
# total makes the expense a refund. A self-billed invoice (389, Gutschrift
# im Sinne des UStG) is no credit note. 381 is checked (KoSIT, XRechnung
# 3.0.2, 13.1); the other codes are UNTDID 1001's further credit notes, not
# yet checked one by one against the code list.
CREDIT_TYPES = {"81", "83", "261", "262", "296", "308", "381", "396", "420", "458", "532"}

# The profiles of ZUGFeRD / Factur-X, by the last part of their guideline ID
# (BT-24). MINIMUM and BASIC WL are no e-invoices under § 14 UStG.
PROFILES = {
    "minimum": "MINIMUM",
    "basicwl": "BASIC WL",
    "basic": "BASIC",
    "en16931": "EN 16931",
    "extended": "EXTENDED",
    "xrechnung": "XRECHNUNG",
}

MAX_XML = 10 * 1024 * 1024  # bytes an embedded XML file may unpack to
MAX_EMBEDDED = 20  # embedded files looked at in one PDF
MAX_MARKERS = 1000  # dictionaries that look like an embedded file


class Unreadable(Exception):
    """The file can't be read as an e-invoice; the message says why."""


# ---- XML


def parse_xml(data):
    """The XML document as an ElementTree element. Refuses a DOCTYPE: an
    e-invoice never has one, and without one there are no entity
    declarations to expand (billion laughs) and no external entities to
    fetch, whatever the expat version."""

    builder = ET.TreeBuilder()
    parser = pyexpat.ParserCreate(namespace_separator="}")

    def refuse(*_):
        raise Unreadable("it declares a DOCTYPE, which e-invoices never do, so it is not read")

    def qualified(name):
        return "{" + name if "}" in name else name

    parser.StartDoctypeDeclHandler = refuse
    parser.EntityDeclHandler = refuse
    parser.SetParamEntityParsing(pyexpat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.StartElementHandler = lambda name, attrs: builder.start(
        qualified(name), {qualified(key): value for key, value in attrs.items()}
    )
    parser.EndElementHandler = lambda name: builder.end(qualified(name))
    parser.CharacterDataHandler = builder.data
    parser.buffer_text = True
    try:
        parser.Parse(data.lstrip(b" \t\r\n"), True)
    except pyexpat.ExpatError as error:
        raise Unreadable(f"it is not well-formed XML ({pyexpat.ErrorString(error.code)}, line {error.lineno})") from None
    return builder.close()


def local_name(element):
    return element.tag.rsplit("}", 1)[-1]


def namespace(element):
    return element.tag[1:].split("}", 1)[0] if element.tag.startswith("{") else ""


def clean(value, lines=False):
    """The text with its spaces tidied: on one line, or with its line breaks
    kept (lines=True, for notes and descriptions). None when empty."""
    if value is None:
        return None
    if lines:
        value = re.sub(r"\n{3,}", "\n\n", "\n".join(" ".join(line.split()) for line in value.strip().splitlines()))
    else:
        value = " ".join(value.split())
    return value or None


def text(element, path, lines=False):
    """The text at path below element, tidied; None when empty."""
    if element is None:
        return None
    found = element.find(path, NS)
    return None if found is None else clean(found.text, lines)


def texts(element, path):
    return [t for t in (clean(found.text, lines=True) for found in element.findall(path, NS)) if t]


DECIMAL = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")


def decimal(value):
    """The XML decimal as a plain string such as "2.5", or None."""
    if value is None or len(value) > 40:
        return None
    value = value.strip()
    if not DECIMAL.match(value):
        return None
    return value.lstrip("+")


def cents(value):
    """Whole cents from an XML decimal such as 1234.56, or None."""
    value = decimal(value)
    if value is None:
        return None
    try:
        number = Decimal(value)
        if abs(number) >= 10**13:
            return None
        return int((number * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    except InvalidOperation:
        return None


def iso_date(value):
    """ISO date from 20250115 (CII format 102) or 2025-01-15 (UBL)."""
    if not value:
        return None
    match = re.match(r"^(\d{4})-?(\d{2})-?(\d{2})(?:$|[T+Z ]|-\d{2}:)", value.strip())
    if not match:
        return None
    try:
        return datetime.date(*map(int, match.groups())).isoformat()
    except ValueError:
        return None


def cii_date(element, path):
    return iso_date(text(element, f"{path}/udt:DateTimeString"))


def compact(mapping):
    """The mapping without empty values, so the JSON stays small."""
    return {key: value for key, value in mapping.items() if value not in (None, "", [], {})}


def address_lines(*parts):
    return [p for p in parts if p]


# ---- UBL (OASIS UBL 2.1, as XRechnung and Peppol use it)


def ubl_party(party):
    if party is None:
        return {}
    vat_id = None
    tax_number = None
    for scheme in party.findall("cac:PartyTaxScheme", NS):
        company_id = text(scheme, "cbc:CompanyID")
        if text(scheme, "cac:TaxScheme/cbc:ID") == "VAT":
            vat_id = vat_id or company_id
        else:
            tax_number = tax_number or company_id
    address = party.find("cac:PostalAddress", NS)
    city = " ".join(p for p in (text(address, "cbc:PostalZone"), text(address, "cbc:CityName")) if p)
    return compact(
        {
            "name": text(party, "cac:PartyLegalEntity/cbc:RegistrationName") or text(party, "cac:PartyName/cbc:Name"),
            "tradingName": text(party, "cac:PartyName/cbc:Name"),
            "address": address_lines(
                text(address, "cbc:StreetName"),
                text(address, "cbc:AdditionalStreetName"),
                text(address, "cac:AddressLine/cbc:Line"),
                city,
                text(address, "cbc:CountrySubentity"),
                text(address, "cac:Country/cbc:IdentificationCode"),
            ),
            "vatId": vat_id,
            "taxNumber": tax_number,
            "contact": text(party, "cac:Contact/cbc:Name"),
            "phone": text(party, "cac:Contact/cbc:Telephone"),
            "email": text(party, "cac:Contact/cbc:ElectronicMail"),
        }
    )


def amount_of(element, path, currency):
    """Cents at path; of several (an amount given in two currencies), the
    one in the invoice currency."""
    found = element.findall(path, NS)
    for item in found:
        if item.get("currencyID") in (None, currency):
            return cents(item.text)
    return cents(found[0].text) if found else None


def read_ubl(root):
    credit_note = local_name(root) == "CreditNote"
    line_tag, quantity_tag = ("CreditNoteLine", "CreditedQuantity") if credit_note else ("InvoiceLine", "InvoicedQuantity")
    currency = text(root, "cbc:DocumentCurrencyCode")
    type_code = text(root, "cbc:CreditNoteTypeCode" if credit_note else "cbc:InvoiceTypeCode") or ("381" if credit_note else "380")

    # Of several TaxTotal (the second in the VAT accounting currency), the
    # one in the invoice currency carries the breakdown.
    tax_totals = root.findall("cac:TaxTotal", NS)
    tax_total = next(
        (t for t in tax_totals if t.find("cbc:TaxAmount", NS) is not None and t.find("cbc:TaxAmount", NS).get("currencyID") in (None, currency)),
        tax_totals[0] if tax_totals else None,
    )
    vat = []
    if tax_total is not None:
        for sub in tax_total.findall("cac:TaxSubtotal", NS):
            vat.append(
                compact(
                    {
                        "category": text(sub, "cac:TaxCategory/cbc:ID"),
                        "rate": decimal(text(sub, "cac:TaxCategory/cbc:Percent")),
                        "base": cents(text(sub, "cbc:TaxableAmount")),
                        "amount": cents(text(sub, "cbc:TaxAmount")),
                        "reason": text(sub, "cac:TaxCategory/cbc:TaxExemptionReason") or text(sub, "cac:TaxCategory/cbc:TaxExemptionReasonCode"),
                    }
                )
            )

    lines = []
    for line in root.findall(f"cac:{line_tag}", NS):
        quantity = line.find(f"cbc:{quantity_tag}", NS)
        lines.append(
            compact(
                {
                    "id": text(line, "cbc:ID"),
                    "name": text(line, "cac:Item/cbc:Name"),
                    "description": text(line, "cac:Item/cbc:Description", lines=True),
                    "quantity": decimal(quantity.text) if quantity is not None else None,
                    "unit": quantity.get("unitCode") if quantity is not None else None,
                    "price": decimal(text(line, "cac:Price/cbc:PriceAmount")),
                    "priceBase": decimal(text(line, "cac:Price/cbc:BaseQuantity")),
                    "net": cents(text(line, "cbc:LineExtensionAmount")),
                    "vatCategory": text(line, "cac:Item/cac:ClassifiedTaxCategory/cbc:ID"),
                    "vatRate": decimal(text(line, "cac:Item/cac:ClassifiedTaxCategory/cbc:Percent")),
                }
            )
        )

    allowances = []
    for item in root.findall("cac:AllowanceCharge", NS):
        allowances.append(
            compact(
                {
                    "charge": text(item, "cbc:ChargeIndicator") == "true",
                    "reason": text(item, "cbc:AllowanceChargeReason") or text(item, "cbc:AllowanceChargeReasonCode"),
                    "amount": cents(text(item, "cbc:Amount")),
                }
            )
        )

    means = root.find("cac:PaymentMeans", NS)
    totals = root.find("cac:LegalMonetaryTotal", NS)
    return {
        "syntax": "UBL",
        "spec": text(root, "cbc:CustomizationID"),
        "type": type_code,
        "credit": credit_note or type_code in CREDIT_TYPES,
        "number": text(root, "cbc:ID"),
        "issueDate": iso_date(text(root, "cbc:IssueDate")),
        "dueDate": iso_date(text(root, "cbc:DueDate") or text(means, "cbc:PaymentDueDate")),
        "deliveryDate": iso_date(text(root, "cac:Delivery/cbc:ActualDeliveryDate")),
        "periodStart": iso_date(text(root, "cac:InvoicePeriod/cbc:StartDate")),
        "periodEnd": iso_date(text(root, "cac:InvoicePeriod/cbc:EndDate")),
        "currency": currency,
        "buyerReference": text(root, "cbc:BuyerReference"),
        "orderReference": text(root, "cac:OrderReference/cbc:ID"),
        "precedingInvoice": text(root, "cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID"),
        "notes": texts(root, "cbc:Note"),
        "seller": ubl_party(root.find("cac:AccountingSupplierParty/cac:Party", NS)),
        "buyer": ubl_party(root.find("cac:AccountingCustomerParty/cac:Party", NS)),
        "lines": lines,
        "allowances": allowances,
        "vat": vat,
        "totals": compact(
            {
                "lines": cents(text(totals, "cbc:LineExtensionAmount")),
                "allowances": cents(text(totals, "cbc:AllowanceTotalAmount")),
                "charges": cents(text(totals, "cbc:ChargeTotalAmount")),
                "net": cents(text(totals, "cbc:TaxExclusiveAmount")),
                "vat": amount_of(tax_total, "cbc:TaxAmount", currency) if tax_total is not None else None,
                "gross": cents(text(totals, "cbc:TaxInclusiveAmount")),
                "prepaid": cents(text(totals, "cbc:PrepaidAmount")),
                "rounding": cents(text(totals, "cbc:PayableRoundingAmount")),
                "payable": cents(text(totals, "cbc:PayableAmount")),
            }
        ),
        "payment": compact(
            {
                "means": text(means, "cbc:PaymentMeansCode"),
                "iban": text(means, "cac:PayeeFinancialAccount/cbc:ID"),
                "accountName": text(means, "cac:PayeeFinancialAccount/cbc:Name"),
                "bic": text(means, "cac:PayeeFinancialAccount/cac:FinancialInstitutionBranch/cbc:ID"),
                "reference": text(means, "cbc:PaymentID"),
                "terms": text(root, "cac:PaymentTerms/cbc:Note", lines=True),
            }
        ),
    }


# ---- CII (UN/CEFACT Cross Industry Invoice D16B, as ZUGFeRD 2 and XRechnung use it)


def cii_party(party):
    if party is None:
        return {}
    address = party.find("ram:PostalTradeAddress", NS)
    city = " ".join(p for p in (text(address, "ram:PostcodeCode"), text(address, "ram:CityName")) if p)
    return compact(
        {
            "name": text(party, "ram:Name"),
            "tradingName": text(party, "ram:SpecifiedLegalOrganization/ram:TradingBusinessName"),
            "address": address_lines(
                text(address, "ram:LineOne"),
                text(address, "ram:LineTwo"),
                text(address, "ram:LineThree"),
                city,
                text(address, "ram:CountrySubDivisionName"),
                text(address, "ram:CountryID"),
            ),
            "vatId": text(party, "ram:SpecifiedTaxRegistration/ram:ID[@schemeID='VA']"),
            "taxNumber": text(party, "ram:SpecifiedTaxRegistration/ram:ID[@schemeID='FC']"),
            "contact": text(party, "ram:DefinedTradeContact/ram:PersonName"),
            "phone": text(party, "ram:DefinedTradeContact/ram:TelephoneUniversalCommunication/ram:CompleteNumber"),
            "email": text(party, "ram:DefinedTradeContact/ram:EmailURIUniversalCommunication/ram:URIID"),
        }
    )


def read_cii(root):
    document = root.find("rsm:ExchangedDocument", NS)
    trade = root.find("rsm:SupplyChainTradeTransaction", NS)
    agreement = trade.find("ram:ApplicableHeaderTradeAgreement", NS) if trade is not None else None
    delivery = trade.find("ram:ApplicableHeaderTradeDelivery", NS) if trade is not None else None
    settlement = trade.find("ram:ApplicableHeaderTradeSettlement", NS) if trade is not None else None
    currency = text(settlement, "ram:InvoiceCurrencyCode")

    lines = []
    for item in trade.findall("ram:IncludedSupplyChainTradeLineItem", NS) if trade is not None else []:
        quantity = item.find("ram:SpecifiedLineTradeDelivery/ram:BilledQuantity", NS)
        line_tax = "ram:SpecifiedLineTradeSettlement/ram:ApplicableTradeTax"
        lines.append(
            compact(
                {
                    "id": text(item, "ram:AssociatedDocumentLineDocument/ram:LineID"),
                    "name": text(item, "ram:SpecifiedTradeProduct/ram:Name"),
                    "description": text(item, "ram:SpecifiedTradeProduct/ram:Description", lines=True),
                    "quantity": decimal(quantity.text) if quantity is not None else None,
                    "unit": quantity.get("unitCode") if quantity is not None else None,
                    "price": decimal(text(item, "ram:SpecifiedLineTradeAgreement/ram:NetPriceProductTradePrice/ram:ChargeAmount")),
                    "priceBase": decimal(text(item, "ram:SpecifiedLineTradeAgreement/ram:NetPriceProductTradePrice/ram:BasisQuantity")),
                    "net": cents(text(item, "ram:SpecifiedLineTradeSettlement/ram:SpecifiedTradeSettlementLineMonetarySummation/ram:LineTotalAmount")),
                    "vatCategory": text(item, f"{line_tax}/ram:CategoryCode"),
                    "vatRate": decimal(text(item, f"{line_tax}/ram:RateApplicablePercent")),
                }
            )
        )

    vat = []
    allowances = []
    means = None
    terms = None
    totals = None
    if settlement is not None:
        for tax in settlement.findall("ram:ApplicableTradeTax", NS):
            vat.append(
                compact(
                    {
                        "category": text(tax, "ram:CategoryCode"),
                        "rate": decimal(text(tax, "ram:RateApplicablePercent")),
                        "base": cents(text(tax, "ram:BasisAmount")),
                        "amount": cents(text(tax, "ram:CalculatedAmount")),
                        "reason": text(tax, "ram:ExemptionReason") or text(tax, "ram:ExemptionReasonCode"),
                    }
                )
            )
        for item in settlement.findall("ram:SpecifiedTradeAllowanceCharge", NS):
            allowances.append(
                compact(
                    {
                        "charge": text(item, "ram:ChargeIndicator/udt:Indicator") == "true",
                        "reason": text(item, "ram:Reason") or text(item, "ram:ReasonCode"),
                        "amount": cents(text(item, "ram:ActualAmount")),
                    }
                )
            )
        means = settlement.find("ram:SpecifiedTradeSettlementPaymentMeans", NS)
        terms = settlement.find("ram:SpecifiedTradePaymentTerms", NS)
        totals = settlement.find("ram:SpecifiedTradeSettlementHeaderMonetarySummation", NS)

    type_code = text(document, "ram:TypeCode") or "380"
    return {
        "syntax": "CII",
        "spec": text(root, "rsm:ExchangedDocumentContext/ram:GuidelineSpecifiedDocumentContextParameter/ram:ID"),
        "type": type_code,
        "credit": type_code in CREDIT_TYPES,
        "number": text(document, "ram:ID"),
        "issueDate": cii_date(document, "ram:IssueDateTime"),
        "dueDate": cii_date(terms, "ram:DueDateDateTime"),
        "deliveryDate": cii_date(delivery, "ram:ActualDeliverySupplyChainEvent/ram:OccurrenceDateTime"),
        "periodStart": cii_date(settlement, "ram:BillingSpecifiedPeriod/ram:StartDateTime"),
        "periodEnd": cii_date(settlement, "ram:BillingSpecifiedPeriod/ram:EndDateTime"),
        "currency": currency,
        "buyerReference": text(agreement, "ram:BuyerReference"),
        "orderReference": text(agreement, "ram:BuyerOrderReferencedDocument/ram:IssuerAssignedID"),
        "precedingInvoice": text(settlement, "ram:InvoiceReferencedDocument/ram:IssuerAssignedID"),
        "notes": texts(document, "ram:IncludedNote/ram:Content") if document is not None else [],
        "seller": cii_party(agreement.find("ram:SellerTradeParty", NS) if agreement is not None else None),
        "buyer": cii_party(agreement.find("ram:BuyerTradeParty", NS) if agreement is not None else None),
        "lines": lines,
        "allowances": allowances,
        "vat": vat,
        "totals": compact(
            {
                "lines": cents(text(totals, "ram:LineTotalAmount")),
                "allowances": cents(text(totals, "ram:AllowanceTotalAmount")),
                "charges": cents(text(totals, "ram:ChargeTotalAmount")),
                "net": cents(text(totals, "ram:TaxBasisTotalAmount")),
                "vat": amount_of(totals, "ram:TaxTotalAmount", currency) if totals is not None else None,
                "gross": cents(text(totals, "ram:GrandTotalAmount")),
                "prepaid": cents(text(totals, "ram:TotalPrepaidAmount")),
                "rounding": cents(text(totals, "ram:RoundingAmount")),
                "payable": cents(text(totals, "ram:DuePayableAmount")),
            }
        ),
        "payment": compact(
            {
                "means": text(means, "ram:TypeCode"),
                "iban": text(means, "ram:PayeePartyCreditorFinancialAccount/ram:IBANID"),
                "accountName": text(means, "ram:PayeePartyCreditorFinancialAccount/ram:AccountName"),
                "bic": text(means, "ram:PayeeSpecifiedCreditorFinancialInstitution/ram:BICID"),
                "reference": text(settlement, "ram:PaymentReference"),
                "terms": text(terms, "ram:Description", lines=True),
            }
        ),
    }


# ---- what was read


def profile_of(spec):
    """A readable name for the specification ID (BT-24), and the
    ZUGFeRD / Factur-X profile it names, if any."""
    if not spec:
        return None, None
    match = re.search(r"xrechnung_(\d+(?:\.\d+)*)", spec)
    if match:
        extension = "#conformant#" in spec and "extension" in spec
        return f"XRechnung {match.group(1)}{' Extension' if extension else ''}", None
    match = re.search(r"(?:factur-x\.eu:1p0|zugferd\.de:2p0):(minimum|basicwl|basic|en16931|extended|xrechnung)\b", spec, re.I)
    if match:
        profile = PROFILES[match.group(1).lower()]
        return f"ZUGFeRD / Factur-X {profile}", profile
    if "peppol.eu:2017:poacc:billing:3.0" in spec:
        return "Peppol BIS Billing 3.0", None
    if spec == "urn:cen.eu:en16931:2017":
        return "EN 16931", "EN 16931"
    return spec, None


def money(amount, currency):
    """1.234,56 EUR, for warnings."""
    sign = "−" if amount < 0 else ""
    whole, fraction = divmod(abs(amount), 100)
    return f"{sign}{whole:,}".replace(",", ".") + f",{fraction:02d} {currency or ''}".rstrip()


def checked(invoice):
    """The invoice with its warnings: what is missing, and totals that
    don't add up (EN 16931 rules BR-CO-10, -15 and -16)."""
    warnings = []
    missing = [
        label
        for key, label in (
            ("number", "invoice number"),
            ("issueDate", "invoice date"),
            ("currency", "currency"),
        )
        if not invoice.get(key)
    ]
    if not invoice["seller"].get("name"):
        missing.insert(0, "supplier")
    totals = invoice["totals"]
    if totals.get("payable") is None and totals.get("gross") is None:
        missing.append("amount payable")
    if missing:
        warnings.append(f"Not found in the e-invoice: {', '.join(missing)}.")

    format_name, profile = profile_of(invoice.get("spec"))
    invoice["format"] = format_name
    if profile in ("MINIMUM", "BASIC WL"):
        # BMF letter of 15.10.2024 on the e-invoice, Rn. 25: ZUGFeRD from
        # 2.0.1 counts, "ausgenommen die Profile MINIMUM und BASIC-WL".
        warnings.append(f"Profile {profile} holds too little to count as an e-invoice under § 14 UStG: the PDF itself is the invoice.")
    if profile in ("MINIMUM", "EXTENDED"):
        # MINIMUM has no prepaid amount, and EXTENDED allows sub-lines and
        # lines for information only: the checks below don't fit them.
        return invoice | {"warnings": warnings}

    currency = invoice.get("currency")
    line_sum = sum(line.get("net", 0) for line in invoice["lines"])
    if invoice["lines"] and totals.get("lines") is not None and line_sum != totals["lines"]:
        warnings.append(f"The lines add up to {money(line_sum, currency)}, but the invoice says {money(totals['lines'], currency)}.")
    net, vat, gross = totals.get("net"), totals.get("vat", 0), totals.get("gross")
    if net is not None and gross is not None and net + vat != gross:
        warnings.append(f"Net {money(net, currency)} plus VAT {money(vat, currency)} is not the total {money(gross, currency)}.")
    payable = totals.get("payable")
    if gross is not None and payable is not None:
        expected = gross - totals.get("prepaid", 0) + totals.get("rounding", 0)
        if expected != payable:
            warnings.append(f"The amount payable {money(payable, currency)} should be {money(expected, currency)} by the totals.")
    return invoice | {"warnings": warnings}


def read_xml(data):
    """("invoice", invoice), ("other", why) for XML that is no e-invoice,
    or ("broken", why) for a file that can't be read."""
    try:
        root = parse_xml(data)
    except Unreadable as error:
        return "broken", str(error)
    if namespace(root) == SBDH:
        inner = next((child for child in root if namespace(child) in (UBL_INVOICE, UBL_CREDIT_NOTE)), None)
        if inner is None:
            return "other", "it is a Peppol envelope without an invoice inside"
        root = inner
    kind = (namespace(root), local_name(root))
    if kind == (UBL_INVOICE, "Invoice") or kind == (UBL_CREDIT_NOTE, "CreditNote"):
        invoice = read_ubl(root)
    elif kind == (CII, "CrossIndustryInvoice"):
        invoice = read_cii(root)
    elif kind[0] == ZUGFERD_1:
        return "broken", "it is a ZUGFeRD 1.0 invoice, an old format that is not read"
    elif kind[1] in ("Invoice", "CreditNote", "CrossIndustryInvoice"):
        return "other", f"its <{kind[1]}> is of another standard ({kind[0] or 'no namespace'}), not UBL or CII"
    else:
        return "other", f"XRechnung and ZUGFeRD data start with <Invoice>, <CreditNote> or <CrossIndustryInvoice>, this one with <{kind[1]}>"
    return "invoice", checked(invoice)


# ---- PDF: the XML file a ZUGFeRD / Factur-X PDF carries
#
# The XML sits in the PDF as an embedded file stream. A stream object never
# sits inside a compressed object stream (ISO 32000-1, 7.5.7), and a PDF/A-3
# file is never encrypted, so the embedded files can be found by looking at
# the dictionaries of embedded file streams, without reading the rest of the
# PDF's structure.

STREAM = re.compile(rb"(?<![A-Za-z])stream(?:\r\n|\n|\r)")
XML_TYPE = rb"/Subtype\s*/(?:text|application)(?:#2[Ff]|/)xml(?![A-Za-z])"
EMBEDDED_FILE = re.compile(rb"/Type\s*/EmbeddedFile(?![A-Za-z])|" + XML_TYPE)
SUBTYPE = re.compile(rb"/Subtype\s*/([^\s/<>\[\]()]+(?:/[^\s/<>\[\]()]+)?)")
FILTER = re.compile(rb"/Filter\s*(\[[^\]]*\]|/[A-Za-z0-9]+)")
DIRECT_LENGTH = re.compile(rb"/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)")


def inflate(raw):
    unpacker = zlib.decompressobj()
    try:
        out = unpacker.decompress(raw, MAX_XML + 1)
    except zlib.error:
        raise Unreadable("the file inside the PDF is damaged") from None
    if len(out) > MAX_XML:
        raise Unreadable("the file inside the PDF is too large")
    if not unpacker.eof:
        raise Unreadable("the file inside the PDF is cut off")
    return out


def stream_bytes(data, start, head):
    """The bytes of the stream starting at start: by its /Length when that
    is a number, else up to the next endstream."""
    length = DIRECT_LENGTH.search(head)
    if length and start + int(length.group(1)) <= len(data):
        return data[start : start + int(length.group(1))]
    end = data.find(b"endstream", start)
    return data[start : end if end >= 0 else len(data)]


def embedded_files(data):
    """The files embedded in a PDF that may be XML, in the order they
    appear, as (contents, typed): typed when the PDF calls the file XML. A
    file that can't be unpacked is an Unreadable in its place. Starts from
    the dictionaries that say EmbeddedFile or an XML type, and reads the
    stream that follows each; pictures, PDFs and such are left out."""
    found = []
    seen = set()
    for count, marker in enumerate(EMBEDDED_FILE.finditer(data)):
        if count >= MAX_MARKERS or len(found) >= MAX_EMBEDDED:
            break
        stream = STREAM.search(data, marker.end(), marker.end() + 4096)
        if not stream or stream.end() in seen or b"endobj" in data[marker.end() : stream.start()]:
            continue  # not a stream's dictionary, or one already read
        seen.add(stream.end())
        head_at = data.rfind(b"obj", max(0, marker.start() - 4096), marker.start())
        head = data[head_at if head_at >= 0 else max(0, marker.start() - 4096) : stream.start()]
        typed = bool(re.search(XML_TYPE, head))
        subtype = SUBTYPE.search(head)
        if subtype and not typed and subtype.group(1).lower().replace(b"#2f", b"/") != b"application/octet-stream":
            continue
        start = stream.end()
        filters = FILTER.search(head)
        names = re.findall(rb"/([A-Za-z0-9]+)", filters.group(1)) if filters else []
        try:
            if names in ([b"FlateDecode"], [b"Fl"]):
                try:
                    found.append((inflate(stream_bytes(data, start, head)), typed))
                except Unreadable:
                    # endstream may occur inside the packed bytes, and a
                    # /Length may be wrong: the deflate data ends by itself.
                    found.append((inflate(data[start:]), typed))
            elif not names:
                found.append((stream_bytes(data, start, head), typed))
            else:
                raise Unreadable(f"the file inside the PDF is packed in a way that is not read ({b', '.join(names).decode()})")
        except Unreadable as error:
            found.append((error, typed))
    return found


def read_pdf(data):
    if b"%PDF-" not in data[:1024]:
        return {"status": "plain"}
    problems = []
    for content, typed in embedded_files(data):
        # Of a file the PDF does not call XML, only an e-invoice counts.
        if isinstance(content, Unreadable):
            if typed:
                problems.append(str(content))
            continue
        status, value = read_xml(content)
        if status == "invoice":
            value["container"] = "pdf"
            return {"status": "invoice", "invoice": value}
        if status == "broken" and typed:
            problems.append(value)
    if problems:
        return {"status": "problem", "message": f"This PDF carries an XML file, but it can't be read as an e-invoice: {problems[0]}."}
    return {"status": "plain"}


def read_receipt(data, ext):
    """What a receipt file holds; see the top of this file."""
    if ext == "pdf":
        return read_pdf(data)
    if ext == "xml":
        status, value = read_xml(data)
        if status == "invoice":
            value["container"] = "xml"
            return {"status": "invoice", "invoice": value}
        if status == "other":
            return {"status": "problem", "message": f"This XML file is no e-invoice: {value}."}
        return {"status": "problem", "message": f"This XML file can't be read as an e-invoice: {value}."}
    return {"status": "plain"}
