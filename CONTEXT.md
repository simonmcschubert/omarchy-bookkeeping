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
The home office's line and the assets' lines take their amounts from those,
not from categories (`isComputedGroup`).

**Home office** (`homeOffice`): days of business work at home, by activity,
per year. Times the **day rate** (`homeOfficeRate`: 6 € from 2023, 5 € in
2020 to 2022, none before) up to the yearly cap, it is the Tagespauschale.

**EÜR** (`euer()`): a year's Gewinnermittlung nach § 4 Abs. 3 EStG: income
and expenses by line and category, the assets by line, the home office,
the totals and the **profit** (Gewinn; negative: Verlust).

**Filed profit** (`filed`): the profit of the EÜR sent to the tax office for
a year, to check the entries against.

**Closed year** (`closed`): a filed year whose entries can't change until it
is reopened. Imports leave closed years out.

**Daily copy** (`backups/`): the data file as it was before the first change
of a day, kept next to it for 60 days (`back_up`). _Avoid_: backup, for this.

**Backup** (`backup`, Settings › Backup): the copy of the data, its daily
copies and the receipts on another computer, made once a day by the `backup`
script. Its **destination** (`[user@]host:path`) is set by `setup --backup`;
its result is in `backup-status`. Nothing at the destination is deleted.

**Replaced copy** (`replaced/<date and time>/`): a file a backup replaced at
the destination, kept there, so every version stays.

**Receipt**: the file behind an entry: a PDF, photo or e-invoice XML, kept
in `receipts/` under the SHA-256 of its content.

**Asset** (`assets`, Anlagegut): something bought for the business to use
for more than a year, such as a laptop or a desk. It owns its purchase: it
is no entry, and its cost counts as **write-off** over the years instead.
Its **kind** (`type`) decides how: computer, computer accessory, software,
office furniture and equipment, other. _Avoid_: fixed asset, item.

**Cost** (`cost`, Anschaffungskosten): what an asset cost as paid, VAT
included, since a Kleinunternehmer can't deduct it. **Net cost** (`netCost`)
leaves out the VAT of the invoice (`vatRate`) and decides whether it is a
GWG.

**Bought** (`date`): the day an asset was delivered, which decides its year,
not the day it was paid.

**Write-off** (`treatment`): how an asset's cost is spread. **GWG**
(geringwertiges Wirtschaftsgut, up to 800 € net): all in the year bought.
**One year** (computers and software from 2021): all in the year bought, as
AfA. **Linear**: AfA in equal amounts over its **useful life** (`life`,
Nutzungsdauer, from the AfA table), by month in the first year.

**AfA** (Absetzung für Abnutzung): the year's share of an asset's cost.

**Book value** (Buchwert): an asset's cost less its write-off so far.

**Gone** (`disposal`: date and price): the day an asset was sold, thrown away
or taken for private use, and its price (0 when thrown away; its value then
when taken). The **remaining book value** (Restbuchwert) that day is an
expense; the price is income. _Avoid_: sold (it may not have been).

**Anlage AVEÜR** (`aveur`): the asset list of the EÜR form, by block
(immaterielle Wirtschaftsgüter, Büroausstattung, Andere), without the GWG.

**Revenue limit** (`revenueLimit`): the most a year's income may be for the
next year to stay without VAT (§ 19 UStG): 25.000 € from 2025, 22.000 € in
2020 to 2024, 17.500 € before. From 2025 the current year may also not pass
100.000 €; the app does not show that one. Sales of assets don't count
(`yearTotals().revenue`).

**Import**: CSV files of the spreadsheet tables (`readTable`), checked
against the data (`planImport`) before they are added (`applyImport`). A
**copy** has the same kind, date, amount and text as an entry already there,
or as an expense made into an asset (`entryKey`), and is left out.
