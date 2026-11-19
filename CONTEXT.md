# Bookkeeping: domain language

The words the app, the code and reviews use for the same things. Amounts are
whole cents; dates are ISO dates (`2025-01-15`).

**Entry**: one income or one expense, on the day the money moved
(Zuflussprinzip). It has a date, an amount, a text, a category, a reference
and maybe a receipt. _Avoid_: transaction, booking.

**Income** and **Expense** (`kind`): the two kinds of entries. A negative
amount is a refund of its kind.

**Running number** (`number`, Nr.): the own number each income gets, counted
on across years (`nextNumber`). Expenses have none.

**Reference** (`ref`): the other side's invoice number: the supplier's for
an expense, the payer's (Rechnungsnr. EXTERN) for income.

**Category**: an account (`account`, Konto) and a name, of one kind, linked
to one EÜR line (`group`). Its id is `in-<Konto>` or `ex-<Konto>`. A category
without a line is **unlinked**: its entries are listed apart on the EÜR.

**EÜR line** (`groups`): a line of Anlage EÜR, such as Laufende EDV-Kosten.
Its **line number** is kept per **form year** (`lines`). A year without its
own number takes the nearest form's and marks it **carried** (`lineFor`).

**Home office** (`homeOffice`): days of business work at home, by activity,
per year. Times the **day rate** (`homeOfficeRate`: 6 € from 2023, 5 € in
2020 to 2022, none before) up to the yearly cap, it is the Tagespauschale.

**EÜR** (`euer()`): a year's Gewinnermittlung nach § 4 Abs. 3 EStG: income
and expenses by line and category, the home office, the totals and the
**profit** (Gewinn; negative: Verlust).

**Filed profit** (`filed`): the profit of the EÜR sent to the tax office for
a year, to check the entries against.

**Closed year** (`closed`): a filed year whose entries can't change until it
is reopened. Imports leave closed years out.

**Receipt**: the file behind an entry: a PDF, photo or e-invoice XML, kept
in `receipts/` under the SHA-256 of its content.

**Revenue limit** (`revenueLimit`): the most a year's income may be for the
next year to stay without VAT (§ 19 UStG): 25.000 € from 2025, 22.000 € in
2020 to 2024, 17.500 € before. From 2025 the current year may also not pass
100.000 €; the app does not show that one.

**Import**: CSV files of the spreadsheet tables (`readTable`), checked
against the data (`planImport`) before they are added (`applyImport`). A
**copy** has the same kind, date, amount and text as an entry already there,
and is left out.
