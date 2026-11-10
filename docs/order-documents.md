# Order documents (Produktionsliste PDFs)

When an operator scans an element in, the station app can show the order's production document.
3E writes one PDF per order. This note describes those files as found in 26 real samples (October
2026), and how the station app reads them. Code: `apps/station/src/Ventisol.Station.Core/Documents`.

## Where the files are

- One file per order: `<order>_<yyyyMMdd>.pdf`, e.g. `58721_20261022.pdf`. The date is the print date.
- On site the folder is the network share `R:\Indkøb\Shares\Ordre`. It may have subfolders, and it may be
  slow or offline.
- An order can be printed again. The locator takes the newest date in the name, then the newest write time.
- The folder is a setting on the setup screen, "Mappe med ordredokumenter" (`StationSettings.DocumentsFolder`).
  Empty turns the feature off.
- The samples are customer data. They live in the untracked `orderdocs/` folder at the repo root on the
  developer's PC and are never committed. Tests that read them skip when the folder is missing.

## What a file looks like

Landscape pages, 839 x 592 pt. Real text (Arial, Arial Bold, Arial Narrow) and vector lines, no form
fields, no scanned images. Every page starts with the same header. Each position starts on a new page and
runs over one or two pages. The samples hold 1 to 19 positions per order and 1 to 23 pages per file.

### Header (every page)

| Label | Example | Notes |
|---|---|---|
| Ordrer nr. | 58721 | bold |
| Kunde | name, street, postcode and town | 2 or 3 lines |
| Lev. adr. | name (often with a phone number), street, town | 2 or 3 lines, may differ from Kunde |
| Lev. uge | 46 | delivery week |
| Dato | 22-10-2026 | |
| Sagsbeh. | case handler's name | |
| Side | 1 | page number in the file |
| Glas lev. | usually empty | |
| Glas palle | `_____` | a line to write on |
| Pakke info. | usually empty | |

A long rule (`____`) ends the header.

### A position's first page

Left column, top to bottom:

- `System`: the profile system, e.g. `SOFTLINE`, `DANLINE`, `70 mm Industri`, `70 mm SV & SJV`.
- `Position:` a whole number. The samples never print "5.1" (see Barcode below). Numbers can skip
  (an order with positions 1, 2 and 4, another with only 3 and 5).
- `Farve karm:`, `Farve ramme:`, `Farve tætning:` e.g. `Hvid`, `Lightgrau/hvid`, `Grå`.
- `Antal:` how many elements of this position (1 to 50 in the samples).
- `Karmhuller:` e.g. `d=6,5 ve/hø`, or empty.
- Notes in bold below, one to three lines, e.g. "Karm og ramme pakkes særskilt", "Løs karm inkl. beslag".
  A note can run on into the Felt column.

"Felt oplysninger" table to the right, one block per field (Felt). An element has 1 to 3 fields in the samples.

| Column | Example | Notes |
|---|---|---|
| Felt | 1 | |
| Åbningsfunktion | Drej Kip V.I., Fast karm, Bundhængt SV, Topstyret ud, Sidehængt H.U. med anverfer, Industridør H.U. falle m/galv.trin, Terrassedør d/k H.I., Facadedør ... | Arial Narrow |
| Rammemål | 1415,0 * 1310,0 | empty for "Fast karm" (no sash) |
| Glastype | first line the glass, then `indv.`, `midt.`, `udv.` lines | also `Fyldning 23 mm, Hvid` (door panel), `Ingen glas` |
| Stk | 1 | panes of this size |
| Glasmål | 1283 * 1178 | |
| Glasliste | 107.208_G | can be missing (loose acrylic) |
| Tætning | 112.253 | mostly on fixed fields |

A door field can have two Stk / Glasmål lines (glass above a panel). Its second Glasliste sits a few
lines lower than its Glasmål, so the parser pairs them in order.

Then, right of the cutting list:

