"""Made-up e-invoices for the tests: XRechnung in UBL and CII syntax, and a
ZUGFeRD / Factur-X PDF with its XML inside. Every name, address, number
and IBAN is invented (the IBANs only have valid check digits).

    python3 test/einvoice_samples.py   # writes them to test/fixtures/einvoices/

It also writes readings.json there: what einvoice_reader reads from each,
which the page's tests (einvoice.test.mjs) take as the server's answer.

The PDFs are built like a ZUGFeRD PDF (factur-x.xml embedded with
AFRelationship /Alternative, Factur-X XMP metadata), but they are not
validated PDF/A-3 files: their fonts are not embedded, for one.
"""

import json
import sys
import zlib
from pathlib import Path
from xml.sax.saxutils import escape

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "einvoices"

XRECHNUNG_3 = "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0"
EN16931 = "urn:cen.eu:en16931:2017"
MINIMUM = "urn:factur-x.eu:1p0:minimum"
PEPPOL_PROCESS = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0"


def iban(country, bban):
    """An IBAN with valid check digits for a made-up account."""
    digits = "".join(str(int(c, 36)) for c in bban + country + "00")
    return f"{country}{98 - int(digits) % 97:02d}{bban}"


SELLER_IBAN = iban("DE", "123456780001234567")
GRAFIK_IBAN = iban("DE", "876543210009876543")


def x(value):
    return escape(str(value))


# ---- UBL: an XRechnung 3.0 invoice from a web host, with 19 % VAT


def ubl_invoice():
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>{XRECHNUNG_3}</cbc:CustomizationID>
  <cbc:ProfileID>{PEPPOL_PROCESS}</cbc:ProfileID>
  <cbc:ID>BH-2025-0117</cbc:ID>
  <cbc:IssueDate>2025-01-15</cbc:IssueDate>
  <cbc:DueDate>2025-01-29</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:Note>Vielen Dank für Ihren Auftrag.</cbc:Note>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>Kundennummer 40711</cbc:BuyerReference>
  <cac:InvoicePeriod>
    <cbc:StartDate>2025-01-01</cbc:StartDate>
    <cbc:EndDate>2025-01-31</cbc:EndDate>
  </cac:InvoicePeriod>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">rechnung@beispiel-hosting.example</cbc:EndpointID>
      <cac:PartyName>
        <cbc:Name>Beispiel Hosting</cbc:Name>
      </cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>Serverstraße 12</cbc:StreetName>
        <cbc:CityName>Musterstadt</cbc:CityName>
        <cbc:PostalZone>12345</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>DE</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>DE999999999</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Beispiel Hosting GmbH</cbc:RegistrationName>
        <cbc:CompanyID>HRB 00000 B</cbc:CompanyID>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Name>Buchhaltung</cbc:Name>
        <cbc:Telephone>+49 30 0000000</cbc:Telephone>
        <cbc:ElectronicMail>buchhaltung@beispiel-hosting.example</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">post@musterwerkstatt.example</cbc:EndpointID>
      <cac:PostalAddress>
        <cbc:StreetName>Beispielweg 3</cbc:StreetName>
        <cbc:CityName>Musterdorf</cbc:CityName>
        <cbc:PostalZone>54321</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>DE</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Musterwerkstatt Erika Mustermann</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cbc:PaymentID>BH-2025-0117</cbc:PaymentID>
    <cac:PayeeFinancialAccount>
      <cbc:ID>{SELLER_IBAN}</cbc:ID>
      <cbc:Name>Beispiel Hosting GmbH</cbc:Name>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:PaymentTerms>
    <cbc:Note>Zahlbar bis 29.01.2025 ohne Abzug.</cbc:Note>
  </cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">4.16</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">21.90</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">4.16</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>19</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">21.90</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">21.90</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">26.06</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">26.06</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="MON">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">9.90</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>Paket M: 50 GB Speicher, 10 Postfächer</cbc:Description>
      <cbc:Name>Webhosting Paket M, Januar 2025</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>19</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">9.90</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:ID>2</cbc:ID>
    <cbc:InvoicedQuantity unitCode="ANN">1</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">12.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Domain musterwerkstatt.example</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>19</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">12.00</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>
