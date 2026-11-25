# Plan: pallet labels (feature #3)

A plan, not built yet. Written 2026-11-25 from Ventisol's feedback of the same day, and updated with
the answers from Morten's visit. It sits beside `plan-scan-commands.md` (feature #1: command barcodes,
barcode classes, "Arbejdsform") and `plan-packing-checklist.md` (feature #2: the packing station).

**Pallets are built at the packing station** (Ventisol, 2026-11-25). So the floor flow, what each
scan and card does at packing and the screen, lives in feature #2 (`plan-packing-checklist.md` §2).
This file owns what that flow stands on: the pallet id `VS-PL-<number>`, the pallet data in OptiCloud
(`VentisolPalletEvents`) and its replay (`PalletBook`), printing the pallet sheet, and the portal's
pallet views.

Feature #1 steps 2 to 4 must land first: the barcode classification (`ScanCodes.Classify`, which gives
`PalletCode`) and the command words. This plan writes no `VentisolScans` rows; the check-out row at
packing is #2's. The command words are listed with their owners in `plan-scan-commands.md` §3.1.

Each judgment call is marked **Decided** with one line of why. Questions still open are in §9.

## 1. What Ventisol asked for

- Windows are put on pallets. Nothing connects a window to its pallet.
- Today each pallet gets a paper with the order's barcode (the 3E "Palle label", `context/IMG_4723.jpg`:
  order, addresses, then one row per element with Pos., size, Antal and the element barcode).
  An order can be spread over several pallets, so nobody can tell which part of the order is on
  the pallet in front of them.
- The flow they want: put the windows on a pallet, scan every window, scan a "print" barcode.
  A printer then prints a paper with each window's barcode and a pallet id with its own barcode.
  Everything on the pallet is tied to that one id.

## 2. Where pallets are built

