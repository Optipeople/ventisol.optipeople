# Ugeplan (the week's office workbook)

The office kept three workbooks per production week, typed by hand from 3E:
**Kontor** (turnover, hours and capacity), **BKS** (element types, batches,
welds) and **Kim_Produktion** (the shipping list). The page `/ugeplan` makes
all three, in one file, from the week's 3E database.

## How it works

1. In 3E the office exports the week as an Access file ("Uge 48.MDB").
2. On `/ugeplan` they drop it in. The browser reads it with `mdb-reader`
   (`lib/weekplan/mdb.ts`, `readWeekPlanFile`). The file never leaves the PC:
   it is 25 MB and more, over what a Vercel function takes, and only a few
   fields per order are needed.
3. The browser posts the week plan (`WeekPlan` in `lib/weekplan/types.ts`,
   some 50 KB) to `POST /api/ugeplan` (`lib/weekplan/handler.ts`). The server
   adds what the portal knows of each order from `core.orders`, builds the
   workbook (`lib/weekplan/workbook.ts`), and writes an `export.weekplan`
   audit row. Rate limit: the export limits. Role: `reports.view`.

## Where each column comes from

| Column | 3E table and field |
| --- | --- |
| Kunde | `A_Adresse.Firma`, address `Nummer` 0 |
| Ordre | `A_Kopf.AuNummer` |
| Ansv. | `A_Kopf.Sachbearb1`, as initials: the user who most often created the offer or order (`A_Vorgang` `_AngAnlage`, `_AufAnlage`) for that handler |
| Beløb | `A_Kopf.A_Summe` (ordresum ekskl. moms) |
| Bemærkning, Info | free field 6 (`A_KopfFreie.Feld6`) |
| Folie | free field 2 or 3 is "ja" |
| HTM | free field 4 ("Bestilt") |
| Timer | Σ `P_Technik.Stueck` × `PosZeit` (minutes) / 60 |
| Batch nr. | the distinct `P_Technik.SerieNr` |
| Elementer i alt | Σ Stück × frames (`P_Element` rows of the position) |
| Svejs i alt | Σ Stück × (frames + `AnzFlg`): one weld per frame and per sash |
| Fragt | the text of the freight position (`P_Art` 3, Typnummer "Fragt:") |
| Uge | `A_Planung.WocheW` (yyww); the plan's week is the one most orders have |

From the portal: **Prod.** (BKS) is "Pakket 20-11-2026", "I gang, 3 af 5
pakket" or "Ikke startet"; **Klar til afsendt** (Kim) is the packed day.

Left empty, filled in as before: budget and capacity (yellow), spec.
elementer, bue/skrå/tag, poste, sprosser, kobling, afsendelse, afsendt,
påklædning and the carrier. Totals are Excel formulas, so hand edits add up.

## Element types

`lib/weekplan/classify.ts`. The first line of a position's text lists its
fields in order, "n * X" for n of the same: "TS", "SH V / FR / SH H",
"16 * FK / DK HI / DK VI". Each frame (`P_Element`) names its fields in
`Feldnummer` ("00~00~04~00" is fields 0 and 4), so a coupled element is typed
frame by frame. A frame's opening parts are every part but FK: none makes a
fixed frame (FK S in SV & SJV, FK DL in Danline, else FK), one makes that
part's type, two or more the DB type.

| Part | Type |
| --- | --- |
| BH | SV |
| ID, galvanised | SD |
| ID with "alu", FD | FD/ID |
| TD opening out (HU, VU) | TD |
| TD opening in (HI, VI) | DK TD |
| DK | DK |
| TS | TS |
| SH in Danline | SH |
| SH or "Sideh." elsewhere | DK |
| Typnummer "Scan type 26/10/16/20/41" | T26 ... T41 |

Loose panels (Typnummer "Fyldning") and article lines (`P_Art` 3) are no
elements. A position the rules do not know is counted in Elementer i alt and
listed on the "Om udtrækket" sheet.

Kontor groups the types: D.døre (DB doors), døre (SD, FD/ID, TD, DK TD, KS
dør), D/K (DK, DB DK, FK, Scan), Danline (TS, SH, FK DL), sv (SV, FK S).
Kim groups by the leading part: an industrial door (ID) is a stable door
whether galvanised or alu, a turn and tilt terrace door goes under Dr/ki.

## Checked against week 48 2026

Against the office's own sheets for week 48: elements, welds and the type
columns agree for 46 of 48 orders. The two others are slips in the hand-typed
sheet (6 SV windows not entered on 58854; 58889 entered as a door in Kontor
but TS in BKS). Hours agree where the order is unchanged since it was typed
(58781: 7.8) and differ by a few tenths where it was edited later. Order
58890's Scan windows come out under T10, where the sheet had them under DK.
The meaning of free fields 2, 3, 4 and 6 is read from this one week; confirm
it with the office.
