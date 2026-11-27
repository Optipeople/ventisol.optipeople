# Ugeplan (the week's office workbook)

The office kept three workbooks per production week, typed by hand from 3E:
**Kontor** (turnover, hours and capacity), **BKS** (element types, batches,
welds) and **Kim_Produktion** (the shipping list). The page `/ugeplan` makes
all three, in one file, for one week.

## Sources

1. **The production lists (default).** The 3E production list PDFs the portal
   already reads (docs/order-documents.md). Pick a week (`/ugeplan?uge=2026-48`,
   next week by default) and download: `GET /api/ugeplan?uge=2026-48`.
   `rpt.week_plan_documents(year, week)` takes each order's newest list and
   then keeps the orders of that delivery week, also those not scanned yet
   (they have no row in `core.orders`). An order moved to another week leaves
   its old one. The week is the one `core.orders` gives the order when it has
   a row, else the list's "Lev. uge". "Lev. uge" has no year: the list is of
   the year when it was printed (or synced, without a print date) in the 30
   weeks before that week's Monday or the two weeks after. An odd parsed
   value cannot make the call fail.
2. **The 3E database (optional).** The office exports the week from 3E as an
   Access file ("Uge 48.MDB") and drops it on the page. The browser reads it
   with `mdb-reader` (`lib/weekplan/mdb.ts`); the file never leaves the PC (it
   is 25 MB and more, over what a Vercel function takes). The browser posts
   the plan it read (`WeekPlan`, some 50 KB) to `POST /api/ugeplan?uge=...`.
   A file of another week than `uge` is refused, so its orders cannot land in
   the wrong week.
3. **The scans**, always: Prod. and Klar til afsendt.