</ubl:Invoice>
"""


# ---- UBL: a credit note for part of that invoice


def ubl_credit_note():
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"
            xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
            xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>{XRECHNUNG_3}</cbc:CustomizationID>
  <cbc:ProfileID>{PEPPOL_PROCESS}</cbc:ProfileID>
  <cbc:ID>BH-G-2025-0004</cbc:ID>
  <cbc:IssueDate>2025-02-03</cbc:IssueDate>
  <cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>
  <cbc:Note>Gutschrift für den Ausfall am 20.01.2025.</cbc:Note>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>Kundennummer 40711</cbc:BuyerReference>
  <cac:InvoicePeriod>
    <cbc:StartDate>2025-01-20</cbc:StartDate>
    <cbc:EndDate>2025-01-21</cbc:EndDate>
  </cac:InvoicePeriod>
  <cac:BillingReference>
    <cac:InvoiceDocumentReference>
      <cbc:ID>BH-2025-0117</cbc:ID>
      <cbc:IssueDate>2025-01-15</cbc:IssueDate>
    </cac:InvoiceDocumentReference>
  </cac:BillingReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">rechnung@beispiel-hosting.example</cbc:EndpointID>
      <cac:PostalAddress>
        <cbc:StreetName>Serverstraße 12</cbc:StreetName>
        <cbc:CityName>Musterstadt</cbc:CityName>
        <cbc:PostalZone>12345</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>DE</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>DE999999999</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Beispiel Hosting GmbH</cbc:RegistrationName>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Name>Buchhaltung</cbc:Name>
        <cbc:Telephone>+49 30 0000000</cbc:Telephone>
        <cbc:ElectronicMail>buchhaltung@beispiel-hosting.example</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">post@musterwerkstatt.example</cbc:EndpointID>
      <cac:PostalAddress>
        <cbc:StreetName>Beispielweg 3</cbc:StreetName>
        <cbc:CityName>Musterdorf</cbc:CityName>
        <cbc:PostalZone>54321</cbc:PostalZone>
        <cac:Country>
          <cbc:IdentificationCode>DE</cbc:IdentificationCode>
        </cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Musterwerkstatt Erika Mustermann</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
    <cac:PayeeFinancialAccount>
      <cbc:ID>{iban("DE", "112233440000556677")}</cbc:ID>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">0.95</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">4.95</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">0.95</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>19</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">4.95</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">4.95</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">5.90</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">5.90</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:CreditNoteLine>
    <cbc:ID>1</cbc:ID>
    <cbc:CreditedQuantity unitCode="DAY">15</cbc:CreditedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">4.95</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Gutschrift Webhosting Paket M</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>19</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">0.33</cbc:PriceAmount>
    </cac:Price>
  </cac:CreditNoteLine>
</CreditNote>
"""


# ---- CII: invoices in UN/CEFACT Cross Industry Invoice syntax


def cii_party(name, street, postcode, city, email, tax=None, contact=None, party_id=None):
    id_xml = f"\n        <ram:ID>{x(party_id)}</ram:ID>" if party_id else ""
    contact_xml = ""
    if contact:
        person, phone, mail = contact
        contact_xml = f"""
        <ram:DefinedTradeContact>
          <ram:PersonName>{x(person)}</ram:PersonName>
          <ram:TelephoneUniversalCommunication>
            <ram:CompleteNumber>{x(phone)}</ram:CompleteNumber>
          </ram:TelephoneUniversalCommunication>
          <ram:EmailURIUniversalCommunication>
            <ram:URIID>{x(mail)}</ram:URIID>
          </ram:EmailURIUniversalCommunication>
        </ram:DefinedTradeContact>"""
    tax_xml = ""
    if tax:
        scheme, number = tax
        tax_xml = f"""
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="{scheme}">{x(number)}</ram:ID>
        </ram:SpecifiedTaxRegistration>"""
    return f"""{id_xml}
        <ram:Name>{x(name)}</ram:Name>{contact_xml}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>{postcode}</ram:PostcodeCode>
          <ram:LineOne>{x(street)}</ram:LineOne>
          <ram:CityName>{x(city)}</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:URIUniversalCommunication>
          <ram:URIID schemeID="EM">{x(email)}</ram:URIID>
        </ram:URIUniversalCommunication>{tax_xml}"""