- Scale and weight: `1:50   Ca. 84,5 kg pr.element`. The weight can be missing.
- `Mål u/kobling: 1485,0 * 1380,0`: width * height in mm without coupling profiles.
- The drawing: always at the top left corner (578, 279) in PDF points, growing down and right,
  about 50 to 120 pt wide. Thin stroked lines (0.12 pt), dimension text turned 90 degrees for the
  height, plain text for the width and field labels (`1.0`, `2.0`; a door with glass and panel shows
  `1.1`, `1.2`). About a third of the drawings also hold small raster images (hatching, panels).

Below a dashed rule, "Afkortning" (cutting list):

| Column | Example | Notes |
|---|---|---|
| profile | 101.282_G, 103.232 Z_G, galv.20x50, BKV 120T | no head |
| Bredde | 85,0 | only in some sections, its head sits on the section line ("Sprosse  Bredde") |
| Stk. | 1 | |
| Længde | 1491,0 | |
| side | Un, Ov, Ve, Hø, Lp, Vp, Lod., Van. | no head; can be empty |
| Stål | 113.002, **113.368.2 | steel reinforcement, can be empty |
| Længde | 1390 | steel length |
| Felt nr. | 1 | empty for frame parts |
| Lysm. T/V | 924,0 | only for some bars |

Rows sit under bold section lines: `Karm`, `Ramme`, `Sprosse`, `Blændstykke`. On some pages the head
line is printed in two parts a fraction of a point apart.

Then, optionally, a "Felt / Beskrivelse / Farve" table: glazing bars laid in a field, e.g.
`1  26 mm. ilagt  Hvid  Lod.  303,3` (field, description, colour, direction, length).

Then "Beskrivelse" (hardware): Beskrivelse, Farve, Antal, Mål, Mont./Løs, Placering. Mostly only
the description and Antal are filled. A long description can run into the Farve column, and in one
sample a description and its colour are printed on top of each other.

Then "Tilbehør" (accessories), the same columns but shifted (Antal at x 245, not 258). After it can
come another heading laid out the same way, e.g. "Tilsætningsprofil" (add-on profiles, with Farve,
Antal, Mål, Mont./Løs and Placering filled).

A fixed window with no hardware has no Beskrivelse table.

### Pages after the first

A position's second page has only the header and the rest of its tables, with no heading of their
own: more accessories, more hardware, or more cutting list rows (seen with a Sprosse section). 17 of
the 57 positions in the samples run over two pages. None runs over three.

### Odd bits

- Bold text is often drawn twice on the same spot. Read naively it gives "4466" for "46" and
  "TTeerrrraasssseeddøørr". The parser drops a letter drawn again at the same place.
- Text can be printed over other text (a description over its colour, a drawing label over
  "Mål u/kobling"). The parser builds words from the letters in the order they were drawn, not by
  sorting on x, so the two stay apart.
- Characters are Danish (æ, ø, å) and come through as Unicode. Some descriptions carry `**`, `"Z"`,
  `+FH`, `/`.
- A dot sits under the header rule on every page (x 284). It is ignored.
- Two positions never share a page.

## Barcode and sub-position

The label barcode `058556050103` is order 58556, position 05, sub-position 01, piece 03.

- Position maps to the PDF's `Position:`.
- Piece is one of the position's `Antal` elements. The PDF has one page set per position, not per piece.
- Sub-position does not appear in any sample. All 57 positions print a whole number. The drawings'
  `1.1`, `2.2` labels are field and pane, not sub-positions. So today every sub-position of a position
  shows the same document position. `Mål u/kobling` hints that coupled elements exist; if 3E ever prints
  `Position: 5.1`, the parser keeps it as `SubNumber` 1, and barcode sub-position 02 picks it (the same rule
  as `Barcode.PositionLabel`: sub-position 01 is the position itself). To confirm with a real coupled order.

## The model

`OrderDocumentParser.Parse(path | bytes | stream)` gives an `OrderDocument`; it never throws, and
`Problems` lists what it could not read (empty for all 26 samples).

- `OrderDocument`: `FilePath`, `PageCount`, `Header`, `Positions`, `Problems`, `PositionFor(barcode)`.
- `OrderDocumentHeader`: `OrderNumber`, `Customer` and `DeliveryAddress` (lines, name first),
  `DeliveryWeek`, `Date`, `CaseHandler`, `PackageInfo`, `GlassDelivery`, `GlassPallet`.