At the packing station, in Arbejdsform `Pakning` (#2). The scan that checks a piece out of production
also puts it on the station's open pallet. `VS-PRINT` prints the sheet and closes the pallet; the next
piece opens a new one. `VS-UNDO`, `VS-CLEAR`, `VS-REPRINT` and reopening a printed pallet by its label
are #2's too (#2 §2.3, §8). There is no pallet station, no pallet Arbejdsform and no extra scanner.

What this file gives that flow:

- a new pallet id on the PC the moment the first piece goes on (§3),
- the pallet events and the rules that turn them into "what is on which pallet" (§4),
- the printer and the sheet (§5),
- the read and write API `PackingStation` uses (§8).

## 3. The pallet id

`VS-PL-` followed by 10 digits: `yyMMdd` + PC digit + 3-digit counter.
`VS-PL-2611251007` is the 7th pallet made on PC 1 on 25 November 2026.
People read it as `261125-1-007` (on the screen, the sheet, the portal and in the chat).

**Decided: date + PC digit + daily counter, made on the PC.** Why: a pallet must get its id and print
with no network, and OptiCloud has no sequence to ask; the date keeps the number short and says
when the pallet was made.

- The PC digit is a setting, "Palle-PC nr." (1 to 9, default 1), in Opsætning. Only a PC in Scan
  mode with a `Pakning` station makes pallets; today that is the central PC alone.
- The counter is kept in `pallet-counter.json` in the data folder (`{ "date": "2026-11-25", "last": 7 }`),
  written atomically (`AtomicFile`) before the id is used. On start, and before the first pallet of a
  day, the highest counter for today and this PC digit is also taken from the pallet events read
  from OptiCloud and the journal, so a lost data folder can't give an id twice.
- The date is the PC's local date. A clock set back to a day that already has pallets continues
  that day's counter (the events have them), so ids stay unique.
- More than 999 pallets on one PC in one day is refused (`Dagens palle-numre er brugt op`). Not
  expected: dozens a day.
- Two PCs set to the same PC digit would clash. Opsætning says so under the field
  ("Skal være forskellig på hver PC med en pakkestation"); the portal flags an id printed from two
  `Device`s (§7).
- Code 128 with a switch to code set C for the digits keeps the barcode short (about 45 mm at 0.5 mm module).

`ScanCodes.Classify` (feature #1) returns a `PalletCode` for `VS-PL-` + exactly 10 digits.
`PalletId.TryParse` (§6) reads it. Anything else starting `VS-PL-` is an `UnknownCode`:
`Ukendt pallelabel`. The same tolerance as feature #1's §3.2 applies: trimmed, upper-cased, and `+`
read as `-` (a cradle in keyboard mode on a Danish layout), so `VS+PL+2611251007` and
`vs-pl-2611251007` are the same pallet.

## 4. Data in OptiCloud

**Decided: one append-only master-data table of pallet events, `VentisolPalletEvents`.** Why: it
works exactly like `VentisolScans` (made on the PC, outbox, re-send recognised by a unique id, no
`UpdateRow`, which needs the row id and is not safe to repeat offline), and the contents of a
pallet at any moment is a replay. A second table of pallet header rows would need updates and
could disagree with the events.

Name `VentisolPalletEvents`, friendly name "Ventisol paller". Made by the station app with its
columns on first connect, like `VentisolScans` (`ScanTable.EnsureAsync`).

| Column | Type (`dataType`) | What |
|---|---|---|
| `EventId` | String (0), key, unique | uuid made on the PC |
| `PalletId` | String (0) | `2611251007` (the 10 digits, no prefix) |
| `Kind` | String (0) | `Add`, `Remove`, `Clear` or `Print` |
| `Barcode` | String (0) | element, on `Add` and `Remove`; empty otherwise |
| `OrderNo` | Int (2) | from the barcode, on `Add` and `Remove` |
| `Position` | Int (2) | " |
| `SubPosition` | Int (2) | " |
| `Piece` | Int (2) | " |
| `FromPallet` | String (0) | on an `Add` that moved the window: the pallet it left |
| `Elements` | Int (2) | on `Print`: windows on the pallet |
| `Orders` | String (0) | on `Print`: the orders on it, `58556,58560`, so a keyword search on an order finds the pallet |
| `Reprint` | Bool (4) | on `Print`: true when nothing changed since the last print |
| `EventTime` | DateTime (3) | when it happened on the PC, UTC, ISO 8601 |
| `Station` | String (0) | the packing station's name, `Pakning` |
| `StationNo` | Int (2) | the packing station's number, `7` |
| `Device` | String (0) | Windows machine name |

Which floor action writes which event is #2's table (#2 §5). In short: a piece scanned is an `Add`
(next to its `CheckedOut` row), `VS-UNDO` a `Remove`, a move one `Add` with `FromPallet`, `VS-CLEAR` a
`Clear`, `VS-PRINT` and `VS-REPRINT` a `Print`.

The rules of the replay (`PalletBook`, and the portal's derive):

- **One pallet per window.** A window is on the pallet of its latest `Add`, unless a later `Remove`
  or `Clear` of that pallet took it off. Why: a window is physically in one place; the latest scan
  is the truth. A move needs no `Remove` on the old pallet: one event, one truth.
- **One open pallet per station.** It is the pallet with events at that station after its last
  `Print` or `Clear`. Open pallets survive a restart (journal) and the night.
- **Mixed orders allowed** (Ventisol, 2026-11-25). The sheet and the portal show each order.
- **Pallet events are not scans for time.** They hold no In or Out and no machine order. The time a
  piece leaves production is its `CheckedOut` row (#2), not its `Add`.
- `VS-REPRINT` and a reopened `VS-PRINT` with no change write a `Print` event with `Reprint` = true,
  so the count of prints is known.
- `ChangedSincePrint`: a printed pallet with an `Add` or `Remove` after its last `Print` (a piece moved
  off it, for one). Its paper is out of date.

Volume and reading:

- Maybe 30 to 80 pallets and 300 to 1000 events a day. Same order as the scans.
- Read with `GetRowsPaged` ordered by `EventTime`, newest first, the last 14 days (pallets wait
  for shipping for days). Same paging rules and caps as the scans (`opticloud-scans.md`, Reading).
- Lookups on the station by pallet or order use the replayed 14 days in memory; `keyword` search
  (`PalletId`, or an order in `Orders`) is only a fallback for an older pallet, once the backend owner
  confirms what `keyword` searches (§9).

## 5. Printing

### Hardware

The printer is not known yet. Two likely kinds:

| | Office printer, A4, through Windows | Zebra label printer (ZPL), e.g. ZD421 / ZT231, 4 x 6 inch |
|---|---|---|
| Cost | Likely already there | About 4,000 to 8,000 DKK |
| Sheet | Room for 14 windows a page | About 6 windows a label; more labels for a big pallet |
| On a pallet | Paper in a plastic sleeve, as today | Sticky label, survives better outside |
| Our work | WPF print, no extra package | ZPL text sent raw; the printer draws the barcodes |

**Decided: build the Windows printer first, behind `IPalletPrinter`, with a ZPL printer as the second
implementation.** Why: any printer Windows has a driver for works on day one, and the paper looks
like today's 3E "Palle label", which people know. ZPL is a second class, not a rewrite. Which one
Ventisol uses waits on the choice of printer (§9); nothing else in the plan does.

- The packing station's printer is chosen in Opsætning from the Windows print queues
  (`LocalPrintServer`), with a kind: `Windows` or `Zebra (ZPL)`, and copies (1 or 2). "Prøveudskrift"
  prints a test sheet.
- A ZPL printer is reached through its Windows queue as a RAW job (`winspool` `OpenPrinter` /
  `StartDocPrinter` with datatype `RAW` / `WritePrinter`), or straight on TCP port 9100 when given
  an address. Why the queue first: the same picker, and Windows holds the job if the printer is off.
- Before a job the queue status is checked (`PrintQueue.IsOffline`, `IsInError`, `IsOutOfPaper`,
  `IsPaperJammed`). The `Print` event is written once Windows has taken the job. Spooled is not printed:
  a jam after that is fixed with `VS-REPRINT`.
- Printing needs no OptiCloud: the id is made on the PC, the sheet's data is on the PC. Customer,
  delivery address, delivery week and sizes come from the order's 3E PDF already parsed on the PC
  (`OrderDocumentParser`, from the documents folder or the OptiCloud copy). Missing PDF: those
  fields are left out, never guessed.

### The sheet (A4 portrait)

```
+----------------------------------------------------------------------+
| PALLE 261125-1-007                                  Ventisol  Side 1/1 |
|                                                                      |
|  ||| |||| || ||| | |||| ||| || ||||| || |||   (big: 0.5 mm, 25 mm)   |
|  VS-PL-2611251007                                                    |
|                                                                      |
|  9 vinduer · 2 ordrer · printet 25-11-2026 10:42 · Pakning           |
+----------------------------------------------------------------------+
| Ordre 58556   Davidsen Midt A/S, Skive            Lev. uge 46        |
|   Lev. adr.: Davidsen Skive - Leif, Brogårdsvej 30, 8370 Hadsten     |
|   7 af 16 vinduer på denne palle · resten: palle 261125-1-004        |
|                                                                      |
|   Pos. 4    stk. 1    970 * 2140    ||||||||||||||||||  058556040101 |
|   Pos. 5    stk. 1   1183 * 1539    ||||||||||||||||||  058556050101 |
|   Pos. 5    stk. 2   1183 * 1539    ||||||||||||||||||  058556050102 |
|   ...                                                                |
+----------------------------------------------------------------------+
| Ordre 58560   Byg & Bo ApS                        Lev. uge 47        |
|   2 af 2 vinduer på denne palle                                      |
|   Pos. 1    stk. 1    600 * 800     ||||||||||||||||||  058560010101 |
|   Pos. 1    stk. 2    600 * 800     ||||||||||||||||||  058560010102 |
+----------------------------------------------------------------------+
```

- The pallet barcode is big and on top, so a scan to reopen the pallet hits it, not a window row. Each
  window row has its own element barcode (0.33 mm module, 12 mm high), as on today's paper.
- Rows sorted by order, position, sub-position, piece. Size is `Mål u/kobling` of the position
  (`OrderPosition.SizeWithoutCoupling`); the position label is `Barcode.PositionLabel`.
- "7 af 16": the order's element count is the sum of `Antal` over its positions in the 3E PDF.
  "resten: palle …" lists the order's other pallets this PC knows of. Left out when unknown. This is
  the line that answers Ventisol's question: what part of the order is on this pallet.
- About 14 window rows fit a page. Page 2 on repeats the pallet header and barcode (smaller) and says `Side 2/3`.
- The ZPL label is the same, cut down: pallet id and barcode, orders with delivery week, then rows
  of position, size and a small barcode; 6 rows a label, `Label 1/2`.

If our sheet replaces the 3E "Palle label" (open, §9, leaning yes): the 3E label is no longer printed,
so our sheet is the only paper on the pallet. Then the delivery address and customer must be on it for
every order (they are, from the 3E PDF), a missing PDF becomes a warning on the screen at `VS-PRINT`
(`Ingen produktionsliste for ordre 58830 · arket mangler adresse`), and the default copies may become 2
(one for the pallet, one for the driver). If it does not replace it, nothing changes: both are printed,
ours lists what is on the pallet.

### Barcode rendering

**Decided: ZXing.Net (Apache-2.0) for the Code 128 encoding only; the bars are drawn as WPF
rectangles.** Why: a maintained, permissively licensed encoder; vector bars stay sharp at any printer
resolution, where a scaled bitmap blurs the narrow bars.

- `ZXing.Net` (`ZXing.OneD.Code128Writer`, package `ZXing.Net`) gives the module pattern as a
  `BitMatrix` one row high. No `ZXing.Net.Bindings.*` package is needed. In tests it also decodes the
  rendered sheet, so a broken barcode fails the build.
- Quiet zone 10 modules each side. Text under each barcode, as today.
- Not used: QuestPDF (its community licence is only free below 1 million USD revenue), Aspose and
  Spire (commercial). If a PDF of the sheet is wanted later (the portal), PDFsharp (MIT) can draw the
  same layout; not part of this plan.
- ZPL: the printer draws the barcodes itself (`^BC`), no library.

## 6. Station app changes

Feature #1 steps 2 to 4 land first: `ScanCodes.Classify` (`ElementCode | CommandCode | PalletCode |
UnknownCode`) and the `VS-` command words (`ScanCommand` with `Undo`, `Print`, `Reprint`, `Clear`).
The state machine that uses them at packing is #2's `PackingStation`; this plan gives it the pieces
below.

### Ventisol.Station.Core

- `Pallets/PalletId.cs`: `record PalletId(DateOnly Day, int Pc, int Counter)`; `TryParse(scan)` for
  `VS-PL-` + 10 digits, also the bare 10 digits stored in the table; `BarcodeText` (`VS-PL-2611251007`),
  `Display` (`261125-1-007`), `Stored` (`2611251007`).
- `Pallets/PalletIdAllocator.cs`: next id from the counter file and the highest id seen in events
  (pure, with a clock and a store interface); refuses past 999.
- `Pallets/PalletEvent.cs`: like `ScanEvent`: `Columns`, `ToValues`, `TryFromValues`, `PalletEventKind`
  `{ Add, Remove, Clear, Print }`.
- `Pallets/PalletBook.cs`: the replay of §4. Takes events (each `EventId` once, in `EventTime` order).
  The API is in §8.
- `Pallets/PalletSheet.cs`: the sheet model from the book, the order hints and the parsed 3E headers:
  groups per order, rows, "N af M", other pallets, pages of 14 rows. Pure.
- `Pallets/ZplSheet.cs`: ZPL text from a `PalletSheet`. Pure.
- `Cloud/Outbox.cs`: made generic, `Outbox<T>` with a small codec (`Id`, to JSON, from JSON). The scan
  outbox keeps its folder and file format; the pallet outbox lives in `pallet-outbox\`.
- `Cloud/ScanTable.cs`: the table code (ensure, add, exists, read since) pulled into `EventTable<T>`;
  `ScanTable` and `PalletTable` are thin uses of it.
- `Cloud/ScanJournal.cs`: the same generalisation; pallet journal in `pallet-journal\`, kept 14 days.
- `Cloud/CloudSync.cs`: a second outbox loop for pallet events (its own backoff, so a stuck pallet event
  never holds a scan back); pallet events read in the same 5 s poll (short window) and every 12th poll
  the 14 days; new event `PalletsLoaded`. `Record(PalletEvent)`.
- `StationSettings`: `PalletPc` (1 to 9, default 1). `StationSetup`: `PrinterName`, `PrinterKind`
  (`Windows`, `Zpl`), `PrinterAddress` (optional, for TCP 9100), `Copies` (1 or 2).
  `StationSettingsJson` reads old files with these empty.
- `SetupRules.Hints`: a `Pakning` station with no printer gets `Pakkestationen mangler en printer`.
  A hint, not a problem: packing works without it, only `VS-PRINT` is refused (#2 §2.4). At most one
  `Pakning` station per PC makes pallets (one counter per PC digit); a second is a problem.

### Ventisol.Station (WPF)

- `Printing/IPalletPrinter.cs`: `Task<PrintOutcome> PrintAsync(PalletSheet sheet, int copies, CancellationToken ct)`.
- `Printing/WindowsPalletPrinter.cs`: builds a `FixedDocument` on an STA thread, checks the
  `PrintQueue` status, sends it with `XpsDocumentWriter` to the queue by name, with no dialog.
- `Printing/ZplPalletPrinter.cs`: RAW job to the queue (P/Invoke `winspool.drv`), or TCP 9100.
- `Printing/PreviewPalletPrinter.cs`: shows the sheet in a window, for `DemoScanner` (no paper during a
  demo).
- `Printing/PalletSheetView.cs`: draws one page (header, barcode rectangles, rows) from the model.
- `Printing/BarcodeVisual.cs`: Code 128 modules to a `DrawingVisual` of rectangles.
- `ViewModels/MainViewModel.cs`: one `PalletBook` per app; raises `PalletRecorded` (events to store) and
  `PrintRequested` from #2's `PackingOutcome`.
- `MainWindow.xaml(.cs)`: `PalletRecorded` to `CloudSync.Record`; `PrintRequested` to the printer, then
  the `Print` event or the error flash; `PalletsLoaded` rebuilds the book (journal first, then
  OptiCloud, as for scans).
- `SetupView.xaml` / `SetupViewModel.cs`: for a `Pakning` station, "Printer" (queue picker), "Type"
  (Windows / Zebra), "Kopier", "Prøveudskrift"; "Palle-PC nr." in the PC section.
- `Ventisol.Station.Core.csproj`: `ZXing.Net` package; lock files updated (`dotnet restore`).

## 7. Web portal and read model

- **Sync:** `lib/sync/pallets.ts`, the same stop rule as the scan sync, into `raw.pallet_events`
  (a 1:1 mirror, service only, no grant). Nightly reconcile covers it too (45 days).
- **Derive:** `lib/derive/pallets.ts`, pure, the same replay as `PalletBook` with shared test vectors
  in `docs/pallet-rules-vectors.json` (run by both the .NET tests and vitest, like `scan-rules-vectors.json`).
  Writes:
  - `core.pallets`: `pallet_id`, `display`, `opened_at`, `last_printed_at`, `print_count`, `status`
    (`open`, `printed`, `changed_since_print`, `cleared`), `station_no`, `device`, `element_count`,
    `orders int[]`, `id_clash` (printed from two devices).
  - `core.pallet_elements`: `pallet_id`, `barcode`, `order_no`, `position`, `sub_position`, `piece`,
    `added_at`; only windows on the pallet now. Plus `core.pallet_moves` for the history of a window.
- **rpt functions** (security invoker, as the others): `rpt.order_pallets(order_no)` (pallets with counts
  and which positions, plus the order's windows on no pallet), `rpt.pallet(pallet_id)` (what is on it,
  history), `rpt.element_location(barcode)`.
- **Pages:**
  - Order page: a "Paller" section: one row per pallet (`261125-1-007 · 7 af 16 · printet 10:42`), the
    positions on it, and "Ikke på palle endnu: Pos. 6 stk. 1, 2". Clicking a pallet opens it. A window
    back in production (rework `In` after its check-out, #2 §4) is marked `Tilbage i produktion`.
  - Ordrer list: a column "Paller" (`2 · 14 af 16`).
  - `/palle/[id]`: contents grouped by order, its prints, its moves; flags `Ændret efter print`.
  - Search box on Ordrer takes a pallet id (`261125-1-007`, `2611251007` or `VS-PL-…`).
  - "Er nu ved": an element checked out and on a pallet shows `På palle 261125-1-007`.
- **Chat tools** (`lib/tools`): `order_pallets(order_no)` answers "where is order X / which pallets hold
  order X"; `pallet_contents(pallet_id)` answers "what is on pallet Y". `find_order` also accepts a
  pallet id and returns its orders. Same rpt functions, so the chat equals the page.

## 8. What packing (feature #2) uses

All in `Ventisol.Station.Core`, on the same central PC as the packing station, so it works offline:

```csharp
public sealed class PalletBook
{
    public IReadOnlyList<PalletElement> Contents(PalletId id);         // windows on it now, in Add order
    public PalletId? PalletOf(string barcode);                          // the pallet a window is on, or null
    public IReadOnlyList<PalletSummary> PalletsFor(int order);         // id, count, printed, changed
    public PalletSummary? Find(PalletId id);                           // null: not known on this PC
    public PalletId? OpenAt(int stationNo);                             // the station's open pallet
    public PalletId? LastPrintedAt(int stationNo);                      // for VS-REPRINT
    public event EventHandler? Changed;                                 // after a local event or a load
}
public sealed record PalletElement(Barcode Barcode, DateTimeOffset AddedAt);
public sealed record PalletSummary(PalletId Id, int Elements, IReadOnlyList<int> Orders,
    DateTimeOffset? LastPrinted, bool ChangedSincePrint, bool Open);
```

- `PackingStation` (#2 §6) gets the book and a `PalletIdAllocator` from `MainViewModel` (one each per
  app). It decides what to write; this plan stores, replays and prints it.
- `Contents` in `Add` order gives #2 its undo order, also for a reopened pallet.
- `PalletOf` tells #2 a piece is already on another pallet (a move).
- Other PCs read the same book from the 14 days of OptiCloud events; the portal from `core.pallet_elements`.

## 9. Open questions

Decided with Ventisol on 2026-11-25 (no longer open): pallets are built at packing (no extra scanner,
no pallet station); pallets may hold several orders.

For Ventisol (Kim, the packing operators):

1. Which printer: an office A4 printer near packing, or should we buy a Zebra label printer? Is a
   paper in a sleeve fine, or do they want a sticky label? `IPalletPrinter` lets either come later; the
   Windows printer is built first.
2. Does our sheet replace the old 3E "Palle label"? Morten thinks yes but is not sure; we lean yes.
   What changes if it does is in §5 (after the sheet).
3. How many windows on a big pallet (to size the sheet and the 60 limit)?
4. Should a pallet that goes out to the customer be marked shipped (a `VS-SHIPPED` scan at loading)?
   Not in this plan. The word is listed as proposed in `plan-scan-commands.md` §3.1 and reads as
   Unknown until defined.

For the backend owner (OptiPeople API):

5. Is a second master-data table at this volume fine (a few hundred to a thousand rows a day)?
6. What `keyword` searches on in `GetRowsPaged` (all string columns? exact or contains?), so a pallet or
   an order older than 14 days can be found without reading every page.
7. The same as for scans: whether `Orderby` on `EventTime` is honoured, and a date filter.

## 10. Build steps

Each step is one commit with its tests, in this order. Steps 1 to 9 need nothing from Ventisol but the
printer for step 8's site test, and can be built before or alongside #2's steps 1 to 10. #2 step 11
then puts them on the floor (the combined flow at packing). The portal steps 10 to 12 can follow any
time after step 5.

1. **Pallet rules vectors.** `docs/pallet-rules-vectors.json`: add, remove, move, clear, print,
   reopen, reprint, two stations. The rules of §4 written down first.
2. **`PalletId` and allocator.** Parse, format, counter file, highest-seen, clock set back, 999 limit. Tests.
3. **`PalletEvent` and `PalletBook`.** Columns, values both ways, replay, `OpenAt`, `LastPrintedAt`,
   `ChangedSincePrint`; runs the vectors. Tests.
4. **Generic outbox, journal and table.** `Outbox<T>`, journal and `EventTable<T>`; the scan tests stay
   green unchanged; new tests for the pallet codec and table against FakeOptiCloud.
5. **`CloudSync` pallet loop and read.** Second outbox loop, poll, `PalletsLoaded`; FakeOptiCloud takes
   the new table. Tests: offline then online, a refused event, re-send recognised by `EventId`.
6. **`PalletSheet` and `ZplSheet`.** Grouping, sort, "N af M", other pallets, pages, missing 3E data.
   Golden-text tests for the ZPL.
7. **Settings and Opsætning.** `PalletPc`, printer fields on the `Pakning` station, `SetupRules` hint
   and problem, old settings files still read. Tests for the rules and the JSON.
8. **Windows printer.** `BarcodeVisual`, `PalletSheetView`, `WindowsPalletPrinter`,
   `PreviewPalletPrinter`, "Prøveudskrift", `PalletRecorded` and `PrintRequested` wiring in
   `MainWindow`. Test: render a page to a bitmap at 300 dpi and decode every barcode with ZXing.Net.
9. **Docs.** `opticloud-scans.md` gets a short "Pallet events" pointer, `apps/station/README.md` the
   printer setup; this file becomes the description of what was built.
10. **Portal sync and derive.** `raw.pallet_events`, `core.pallets`, `core.pallet_elements`, the vectors
    in vitest. Migration test on PGlite.
11. **Portal pages and rpt functions.** Order page section, Ordrer column, `/palle/[id]`, search.
    Fixture data.
12. **Chat tools.** `order_pallets`, `pallet_contents`, `find_order` by pallet; evals for "hvor er ordre
    X", "hvilke paller har ordre X", "hvad er der på palle Y".
13. **ZPL printer.** RAW job and TCP 9100, once a Zebra is chosen. Test against a local TCP listener
    that captures the bytes.

## 11. Test plan

- **Unit (.NET):** steps 2 to 8 above; every rule of §4 has a test; the pallet vectors run in both
  .NET and vitest and must agree. The floor cases are tested in #2 (`PackingStationTests`).
- **Barcodes:** every barcode on a rendered A4 page and in the ZPL golden text decodes to what was meant
  (ZXing.Net). The pallet barcode is not taken for an element by `Barcode.TryParseScan`, and an element
  label is not taken for a pallet.
- **Offline:** FakeOptiCloud stopped: build and print three pallets at packing, restart the app with
  one open, start FakeOptiCloud: every event arrives once, the open pallet is still open, ids are unique.
- **Two PCs:** a Scan PC and a viewer on FakeOptiCloud: the viewer's packing widget shows the open
  pallet within a poll or two.
- **Printer on site:** with the real printer: a 1-window, a 14-window and a 30-window pallet; the LI3678-SR
  reads the pallet barcode from 1 m and every window barcode on the sheet, through a plastic sleeve.
  Printer off, out of paper: the screen says so and the pallet stays open; `VS-PRINT` after fixing works.
- **On the floor (one shift with Ventisol, together with #2's):** build real pallets at packing, move
  one window, undo one, reprint one; then check in the portal that order X shows its pallets and pallet
  Y its windows, and ask the chat both.