def cii_line(number, name, quantity, unit, price, net, category, rate):
    return f"""
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>{number}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>{x(name)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>{price}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="{unit}">{quantity}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>{category}</ram:CategoryCode>
          <ram:RateApplicablePercent>{rate}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>{net}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>"""


def cii_tax(amount, base, category, rate, reason=None):
    reason_xml = f"\n        <ram:ExemptionReason>{x(reason)}</ram:ExemptionReason>" if reason else ""
    return f"""
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>{amount}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>{reason_xml}
        <ram:BasisAmount>{base}</ram:BasisAmount>
        <ram:CategoryCode>{category}</ram:CategoryCode>
        <ram:RateApplicablePercent>{rate}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>"""


def cii(spec, number, issued, seller, buyer, lines, settlement, buyer_reference=None, notes=(), delivered=None, process=None):
    process_xml = (
        f"""
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>{process}</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>"""
        if process
        else ""
    )
    notes_xml = "".join(f"\n    <ram:IncludedNote>\n      <ram:Content>{x(n)}</ram:Content>\n    </ram:IncludedNote>" for n in notes)
    reference_xml = f"\n      <ram:BuyerReference>{x(buyer_reference)}</ram:BuyerReference>" if buyer_reference else ""
    delivery_xml = (
        f"""
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime>
          <udt:DateTimeString format="102">{delivered}</udt:DateTimeString>
        </ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>"""
        if delivered
        else ""
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
                          xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
                          xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"
                          xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>{process_xml}
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>{spec}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>{x(number)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">{issued}</udt:DateTimeString>
    </ram:IssueDateTime>{notes_xml}
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>{"".join(lines)}
    <ram:ApplicableHeaderTradeAgreement>{reference_xml}
      <ram:SellerTradeParty>{seller}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>{buyer}
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>{delivery_xml}
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>{settlement}
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
"""


BUYER = cii_party("Musterwerkstatt Erika Mustermann", "Beispielweg 3", "54321", "Musterdorf", "post@musterwerkstatt.example")


def cii_xrechnung():
    """XRechnung 3.0 in CII from a Kleinunternehmer, who charges no VAT:
    category E with the § 19 UStG reason, and a Steuernummer (FC)."""
    seller = cii_party(
        "Grafikbüro Max Mustermann",
        "Malerstraße 7",
        "12345",
        "Musterstadt",
        "max@grafikbuero.example",
        tax=("FC", "12/345/67890"),
        contact=("Max Mustermann", "+49 30 1111111", "max@grafikbuero.example"),
        party_id="Lieferant 4711",
    )
    settlement = f"""
      <ram:PaymentReference>GB-2025-003</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>{GRAFIK_IBAN}</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>{cii_tax("0.00", "270.00", "E", "0", "Kleinunternehmer gemäß § 19 UStG")}
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>Zahlbar innerhalb von 14 Tagen ohne Abzug.</ram:Description>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20250317</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>270.00</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>270.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">0.00</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>270.00</ram:GrandTotalAmount>
        <ram:DuePayableAmount>270.00</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>"""
    return cii(
        XRECHNUNG_3,
        "GB-2025-003",
        "20250303",
        seller,
        BUYER,
        [cii_line(1, "Logo-Entwurf, drei Varianten", "6", "HUR", "45.00", "270.00", "E", "0")],
        settlement,
        buyer_reference="Angebot vom 10.02.2025",
        notes=["Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."],
        delivered="20250228",
        process=PEPPOL_PROCESS,
    )


def cii_en16931(spec=EN16931):
    """A ZUGFeRD invoice (profile EN 16931) from an office supplier: two
    VAT rates, and shipping as a charge on the whole invoice."""
    seller = cii_party(
        "Bürobedarf Beispiel GmbH",
        "Papierweg 5",
        "12345",
        "Musterstadt",
        "rechnung@buerobedarf.example",
        tax=("VA", "DE999999998"),
        contact=("Kundenservice", "+49 30 2222222", "service@buerobedarf.example"),
    )
    settlement = f"""
      <ram:PaymentReference>Rechnung 2025-10442</ram:PaymentReference>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
        <ram:PayeePartyCreditorFinancialAccount>
          <ram:IBANID>{SELLER_IBAN}</ram:IBANID>
        </ram:PayeePartyCreditorFinancialAccount>
      </ram:SpecifiedTradeSettlementPaymentMeans>{cii_tax("5.67", "29.85", "S", "19")}{cii_tax("1.74", "24.90", "S", "7")}
      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator>
          <udt:Indicator>true</udt:Indicator>
        </ram:ChargeIndicator>
        <ram:ActualAmount>4.90</ram:ActualAmount>
        <ram:Reason>Versand</ram:Reason>
        <ram:CategoryTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>19</ram:RateApplicablePercent>
        </ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>
      <ram:SpecifiedTradePaymentTerms>
        <ram:Description>Zahlbar bis 04.12.2025.</ram:Description>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">20251204</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>49.85</ram:LineTotalAmount>
        <ram:ChargeTotalAmount>4.90</ram:ChargeTotalAmount>
        <ram:AllowanceTotalAmount>0.00</ram:AllowanceTotalAmount>
        <ram:TaxBasisTotalAmount>54.75</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">7.41</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>62.16</ram:GrandTotalAmount>
        <ram:TotalPrepaidAmount>0.00</ram:TotalPrepaidAmount>
        <ram:DuePayableAmount>62.16</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>"""
    return cii(
        spec,
        "2025-10442",
        "20251120",
        seller,
        BUYER,
        [
            cii_line(1, "Druckerpapier A4, 500 Blatt", "5", "H87", "4.99", "24.95", "S", "19"),
            cii_line(2, "Fachbuch: Buchführung für Selbstständige", "1", "H87", "24.90", "24.90", "S", "7"),
        ],
        settlement,
        delivered="20251118",
    )


def cii_minimum():
    """Profile MINIMUM: header data only, which is no e-invoice in Germany."""
    seller = """
        <ram:Name>Kiosk am Markt</ram:Name>
        <ram:PostalTradeAddress>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>"""
    settlement = """
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount>10.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">1.90</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>11.90</ram:GrandTotalAmount>
        <ram:DuePayableAmount>11.90</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>"""
    return cii(MINIMUM, "K-77", "20250610", seller, "\n        <ram:Name>Musterwerkstatt</ram:Name>", [], settlement)


# ---- PDF


def pdf_text(value):
    """A PDF string literal in WinAnsiEncoding (Latin-1 plus €)."""
    raw = value.encode("cp1252")
    return b"(" + raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)") + b")"


def page_content(lines):
    out = [b"BT", b"/F1 10 Tf", b"14 TL", b"56 780 Td"]
    for line in lines:
        if line.startswith("# "):
            out += [b"/F2 16 Tf", pdf_text(line[2:]) + b" Tj T*", b"/F1 10 Tf", b"T*"]
        else:
            out.append(pdf_text(line) + b" Tj T*")
    out.append(b"ET")
    return b"\n".join(out)


XMP = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>{level}</fx:ConformanceLevel>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def stream(dictionary, data, compress=True):
    if compress:
        data = zlib.compress(data, 9)
        dictionary += b" /Filter /FlateDecode"
    return b"<< " + dictionary + b" /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"


def pdf(lines, xml=None, level="EN 16931", object_streams=False, mime=b"text#2Fxml"):
    """A one-page PDF showing lines, with xml embedded as factur-x.xml.
    object_streams packs the dictionaries into a compressed object stream
    with a cross-reference stream, as newer PDF writers do."""
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
        4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        6: stream(b"", page_content(lines)),
    }
    if xml is not None:
        data = xml.encode()
        name = b"(factur-x.xml)"
        objects[1] = (
            b"<< /Type /Catalog /Pages 2 0 R /Metadata 7 0 R /AF [8 0 R] /Names << /EmbeddedFiles << /Names [" + name + b" 8 0 R] >> >> >>"
        )
        objects[7] = stream(b"/Type /Metadata /Subtype /XML", XMP.format(level=level).encode(), compress=False)
        objects[8] = (
            b"<< /Type /Filespec /F " + name + b" /UF " + name + b" /Desc (Factur-X invoice) /AFRelationship /Alternative /EF << /F 9 0 R /UF 9 0 R >> >>"
        )
        packed = zlib.compress(data, 9)
        params = b"/Params << /Size %d /ModDate (D:20251120120000+01'00') >>" % len(data)
        if object_streams:
            # The length as an object of its own, inside the object stream.
            objects[10] = b"%d" % len(packed)
            length = b"/Length 10 0 R"
        else:
            length = b"/Length %d" % len(packed)
        objects[9] = (
            b"<< /Type /EmbeddedFile /Subtype /" + mime + b" " + params + b" /Filter /FlateDecode " + length + b" >>\nstream\n" + packed + b"\nendstream"
        )
    return write_pdf(objects, object_streams)


def write_pdf(objects, object_streams):
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    where = {}  # object number -> ("at", offset) or ("in", stream object, index)
    plain = sorted(objects)
    if object_streams:
        packable = [n for n in plain if b"stream" not in objects[n]]
        plain = [n for n in plain if n not in packable]
        holder = max(objects) + 1
        body = bytearray()
        pairs = []
        for n in packable:
            pairs.append(b"%d %d" % (n, len(body)))
            body += objects[n] + b"\n"
            where[n] = ("in", holder, len(pairs) - 1)
        header = b" ".join(pairs) + b"\n"
        objects = {**objects, holder: stream(b"/Type /ObjStm /N %d /First %d" % (len(packable), len(header)), header + bytes(body))}
        plain.append(holder)
    for n in plain:
        where[n] = ("at", len(out))
        out += b"%d 0 obj\n" % n + objects[n] + b"\nendobj\n"
    size = max(where) + 1
    if object_streams:
        xref_number = size
        where[xref_number] = ("at", len(out))
        size += 1
        rows = bytearray(b"\x00\x00\x00\x00\x00\xff\xff")
        for n in range(1, size):
            kind = where[n]
            if kind[0] == "at":
                rows += b"\x01" + kind[1].to_bytes(4, "big") + b"\x00\x00"
            else:
                rows += b"\x02" + kind[1].to_bytes(4, "big") + kind[2].to_bytes(2, "big")
        xref_at = len(out)
        out += b"%d 0 obj\n" % xref_number + stream(b"/Type /XRef /Size %d /W [1 4 2] /Root 1 0 R" % size, bytes(rows)) + b"\nendobj\n"
    else:
        xref_at = len(out)
        out += b"xref\n0 %d\n0000000000 65535 f \n" % size
        for n in range(1, size):
            out += b"%010d 00000 n \n" % where[n][1]
        out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % size
    out += b"startxref\n%d\n%%%%EOF\n" % xref_at
    return bytes(out)


ZUGFERD_PAGE = [
    "# Rechnung 2025-10442",
    "Bürobedarf Beispiel GmbH · Papierweg 5 · 12345 Musterstadt",
    "",
    "Musterwerkstatt Erika Mustermann",
    "Beispielweg 3, 54321 Musterdorf",
    "",
    "Rechnungsdatum: 20.11.2025    Lieferdatum: 18.11.2025",
    "",
    "1  Druckerpapier A4, 500 Blatt         5 × 4,99 €      24,95 €   19 %",
    "2  Fachbuch: Buchführung für Selbstständige   1 × 24,90 €   24,90 €    7 %",
    "   Versand                                                4,90 €   19 %",
    "",
    "Netto 54,75 €   USt 19 % 5,67 €   USt 7 % 1,74 €",
    "Gesamtbetrag 62,16 €, zahlbar bis 04.12.2025.",
]


def zugferd_pdf(object_streams=False):
    return pdf(ZUGFERD_PAGE, cii_en16931(), object_streams=object_streams)


def plain_pdf():
    return pdf(["# Quittung", "Kiosk am Markt", "Kaffee 3,20 €"])


SAMPLES = {
    "xrechnung-ubl.xml": lambda: ubl_invoice().encode(),
    "xrechnung-ubl-credit-note.xml": lambda: ubl_credit_note().encode(),
    "xrechnung-cii.xml": lambda: cii_xrechnung().encode(),
    "zugferd-en16931.pdf": zugferd_pdf,
}


def readings():
    """readings.json: einvoice_reader's answer for each sample."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import einvoice_reader

    result = {name: einvoice_reader.read_receipt(make(), name.rsplit(".", 1)[1]) for name, make in SAMPLES.items()}
    return (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode()


def main():
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for name, make in {**SAMPLES, "readings.json": readings}.items():
        (FIXTURES / name).write_bytes(make())
        print(FIXTURES / name)


if __name__ == "__main__":
    main()