- `OrderPosition`: `Label`, `Number`, `SubNumber`, `System`, `FrameColour`, `SashColour`, `SealColour`,
  `Quantity`, `FrameHoles`, `Notes`, `Fields`, `Scale`, `WeightKg`, `SizeWithoutCoupling`, `Cutting`,
  `FieldBars`, `Hardware`, `Accessories`, `PageIndex` (0-based first page), `PageCount`, `Drawing`.
- `OrderField`: `Number`, `Opening`, `FrameSize`, `GlassType` (lines), `Panes` (`GlassPane`: `Quantity`,
  `Size`, `GlassList`), `Seals`.
- `CutRow`: `Section`, `Profile`, `Width`, `Quantity`, `Length`, `Side`, `Steel`, `SteelLength`, `Field`, `Clearance`.
- `FieldBarRow`: `Field`, `Description`, `Colour`, `Side`, `Length`.
- `HardwareRow`: `Group` ("Beskrivelse", "Tilbehør", "Tilsætningsprofil"), `Description`, `Colour`,
  `Quantity`, `Size`, `Mounting`, `Placement`.
- `PdfBox`: the drawing on page `PageIndex`, in PDF points from the bottom left, padded 3 pt, with the
  page size. `TopFromTop` is the distance from the top edge, for cropping a rendered page.

Lengths and sizes stay as printed (`1491,0`), so nothing is lost in rounding.

## Finding the file

`OrderDocumentLocator(folder)`:

- `FindAsync(order)` gives `OrderDocumentLookup(Order, Status, Path, Error)` with status `Found`,
  `NotFound`, `FolderUnavailable` or `Off` (no folder set).
- Lists `<order>_*.pdf` in the folder and its subfolders (8 levels) on a background thread, into an
  index kept for 30 s. A miss lists again, at most every 3 s. One listing runs at a time.
- A listing slower than 10 s answers from the last index if it has the order, else `FolderUnavailable`
  ("Mappen svarer ikke"); the listing goes on and fills the index for the next scan.
- `RefreshAsync()` and `CheckFolderAsync(folder)` give `OrderDocumentFolderStatus(Available, Orders, Files, Error)`,
  which the setup screen shows as "Fundet 26 ordrer" or "Mappen kan ikke læses".

## On the station screen

A tap on a station tile opens its element's document over the stations page (`DocumentOverlay`,
content in the reusable `OrderDocumentView`, view model `OrderDocumentViewModel`). In the demo, where a
tap scans, the small document button at the tile's top right opens it instead. It shows the element in
progress at the station, else the last one finished there today, else an empty state.

- Header: order, position, piece ("1 af 6"), customer, Lev. uge, system, and whether it is in progress.
- The drawing, cut from the position's page and rendered by Windows' own PDF engine (`Windows.Data.Pdf`,
  hence the app's `net10.0-windows10.0.19041.0` target), in the screen's ink on the panel colour.
- Cards (`ElementSheet`): Mål u/kobling, weight, colours, Karmhuller, one card per field; then the cutting
  list and hardware/accessories as tables. "Vis hele PDF" shows every page rendered, from the position's page.
- States: feature off, folder unavailable, order not found (with "Prøv igen"), position not in the PDF
  (the whole PDF with a warning), and a warning when the parser reported problems.
- Closes with "Luk", Esc, or after 3 minutes untouched. Scans go on while it is open; their answers show
  as a strip at the bottom, and the document follows its station to a new element.
- `OrderDocuments` finds and parses in the background (read timeout 15 s) and keeps the last 24 parsed
  files by path, write time and size. A scan-in pre-fetches the document and renders the drawing, so the
  tap is instant. Rendered bitmaps are cached too (`PdfRender`).

A picture without tapping, with its own data folder so it never meets the running app:

```
$env:VENTISOL_STATION_DATA = "$env:TEMP\vs-snap"
VentisolStation.exe --snapshot-document <folder> 058721010101 out.png [--pages] [--size 1920x1080]
```
