# Order documents (Produktionsliste PDFs)

When an operator scans an element in, the station app can show the order's production document.
3E writes one PDF per order. This note describes those files as found in 26 real samples (October
2026), and how the station app reads them. Code: `apps/station/src/Ventisol.Station.Core/Documents`.

## Where the files are

- One file per order: `<order>_<yyyyMMdd>.pdf`, e.g. `58721_20261022.pdf`. The date is the print date.
- On site the folder is the network share `R:\Indkøb\Shares\Ordre`. It may have subfolders, and it may be
  slow or offline.
- Special orders carry a prefix before the order number: `BE_58721_20261022.pdf`, and any other prefix
  (`TE_`, `RKK_` ...). The name is parts split by `_`: the last part is the date, the part before it is the
  order (all digits), and every part before that is a prefix that must hold a letter. A name with two
  numbers before the date (`2_58721_20261022.pdf`) is not taken as an order document.
- Orders with arched or bevelled elements ("bue/skrå", BS) have two more files, named by Ventisol: a
  production list of the BS positions alone and their drawings. Since 27-11-2026 they are
  `58931_20261127BS.pdf` and `58931_20261127BS tegninger.pdf`; before that `B S 58931_20261112.pdf` and
  `B S tegninger 58931_20261112.pdf`. The BS label ("BS", "B S", "BS tegninger", any case) may stand after
  the date, before the order or as a part of its own (`BS_58931_...`); it gives the kind
  (`OrderDocumentKind`: List, BsList, BsDrawings) and is not part of the prefix.
- The label is read loosely: B, S, "tegninger" (or "tegning") and the number may be held apart by spaces,
  `_` or `-`, one or more (`BS_tegninger_58931_20261127.pdf`, `58931_20261127BS_tegninger.pdf`,
  `B  S 58931_20261112.pdf`). Before the order there must be at least one of them (`BS58931_...` is not
  read). A prefix that only ends in BS (`ABS_`, `LBS_`) is a prefix, not a label.
- Text after a label that follows the date keeps the kind and the date: `58931_20261127BS (1).pdf`,
  `58931_20261127BS - Kopi.pdf` and `58931_20261127BS tegninger rev2.pdf` are BS files, never the list.
  A copy mark right after the date (`58931_20261127 (1).pdf`, `B S 58931_20261112 (1).pdf`) keeps the kind
  too, but the date is then not read, so the file loses to one with a date. A name with no date part
  (`58931_BS.pdf`) is not read.
- An order can be printed again, and an older version may be kept beside the new one as history (with or
  without a prefix). The locator takes the order's list before its BS files, then the newest date in the
  name, then the newest write time. A BS file is the order's document only when it has no list.
- When the scanned element's position is not in the order's list and the order has a BS list that holds
  it, the station shows the BS list (`OrderDocuments.LoadAsync`), from the folder or from OptiCloud.
- The order's newest BS drawings file comes along with the document (`OrderDocumentLoad.BsDrawings`), and
  the screen offers it with "Vis BS-tegning" (see BS drawings, and On the station screen).
- The upload writes `Prefix` as the prefix and the BS label (`BS`, `BE_BS tegninger` ...). The web stores BS
  files with that prefix and no `print_date`, so every reader ordering by `print_date desc nulls last`
  keeps the list first.
- The folder is a setting on the setup screen, "Mappe med ordredokumenter" (`StationSettings.DocumentsFolder`).
  Empty: the PDFs come from OptiCloud instead (see Reading from OptiCloud), or the feature is off when
  OptiCloud isn't set up either.
- A PDF over 50 MB (`OrderDocuments.MaxPdfBytes`) is not read: the screen says
  "Filen er for stor (over 50 MB)", and it is not uploaded (see Uploading).
- The samples are customer data. They live in the untracked `orderdocs/` folder at the repo root on the
  developer's PC and are never committed. Tests that read them skip when the folder is missing.

## The copy in OptiCloud

The list `VentisolOrderDocuments` ("Ventisol ordredokumenter") in the Ventisol account holds one row
per PDF, so the web and tablets can show them later. It was made by hand on 2026-11-11 with the 26
samples; the station app now makes it (and any missing column) and uploads new PDFs to it
(`OrderDocumentUpload`, run by `CloudSync`). A PC with no documents folder set reads the PDFs from it
(see Reading from OptiCloud); a PC with a folder shows them from the share.