The server (`lib/weekplan/handler.ts`) builds the plan from the lists
(`lib/weekplan/portal.ts`), puts the 3E plan on top (`mergeWeekPlans`: an
order in both takes 3E's figures, an order in only one is kept), adds the
production status and writes the workbook (`lib/weekplan/workbook.ts`). One
`export.weekplan` audit row. Rate limit: the export limits. Role: `reports.view`.

## Where each column comes from

| Column | Production list | 3E database |
| --- | --- | --- |
| Kunde | first customer line | `A_Adresse.Firma`, address `Nummer` 0 |
| Ordre | order number | `A_Kopf.AuNummer` |
| Ansv. | initials of Sagsbeh.: one letter for the first name, one per later name or part of a hyphenated one ("Mai-Britt Undall-Behrend" is mub) | `A_Kopf.Sachbearb1` as initials: the user who most often created that handler's offers and orders (`A_Vorgang`) |
| Beløb | none | `A_Kopf.A_Summe` (ordresum ekskl. moms) |
| Bemærkning, Info | the positions' notes | free field 6 (`A_KopfFreie.Feld6`) |
| Folie | "Folie" when every element has a foiled colour, "Delvis folie" when some have (Farve karm / Farve ramme) | "Folie godkendt" when free field 2 or 3 is "ja"; else the same colour rule on `P_Werkstoffe.Farbe1`/`Farbe2` |
| HTM | none | "HTM" when an article's supplier (`P_Artikel.Kreditor`) is HTM, with free field 4 (Partas in 3E): "HTM bestilt" |
| Frie felter (sheet) | none | every free field 1 to 36 (`A_KopfFreie.Feld1`..`Feld36`) that holds something, one column per field |
| Timer | Σ Antal × the calculated time of the position's element type over all stations (`config.calculated_times`; empty for a viewer, who may not see it) | Σ `P_Technik.Stueck` × `PosZeit` / 60 |
| Batch nr. | none | the distinct `P_Technik.SerieNr` |
| Elementer i alt | Σ Antal (one frame per position) | Σ Stück × frames (`P_Element` rows) |
| Svejs i alt | Σ Antal × (1 + fields with a sash size) | Σ Stück × (frames + `AnzFlg`) |
| Fragt | none | the text of the freight position (`P_Art` 3) |

**Folie** is read from the colours: a foiled profile has a two-sided colour,
outside/inside ("Anthrazitgrå fin struktur/hvid", "Lightgrau/hvid", in the
3E file shortened to "FAnthrazitgrå/h"); a plain one has one colour ("Hvid",
"Grå"). For week 48 2026 this gives exactly the office's four "Folie godkendt"
orders, and 58790, which they noted as "delvis folie", comes out partly
foiled. `rpt.week_plan_documents` returns the colours from migration
`20261118130000_week_plan_colours.sql` on.

**Frie felter**: the 3E file holds the free fields' values but not their
names (those live in 3E's own setup), so the sheet names the columns by
number ("Frit felt 4"). Field 4 is Partas (HTM): it says "Bestilt" on exactly
the orders whose articles come from HTM.

Left empty, filled in as before: budget and capacity (yellow), spec.
elementer, bue/skrå/tag, poste, sprosser, kobling, afsendelse, afsendt,
påklædning and the carrier. Totals are Excel formulas, so hand edits add up.
The "Om udtrækket" sheet says which orders came from where.

## Element types

`lib/weekplan/classify.ts`. A frame is typed by its parts. Its opening parts
are every part but a fixed light (FK): none makes a fixed frame (FK S in SV &
SJV, FK DL in Danline, else FK), one makes that part's type, two or more the
DB type.

The parts of a production list position are its fields' opening functions
(`openingPart`): "Fast karm" FK, "Bundhængt SV" BH, "Industridør ..." and
"Industridør stående" ID (so are "Indv. dør ..." and "Hesteboks ...", a guess
until Ventisol says otherwise), "Facadedør ..." FD, "Terrassedør ..." TD (inwards
with "d/k" or H.I./V.I.), "Drej Kip ..." DK, "Topstyret ..." TS, "Topvende" TV, "Kip / skydedør ..." KS,
"Sidehængt ..." SH. The list prints a coupled element as one position, so it
counts as one frame.

The parts of a 3E position come from the first line of its text ("TS",
"SH V / FR / SH H", "16 * FK / DK HI / DK VI"); each frame (`P_Element`) names
its fields in `Feldnummer` ("00~00~04~00" is fields 0 and 4), so a coupled
element is typed frame by frame. The Scan types come from `Typnummer`.

| Part | Type |
| --- | --- |
| BH | SV |
| ID, galvanised | SD |
| ID with "alu", FD | FD/ID |
| TD opening out (HU, VU) | TD |
| TD opening in (HI, VI, d/k) | DK TD |
| DK | DK |
| TS | TS |
| TV ("Topvende") | TV |
| KS ("Kip / skydedør") | KS dør |
| SH in Danline | SH |
| SH or "Sideh." elsewhere | DK |
| 3E Typnummer "Scan type 26/10/16/20/41" | T26 ... T41 |

Loose panels (3E Typnummer "Fyldning") and article lines (`P_Art` 3) are no
elements. A position the rules do not know is counted in Elementer i alt and
listed on "Om udtrækket".

Kontor groups the types: D.døre (DB doors), døre (SD, FD/ID, TD, DK TD, KS
dør), D/K (DK, DB DK, FK, Scan), Danline (TS, SH, FK DL), sv (SV, FK S).
Kim groups by the leading part: an industrial door (ID) is a stable door
whether galvanised or alu, a turn and tilt terrace door goes under Dr/ki.

## Checked against real data

- **3E database, week 48 2026**, against the office's own sheets: elements,
  welds and the type columns agree for 46 of 48 orders. The two others are
  slips in the hand-typed sheet (6 SV windows not entered on 58854; 58889
  entered as a door in Kontor but TS in BKS). Hours agree where the order is
  unchanged since it was typed (58781: 7.8) and differ by a few tenths where
  it was edited later. Order 58890's Scan windows come out under T10, where
  the sheet had them under DK.
- **Production lists**: the 26 sample lists in `context/orderfiles` are all
  typed, none unknown. They are from other weeks than the sheets, so they
  are not compared column by column.
- The meaning of 3E free fields 2, 3, 4 and 6 is read from one week; confirm
  it with the office.
