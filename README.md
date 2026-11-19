# Bookkeeping

Bookkeeping for a small business in Germany under the small-business VAT
exemption (Kleinunternehmer, § 19 UStG), as an app for
[Omarchy](https://omarchy.org/): income and expenses with their receipts,
categories linked to the lines of the official EÜR form, analytics across
all years, and each year's Einnahmenüberschussrechnung ready to type into
ELSTER. Years of old spreadsheets come in through a CSV import. No account
and no sync: everything stays on this computer, plus, if set up, a nightly
copy on another computer of your own.

It runs as an Omarchy web app: a small local server and a "Bookkeeping"
window in the app launcher. Colors follow the current Omarchy theme.

![Overview](docs/overview.png)

## Install

Needs Omarchy, Python 3.11 or newer, and Chromium (Omarchy's default
browser).

```bash
git clone https://github.com/simonmcschubert/omarchy-bookkeeping.git ~/.local/share/omarchy-bookkeeping
~/.local/share/omarchy-bookkeeping/setup
```

`setup` adds a user service (`omarchy-bookkeeping.service`) that runs the
server at login on `http://127.0.0.1:47221/`, and a "Bookkeeping" entry in
the app launcher (`Super+Space`). The server reads the code from the cloned
directory, so keep it where it is. To update: `git pull`, then `setup`
again. `setup --remove` takes the service and the launcher entry out; the
data stays. `setup --backup` sets up the nightly copy to another computer
(see [Backup](#backup)).

## Views

- **Overview**: the year's income, expenses, profit and how close the
  revenue is to the Kleinunternehmer limit; profit per year since the first
  entry (click a year to open it); the year by month; income and expenses by
  category.
- **Entries**: every income and expense of a year, newest first, with its
  category, the EÜR line it counts on, and its receipt file (PDF, photo or
  e-invoice XML). Income gets the next running number by itself.
- **EÜR**: the Gewinnermittlung nach § 4 Abs. 3 EStG of a year, in the shape
  of the official form: each line with its number, its categories below it,
  the home-office days, totals and profit. **Print / PDF** prints it, followed
  by the year's income and expense lists, as the record to keep. Below: the
  home-office days by activity, and the profit filed with the tax office, to
  check the entries against it.
- **Settings**: categories and their EÜR lines, the line numbers of each
  year's form, the import, the business details, and the backup: when the
  last copy to another computer was made.

![EÜR](docs/euer.png)

## The EÜR

Each category (an account number, Konto, and a name) is linked to one line of
Anlage EÜR. The line numbers change from year to year, so they are kept per
form year. A year without its own numbers uses those of the nearest form that
has them and shows them in orange, as a reminder to check them against that
year's form. The seeded numbers are those of the 2025 form; lines 12
(Kleinunternehmer income) and 66 (Tagespauschale) are from a tax guide, not
yet checked against the form.

Income counts when the money arrives, and expenses when they are paid
(Zuflussprinzip): the date of an entry is the day of payment.

**Close year**, after filing, keeps the year's entries from being changed by
mistake; **Reopen year** allows it again.

## Import the old spreadsheets

Each year's spreadsheet has an **Einnahmen** and an **Ausgaben** table. In
Numbers, **File › Export To › CSV** writes one file per table. In
**Settings › Import**, pick the files of as many years as wanted at once.

- Einnahmen: Datum, Betrag, Beschreibung, Rechnungsnr. (the own running
  number), Rechnungsnr. EXTERN (the payer's), Konto
- Ausgaben: Datum, Betrag, Text, Rechnungsnr. (the supplier's), Konto

The columns are found by their names, under any title row; empty rows and
the Summe row are skipped; amounts like `1.234,56 €` and dates like
`15.01.2025` are read. The table is told by the file name (Einnahmen or
Ausgaben) or the columns, and can be switched per file. The import shows
what it would add per year before anything is saved, leaves out entries that
are there already, and makes unknown account numbers into categories without
an EÜR line, to link in Settings › Categories. The home-office days of past
years go in by hand on the EÜR page.

## Data

- `~/.local/state/omarchy-bookkeeping/bookkeeping.json`: everything but the
  receipt files, in a directory only its owner can open
- `…/backups/`: a copy of that file from before the first change of each
  day, the last 60 days
- `…/receipts/`: receipt files, named by their content
- `…/backup-status`: the result of the last backup;
  `~/.config/omarchy-bookkeeping/backup.conf`: where it goes

## Backup

Once a day, Bookkeeping can copy the data, its daily copies and the receipts
to another computer over SSH, such as a home server. Run once, with the
server's user and name, and a folder there of its own:

```bash
~/.local/share/omarchy-bookkeeping/setup --backup user@server:backups/omarchy-bookkeeping
```

Both computers need rsync (on Omarchy: `sudo pacman -S rsync`), and the
server needs this computer's SSH key in `~/.ssh/authorized_keys`. Connect
once by hand before (`ssh user@server true`), to confirm the server's host
key. Run setup in a terminal where that `ssh` works: if the key is in an SSH
agent (such as `ssh-tpm-agent`), setup saves where the agent is, for the
timer. It then makes the first copy and says whether it worked.

- **What**: everything in `~/.local/state/omarchy-bookkeeping` but the
  window's browser profile.
- **When**: a user timer (`omarchy-bookkeeping-backup.timer`) runs every
  hour, also right after a wake-up or start, and copies once a day. When the
  server can't be reached, it says so in one line of the journal and tries
  again an hour later.
- **Kept**: everything, for good. Nothing on the server is ever deleted. A
  file that changed here replaces its copy there, and the old copy moves to
  `replaced/<date and time>/`; receipts never change, so each stays as it
  was copied. The books must be kept for ten years and receipts for eight,
  counted from the end of the year (§ 147 AO). A mistake that got copied may
  be found only years later, at the next EÜR or in a tax audit; with every
  version kept, it can still be traced and undone. And it is small: ten
  years of 200 entries make a data file of about 800 KB; with changes on 100
  days a year, all copies of ten years stay under 1 GB.
- **Status**: Settings › Backup shows the last copy and why a try failed;
  the Overview warns when changes have waited more than three days.
- **Copy now**: `~/.local/share/omarchy-bookkeeping/backup`. **Stop**:
  `setup --no-backup`; the copies stay.
- **Check the timer**: `systemctl --user list-timers omarchy-bookkeeping-backup.timer`
  and `journalctl --user -u omarchy-bookkeeping-backup`.

To go back to an earlier version, copy it from the server over
`bookkeeping.json` here and reload the window.

![Settings › Backup](docs/backup.png)

## Not built yet

- Invoices as ZUGFeRD e-invoices (a normal PDF with the invoice data inside),
  marked paid to become income
- Reading received e-invoices (ZUGFeRD, XRechnung) into expenses
- Assets and their depreciation (AfA)
- An update button, as in Finance

## Development

```bash
node --test                               # app logic and import
python3 -m unittest discover -s test -v   # server, backup script, setup --backup
python3 server.py --port 47321 --data /tmp/books.json   # try it
```

The app is plain JavaScript modules and a Python standard-library server; no
build step. `CONTEXT.md` lists the words the code uses.