| Column | Type (`dataType`) | What |
|---|---|---|
| `FileName` | String (0), key, unique, required | `58721_20261022.pdf` |
| `OrderNo` | Int (2) | `58721` |
| `Prefix` | String (0) | `BE`, empty for an ordinary order |
| `PrintDate` | DateTime (3) | the date in the name, `2026-10-22T00:00:00Z` |
| `File` | Blob (8) | `{ name, contentType, reference }` from the upload |
| `SizeBytes` | Int (2) | size of the file |
| `Sha256` | String (0) | hex hash of the file, to tell a changed file under the same name |
| `Device` | String (0) | the PC that made or took the row (Windows machine name); empty on the 26 first rows |
| `ClaimedAt` | DateTime (3) | when that PC made or took the row, UTC by OptiCloud's clock |

### Uploading

- Every PC with the documents folder set and OptiCloud set up takes part, in Scan and Viewer mode.
  It starts once the app is connected, in a loop of its own: a failure there never holds up the scans.
- Every 5 minutes (plus up to a minute, so the PCs don't all come at once) the folder is listed
  (a listing the scans made in the last 5 minutes is used as it is) and
  every order document not in the list goes up, newest print first, a second apart. Only files
  printed in the last 60 days (the date in the name, else the write time), so a first run doesn't
  push years of history through, and only files written at least 2 minutes ago that start with
  `%PDF-` and end with `%%EOF`: a file 3E is still writing waits for the next round.
- While every such file is known to be in the list, nothing is asked of OptiCloud.
- The same file name in two subfolders is one row: the file written last.
- Several PCs see the same folder, and a file stored without a row can't be deleted. So the row is
  made first, without the file but with everything else: the unique `FileName` lets one PC in, and
  only that PC uploads and then puts the file in its row. A PC that is refused because another PC's
  row is there ends its round and looks again next time.
- A row left without a file (the PC stopped, the upload failed) is finished by the PC in its
  `Device` column. Once its `ClaimedAt` is an hour old any PC takes it over: it reads the row
  again, writes its own name and the time, waits a few seconds, and goes on only if the row still
  names it. The new time keeps the other PCs off the row for another hour.
- A file stored whose row could not be updated is remembered, also over a restart
  (`document-uploads.json` in the app's data folder), and used on the next try, not stored again.
- A file OptiCloud refuses (too big, a value it won't take) is tried again on the next two rounds
  and then left alone until it is written again; the other files go up meanwhile. So is a file that
  isn't a whole PDF. One that can't be read (locked, no access) is tried again about once an hour.
  A file over 50 MB is never read and is left alone until it is written again.
- Other failures (no network, the share gone) are logged once
  (`Ordredokumenter: kan ikke lægges op til OptiCloud: ...`) and tried again next round; after a
  wrong password this loop waits an hour, as every try counts towards locking the user out. Each upload is logged
  (`Ordredokumenter: 58721_20261022.pdf er lagt i OptiCloud`). Nothing is shown on the screen.
- Not handled: a file that changes under the same name keeps its first upload (a reprint normally
  gets a new date and so a new name), and a file deleted from the share stays in the list.

### Reading from OptiCloud

For a PC that can't reach the share (Scan or Viewer mode): leave "Mappe med ordredokumenter" empty and
set up OptiCloud. `OrderDocuments.Cloud` (`CloudDocumentSource`) then finds and fetches the PDFs.

- It uses the app's own connection (`CloudSync.Connection`), so there is no second login. Before the app
  is connected, the screen says "Ordredokumenterne kan ikke hentes fra OptiCloud · Ikke forbundet til
  OptiCloud endnu", with "Prøv igen".
- A lookup asks `GetRowsPaged` with `keyword=<order>` (50 rows, newest `PrintDate` first) and keeps the
  rows whose `FileName` gives that order and that have a file. The newest date in the name wins, then
  the newest row. If the keyword search finds none, the whole list is read (at most every 2 minutes),
  as what the search matches on is not documented. The list is never made by a reader: no list, no document.
- Besides the order's document, the lookup keeps the order's newest BS list and BS drawings
  (`CloudDocumentLookup.Parts`), so the BS list answers for a position the list lacks and the drawings
  come along, as from the share. They are fetched only when the order has them.
- A row found is kept for 30 s, a miss for 5 s.
- The file comes from `GET /api/MasterDataBlob/Get?path=<reference>` with the bearer token, at most
  50 MB (`MaxPdfBytes`), and is parsed like a file from the share. It is kept in memory by file name and
  `Sha256`, and saved as a copy on this PC under the made-up folder `OptiCloud`, so while OptiCloud can't
  be reached the copy answers ("Gemt kopi"); so do the copies of the BS list and the BS drawings.
- Only what the scan PCs have uploaded can be shown: files printed in the last 60 days, a few minutes
  after 3E wrote them (see Uploading). A scan PC reaches the share and so does not read from OptiCloud.
- The older-order rule at scan-in (`OrderHints.Exists`) needs the folder; a PC reading from OptiCloud
  refuses scans of orders below 58000 as with no folder.

How upload, the temp link and deleting behave is in [`opticloud-scans.md`](opticloud-scans.md), "Files in a list".

## An order's positions on the web (list plus BS list)

The portal does not read one file per order. An order's positions are the newest list's positions
plus the positions of its newest BS list that the list does not have. Order 58931: the list
`58931_20261127.pdf` has positions 1 and 3, `58931_20261127BS.pdf` has position 2, so the order has three.

- The kind of a stored file is read from `raw.order_documents.prefix`: the sync writes `BS` and
  `BS tegninger` there, after any prefix of the order (`BE_BS`).
- The list always wins: a position in both files is the list's. Positions are the same when their number
  and sub-number are ("5" is not "5.1").
- The newest list: newest `print_date`, then `synced_at`, then the file name.
- The newest BS list: the date in its file name (the first `_` followed by exactly eight digits that make a
  date), else the "Dato" in its header (`parsed.header.date`); a BS list with neither comes last. Then
  `synced_at`, then the file name. `print_date` is empty for BS files and is not used.
- An order with a BS list and no list: the BS list is its list (positions, customer, delivery week).
- BS drawings never give positions or a header. Only parsed files count.

Where it is used:

- The read model (`loadOrderInfos` in `apps/web/lib/readmodel/write.ts`): the expected elements, the
  element types and the pairing of a scan with its position (`058931020101` finds position 2).
- The order page (`orderLists` in `apps/web/lib/orders-view/documents.ts`): the element count of an order
  not scanned yet, and the BS positions listed after the list's own, marked "BS". The PDF shown is unchanged.
- Ugeplan and Ordrer, "Alle ordrer": `rpt.order_positions()` behind `rpt.week_plan_documents` and
  `rpt.all_orders_base` (migration `20261127100000_bs_positions.sql`).

The rules live twice and must be changed together: `apps/web/lib/orderdoc/order-lists.ts` and the SQL
helpers of that migration (`rpt.document_kind`, `rpt.bs_list_date`, `rpt.merged_positions`). A test in
`order-lists.test.ts` holds them against each other. The document search (`doc.document_chunks`) still
has one set of chunks per file.

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

## BS drawings

`58931_20261127BS tegninger.pdf`, as found in the one real sample (order 58931, 27-11-2026): the same
landscape page as the list, 839 x 592 pt, real text and vector lines. One page here, for the order's
one BS position.

- A page is headed "Produktions tegning" and `Ordrer nr.: 58931`, then one line: `Position : 2` (bold,
  with a space before the colon), `Elementmål: 890,0 mm * 1655,0 mm` and the scale `1:15`.
- Below it the drawing, at the left of an otherwise empty sheet and far bigger than the list's (1:15
  against 1:50), with what the list's drawing leaves out: every angle (`110°`, `160°`), the heights to
  where the slope starts and its rise (`1493,0`, `162,0`, `1655,0`), the widths to the top point
  (`445,0`, `445,0`, `890,0`) and the sloped lengths (`473,6`).
- No header block, no tables, no position data: the BS list holds those.
- `OrderDocumentParser.DrawingPages(pdf)` gives a `BsDrawingPage` per page: the position on its
  `Position :` line (spaced and cased any way; null when the page names none), the page size, and
  `Content`, the box around everything drawn on the page (14 pt of room), so the screen can show that
  part alone. It never throws; a file that is no PDF gives no pages.
- `BsDrawings.PageFor(position)` is the first page that names the position.
- Not seen yet: a file with several positions (taken to be a page each, as in the list), and an
  old-style `B S tegninger` file. A page that names no position is still shown, see below.

## Barcode and sub-position

The label barcode `058556050103` is order 58556, position 05, sub-position 01, piece 03.

- A new scan with an order below 58000 (`Barcode.OldestOrder`) is refused, as a retail code on a
  box would read as one, unless the folder has a PDF for that order: a remake of an older order is
  still an element (`OrderHints.Exists`, `Barcode.TryParseScan`). With no folder set, or the share
  never listed, an older order is refused.
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
- Lists `[prefix_]<order>_<date>.pdf` in the folder and its subfolders (8 levels) on a background thread, into an
  index kept for 30 s. A miss lists again, at most every 3 s. One listing runs at a time.
- A listing slower than 10 s answers from the last index if it has the order, else `FolderUnavailable`
  ("Mappen svarer ikke"); the listing goes on and fills the index for the next scan.
- A listing that fails or hangs keeps the last good index and its time, and the share counts as down
  (`IsDown`) for 45 s (`DownFor`): lookups answer from the last index at once, without asking the share,
  then it is tried again. A listing that gets through ends it at once.
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
- "Vis BS-tegning", beside "Vis hele PDF" (and above the pages of the list), shows the order's BS
  drawings in the same page viewer, at the page that names the element's position
  (`OrderDocumentLoad.BsDrawingsPage`). It is there when a page names the position; with no such page,
  when the element comes from the BS list or the drawings name no position at all (then from page 1).
  An ordinary position of an order whose drawings are about other positions does not get the button.
- A drawings page shows only the part that is drawn on, fitted to the screen, so the whole drawing and
  its measurements are seen at once. A tap on it makes it as wide as the screen, to read from further
  off; another tap fits it again. "Tilbage til elementet" leaves it.
- The newest drawings file wins (date in the name, then write time). One that can't be read gives no
  button and never fails the document. With the share gone, its copy answers like the list's.
- States: feature off, folder unavailable, order not found (with "Prøv igen"), position not in the PDF
  (the whole PDF with a warning), and a warning when the parser reported problems.
- Closes with "Luk", Esc, or after 3 minutes untouched. Scans go on while it is open; their answers show
  as a strip at the bottom, and the document follows its station to a new element.
- `OrderDocuments` finds and parses in the background (read timeout 15 s) and keeps the last 24 parsed
  files by path, write time and size. A scan-in pre-fetches the document and renders the drawing, so the
  tap is instant. Rendered bitmaps are cached too (`PdfRender`).

## When the share is gone

The share is reached over the internet, so it can be gone for a few minutes. Then a copy answers
(`OrderDocumentLoad.FromCopy`): the parsed document still in memory, else the copy on this PC
(`OrderDocumentCache`, in the app's data folder). When the share answers, the share wins.

- Every PDF read from the share is saved as a copy, named `c<hash of its folder>_<file name>`, so files of
  the same name in two subfolders keep a copy each. It is written to disk before it is renamed into place.
- A copy shown again (even from memory) is touched, so it stays. A copy not saved or touched for 7 days
  goes, and only the newest 200 are kept.
- A file read that hangs (15 s), or fails while the folder can't be reached, marks the share down: the
  next scans go straight to the copy instead of each waiting, until the locator tries the share again
  (45 s, or sooner when the slow read gets through). The last index is kept. Only a file that fails while
  the folder is there (moved or deleted) drops the index, so the next scan lists the folder again.
- The copy is the version the index points to if there is one, else the newest by the date in the name.
  When it is another file than the one the folder last listed, it is marked `OlderVersion`, and the status
  line says "Gemt kopi – ældre udgave" instead of "Gemt kopi". `Path` is the file actually read.
- No copy: "Mappen med ordredokumenter kan ikke læses".

A picture without tapping, with its own data folder so it never meets the running app:

```
$env:VENTISOL_STATION_DATA = "$env:TEMP\vs-snap"
VentisolStation.exe --snapshot-document <folder> 058721010101 out.png [--pages] [--bs] [--zoom] [--size 1920x1080]
```

`--pages` shows "Vis hele PDF", `--bs` "Vis BS-tegning", and `--zoom` with `--bs` the drawing after a tap.
