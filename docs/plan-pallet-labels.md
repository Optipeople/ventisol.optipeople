# Plan: pallet labels (feature #3)

A plan, not built yet. Written 2026-11-25 from Ventisol's feedback of the same day. It sits beside
`plan-scan-commands.md` (feature #1: command barcodes, barcode classes, "Arbejdsform") and
`plan-packing-checklist.md` (feature #2: the packing checklist). This file owns `VS-PRINT`, the
other pallet commands, the pallet id `VS-PL-<number>`, Arbejdsform `Palle`, the pallet data in
OptiCloud and the read API packing uses.

Feature #1 steps 2 to 4 must land first: the barcode classification (`ScanCodes.Classify`), the
Arbejdsform setting (`StationWorkMode`) and the rows (`Event`, `Direction = Mark`). This plan writes
no `VentisolScans` rows of its own, but it routes scans through the classification and the setting.
The command words are listed with their owners in `plan-scan-commands.md` §3.1.

Each judgment call is marked **Decided** with one line of why. Questions still open are in §10.

## 1. What Ventisol asked for

- Between the glass line and packing, windows are put on pallets. Nothing connects a window to its pallet.
- Today each pallet gets a paper with the order's barcode (the 3E "Palle label", `context/IMG_4723.jpg`:
  order, addresses, then one row per element with Pos., size, Antal and the element barcode).
  An order can be spread over several pallets, so nobody can tell which part of the order is on
  the pallet in front of them.
- The flow they want: put the windows on a pallet, scan every window, scan a "print" barcode.
  A printer then prints a paper with each window's barcode and a pallet id with its own barcode.
  Everything on the pallet is tied to that one id.
- Later (feature #2): packing scans the pallet label and ticks off every window on it at once.

## 2. How it works on the floor

**Decided: a station of its own with Arbejdsform `Palle`, with its own scanner at the pallet area.**
Why: one Arbejdsform per station (feature #1), and the glass line and Pakning scanners are busy with
their own work; a mode switch on a shared scanner would be forgotten and mix up time and pallets.

The scanner is an extra LI3678-SR cradle on the central PC's USB hub (station 8, see §7 and §10).
Until it is bought, any one of the 7 stations can be set to `Palle` in Opsætning.

**Decided: building a pallet needs no "start" barcode. The first window scanned opens a new pallet.**
Why: one scan less per pallet, and an operator can't forget it.

Step by step at the Palle station (tile texts in Danish):

1. Idle. The tile says `Scan første vindue til en ny palle`.
2. The operator scans a window label. A new pallet id is made on the PC at once (no network needed).
   Flash (green): `Lagt på palle 261125-1-007` / `Ordre 58556 · Pos. 5 · stk. 3`.
   The tile now shows the open pallet (see the sketch below).
3. Each next window: `Lagt på palle 261125-1-007 – 4 vinduer`.
4. A window scanned again while it is on the open pallet comes off it (the same toggle as In/Out
   elsewhere): amber flash `Taget af palle` / `Ordre 58556 · Pos. 5 · stk. 3 · nu 3 vinduer`.
5. A window whose label can't be reached any more (stacked behind others): scan the `VS-UNDO` card.
   The window added last comes off: `Fortrudt: ordre 58556 · Pos. 5 · stk. 3`.
6. A window already on another pallet moves to this one:
   amber flash `Flyttet fra palle 261125-1-004` / `Palle 261125-1-004 skal printes igen`.
7. Done: scan the `VS-PRINT` card. The sheet prints and the pallet closes.
   Flash: `Udskriver palle 261125-1-007` / `9 vinduer · 2 ordrer`. Then back to step 1.
8. Printer fails: red flash `Printeren svarer ikke` / `Pallen er gemt – scan VS-PRINT igen`.
   The pallet stays open; nothing is lost.

Other things the operator can do:

- **Add to a pallet already printed:** with no pallet open, scan its pallet label (`VS-PL-…`).
  `Palle 261125-1-004 åbnet igen – 6 vinduer`. Scan more windows, then `VS-PRINT` prints a new
  sheet with the same id. The old sheet is thrown away.
- **Reprint:** scan the pallet label, then `VS-PRINT` straight away: the same sheet again.
  Label gone or torn: `VS-REPRINT` prints the last pallet printed at this station again.
- **Throw the open pallet away:** `VS-CLEAR`, then `VS-CLEAR` again within 10 s.
  First: `Scan VS-CLEAR igen for at tømme palle 261125-1-007`. Then: `Palle 261125-1-007 tømt`.
  The windows on it are on no pallet afterwards.

The tile while a pallet is open (same grid tile as a station; "Max i gang" rows are not used):

```
+----------------------------------------------+
| Palle-station                      ● scanner |
|                                              |
|  PALLE 261125-1-007          åben 0 t 12 min |
|  9 vinduer · 2 ordrer                        |
|                                              |
|  58556   Pos. 5 stk. 3   1183 * 1539   ← sidst|
|  58556   Pos. 5 stk. 2   1183 * 1539         |
|  58556   Pos. 4 stk. 1    970 * 2140         |
|  58560   Pos. 1 stk. 1    600 * 800          |
|  … 5 mere                                    |
|                                              |
|  Scan VS-PRINT for at udskrive               |
+----------------------------------------------+
```

The newest five rows show, newest first. The line under the count lists the orders when there are
two or more (`Ordre 58556 (7) · 58560 (2)`), so a mixed pallet is plain to see. A pallet open
longer than "Marker efter (timer)" gets an amber `åben over 4 t`, as a forgotten element does.

## 3. Barcodes and pallet ids

### Command cards

Code 128, letters, printed once and laminated at the station (feature #1 prints the sheet of cards).

| Barcode | What it does at a `Palle` station |
|---|---|
| `VS-PRINT` | Print the open pallet and close it. With a pallet just reopened and not changed: reprint it. |
| `VS-UNDO` | Take the window added last off the open pallet. Again: the one before, and so on. |
| `VS-CLEAR` | Scanned twice within 10 s: empty and drop the open pallet. |
| `VS-REPRINT` | Print the last pallet printed at this station again. |

`VS-UNDO` is the same card as at Pakning (feature #2), where it cancels the next scanned check-out;
its meaning depends on the station's Arbejdsform. At an Enkel or Session station all four are
refused, and at a Pakning station `VS-PRINT`, `VS-REPRINT` and `VS-CLEAR` are, with feature #1's
shared message `Kortet bruges ikke her` (`plan-scan-commands.md` §3.1). `VS-START`, `VS-PAUSE` and
`VS-HOLD` at a Palle station are refused the same way: a pallet has no session.

### The pallet id

`VS-PL-` followed by 10 digits: `yyMMdd` + PC digit + 3-digit counter.
`VS-PL-2611251007` is the 7th pallet made on PC 1 on 25 November 2026.
People read it as `261125-1-007` (on the tile, the sheet, the portal and in the chat).

**Decided: date + PC digit + daily counter, made on the PC.** Why: a pallet must get its id and print
with no network, and OptiCloud has no sequence to ask; the date keeps the number short and says
when the pallet was made.

- The PC digit is a setting, "Palle-PC nr." (1 to 9, default 1), in Opsætning. Only a PC in Scan
  mode with a `Palle` station makes pallets; today that is the central PC alone.
- The counter is kept in `pallet-counter.json` in the data folder (`{ "date": "2026-11-25", "last": 7 }`),
  written atomically (`AtomicFile`) before the id is used. On start, and before the first pallet of a
  day, the highest counter for today and this PC digit is also taken from the pallet events read
  from OptiCloud and the journal, so a lost data folder can't give an id twice.
- The date is the PC's local date. A clock set back to a day that already has pallets continues
  that day's counter (the events have them), so ids stay unique.
- More than 999 pallets on one PC in one day is refused (`Dagens palle-numre er brugt op`). Not
  expected: dozens a day.
- Two PCs set to the same PC digit would clash. Opsætning says so under the field
  ("Skal være forskellig på hver PC med en palle-station"); the portal flags an id printed from two
  `Device`s (§8).
- Code 128 with a switch to code set C for the digits keeps the barcode short (about 45 mm at 0.5 mm module).

`ScanCodes.Classify` (feature #1) returns a `PalletCode` for `VS-PL-` + exactly 10 digits.
`PalletId.TryParse` (§7) reads it. Anything else starting `VS-PL-` is an `UnknownCode`:
`Ukendt pallelabel`. The same tolerance as feature #1's §3.2 applies: trimmed, upper-cased, and `+`
read as `-` (a cradle in keyboard mode on a Danish layout), so `VS+PL+2611251007` and
`vs-pl-2611251007` are the same pallet.

## 4. State and rules

Pallet state is a replay of pallet events (§5), like station state is a replay of scans.

- **One pallet per window.** A window is on the pallet of its latest `Add`, unless a later `Remove`
  or `Clear` of that pallet took it off. Why: a window is physically in one place; the latest scan
  is the truth.
- **One open pallet per Palle station.** It is the pallet with events at that station after its last
  `Print` or `Clear`. Open pallets survive a restart (journal) and the night.
- **Mixed orders allowed.** Why: small orders and remakes share a pallet today; refusing would only
  make operators scan around the system. The tile and the sheet show each order (§2, §6). Ventisol
  may want a warning instead (§10).
- **Pallet assignment is not a scan for time.** It writes no `VentisolScans` row and no machine order.
  Why: putting a window on a pallet is not work on the element at a station; an In/Out pair would add
  time, change "last station" and break pairing. The pallet events carry their own time, so the
  portal can still show "on pallet since 10:42".
- **Any element label is taken**, by `Barcode.TryParseScan` like any new scan, whatever station it
  was last seen at. Why: the pallet must match reality even when a scan was missed upstream.
- A window in progress at another station is not scanned out by being put on a pallet. That station
  keeps its own rules (a missed scan-out shows there as it does today).

Edge cases:

| Case | What happens | Screen |
|---|---|---|
| Window scanned, no pallet open | New pallet, window on it | `Lagt på palle …` |
| Window scanned again, on the open pallet | Off the pallet (`Remove`) | `Taget af palle` (amber) |
| Same label read twice within 2 s | Ignored (`RepeatScans`, as today) | nothing |
| Window on a printed pallet, scanned onto the open one | Moves (`Add` with `FromPallet`) | `Flyttet fra palle X` / `Palle X skal printes igen` |
| Window on another station's open pallet | Moves too; that pallet's tile drops it | `Flyttet fra palle X` |
| `VS-UNDO`, nothing added since open | Refused | `Intet at fortryde` |
| `VS-UNDO` after a move | Off this pallet; it does not go back to the old one | `Fortrudt: … – nu på ingen palle` |
| `VS-PRINT`, no pallet open | Refused | `Ingen palle åben – scan vinduerne først` |
| `VS-PRINT`, open pallet empty (all taken off) | Refused | `Pallen er tom` |
| `VS-PRINT`, printer error or no printer set | Pallet stays open, no `Print` event | `Printeren svarer ikke` / `Ingen printer valgt i Opsætning` (red) |
| `VS-CLEAR` once | Asks | `Scan VS-CLEAR igen for at tømme palle X` |
| `VS-CLEAR` twice in 10 s | `Clear` event, pallet gone | `Palle X tømt` |
| Pallet label scanned, no pallet open | That pallet reopens | `Palle X åbnet igen – N vinduer` |
| Pallet label scanned, open pallet has windows | Refused | `Print eller tøm palle Y først` |
| Pallet label of the open pallet | Nothing | `Det er den åbne palle` |
| Pallet label never seen (other PC, before sync) | Opens it empty; old windows show once the events arrive | `Palle X åbnet – ukendt indhold` |
| Pallet label at an Enkel/Session station | Refused, nothing stored (feature #1's shared rule) | `Kortet bruges ikke her` |
| `VS-START`, `VS-PAUSE` or `VS-HOLD` | Refused, nothing stored (feature #1's shared rule) | `Kortet bruges ikke her` |
| `VS-PL-` with other than 10 digits | Refused | `Ukendt pallelabel` |
| Unknown barcode | As today | `Ukendt stregkode` |
| Order with no 3E PDF | Taken; the sheet has no size or customer | normal |
| Over 60 windows on one pallet | Refused; a typo-loop guard, not a real limit | `Maks 60 vinduer på en palle` |
| Restart with a pallet open | Restored from the journal before any network | the tile as before |
| Viewer | Shows open pallets read from OptiCloud; takes no scans | read-only tile |

`VS-REPRINT` and a reopened `VS-PRINT` with no change write a `Print` event with `Reprint` = true,
so the count of prints is known.

## 5. Data in OptiCloud

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
| `Station` | String (0) | `Palle` |
| `StationNo` | Int (2) | `8` |
| `Device` | String (0) | Windows machine name |

- `Remove` is written for a `VS-UNDO` too. A move is one `Add` with `FromPallet` (the old pallet
  loses the window by the one-pallet rule); no `Remove` on the old pallet. Why: one event, one truth.
- Volume: maybe 30 to 80 pallets and 300 to 1000 events a day. Same order as the scans.
- Read with `GetRowsPaged` ordered by `EventTime`, newest first, the last 14 days (pallets wait
  for shipping for days). Same paging rules and caps as the scans (`opticloud-scans.md`, Reading).
- Lookups on the station by pallet or order use the replayed 14 days in memory; `keyword` search
  (`PalletId`, or an order in `Orders`) is only a fallback for an older pallet, once the backend owner
  confirms what `keyword` searches (§10).

## 6. Printing

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
like today's 3E "Palle label", which people know. ZPL is a second class, not a rewrite.

- The station's printer is chosen in Opsætning from the Windows print queues (`LocalPrintServer`),
  with a kind: `Windows` or `Zebra (ZPL)`, and copies (1 or 2). "Prøveudskrift" prints a test sheet.
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
|  9 vinduer · 2 ordrer · printet 25-11-2026 10:42 · Palle-station     |
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

- The pallet barcode is big and on top, so packing hits it, not a window row. Each window row has
  its own element barcode (0.33 mm module, 12 mm high), as on today's paper, so packing can also tick
  one window off by hand.
- Rows sorted by order, position, sub-position, piece. Size is `Mål u/kobling` of the position
  (`OrderPosition.SizeWithoutCoupling`); the position label is `Barcode.PositionLabel`.
- "7 af 16": the order's element count is the sum of `Antal` over its positions in the 3E PDF.
  "resten: palle …" lists the order's other pallets this PC knows of. Left out when unknown. This is
  the line that answers Ventisol's question: what part of the order is on this pallet.
- About 14 window rows fit a page. Page 2 on repeats the pallet header and barcode (smaller) and says `Side 2/3`.
- The ZPL label is the same, cut down: pallet id and barcode, orders with delivery week, then rows
  of position, size and a small barcode; 6 rows a label, `Label 1/2`.

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

## 7. Station app changes

Feature #1 steps 2 to 4 land first: `ScanCodes.Classify` (`ElementCode | CommandCode | PalletCode |
UnknownCode`), the `VS-` command words (`ScanCommand` with `Undo`, `Print`, `Reprint`, `Clear`), and
the Arbejdsform (`StationWorkMode` with `Palle`, `StationConfig.WorkMode`, `StationSetup.WorkMode`,
`FileStation.WorkMode`). This plan only adds to them; it adds `Palle` to the Opsætning drop-down
(feature #1 offers only `Enkel` and `Session`).

### Ventisol.Station.Core

- `Pallets/PalletId.cs`: `record PalletId(DateOnly Day, int Pc, int Counter)`; `TryParse(scan)` for
  `VS-PL-` + 10 digits, also the bare 10 digits stored in the table; `BarcodeText` (`VS-PL-2611251007`),
  `Display` (`261125-1-007`), `Stored` (`2611251007`).
- `Pallets/PalletIdAllocator.cs`: next id from the counter file and the highest id seen in events
  (pure, with a clock and a store interface); refuses past 999.
- `Pallets/PalletEvent.cs`: like `ScanEvent`: `Columns`, `ToValues`, `TryFromValues`, `PalletEventKind`
  `{ Add, Remove, Clear, Print }`.
- `Pallets/PalletBook.cs`: the replay. Takes events (each `EventId` once, in `EventTime` order) and
  answers `Contents(id)`, `PalletOf(barcode)`, `PalletsFor(order)`, `OpenAt(stationNo)`,
  `LastPrintedAt(stationNo)`, `ChangedSincePrint(id)`. The read API for packing (§9).
- `Pallets/PalletStation.cs`: the state machine of a `Palle` station, like `StationState`.
  `Handle(Barcode element)`, `Handle(ScanCommand)`, `Handle(PalletId)` return a `PalletResult` (kind,
  pallet, element, the events to record, and `PrintRequest` when a sheet is due). Holds the
  `VS-CLEAR` confirm window (10 s) and the undo stack. Pure, no I/O.
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
- `SetupRules.Problems`: a `Palle` station needs a printer (`Palle-stationen mangler en printer`); at
  most one `Palle` station per PC (one open pallet per station is fine, but two give two counters to
  keep apart; not needed now).
- `StationConfig.Defaults`: station 8 `Palle` (Arbejdsform `Palle`), added only when Opsætning says
  so ("Tilføj palle-station"), so the 7-tile layout of today does not change on update. Station 8 is
  outside the "1 to 7" of `StationConfig` and `opticloud-scans.md` (`StationNo`); it is only written to
  `VentisolPalletEvents`, never to `VentisolScans`. The docs step updates the range to 1 to 8.

### Ventisol.Station (WPF)

- `Printing/IPalletPrinter.cs`: `Task<PrintOutcome> PrintAsync(PalletSheet sheet, int copies, CancellationToken ct)`.
- `Printing/WindowsPalletPrinter.cs`: builds a `FixedDocument` on an STA thread, checks the
  `PrintQueue` status, sends it with `XpsDocumentWriter` to the queue by name, with no dialog.
- `Printing/ZplPalletPrinter.cs`: RAW job to the queue (P/Invoke `winspool.drv`), or TCP 9100.
- `Printing/PalletSheetView.cs`: draws one page (header, barcode rectangles, rows) from the model.
- `Printing/BarcodeVisual.cs`: Code 128 modules to a `DrawingVisual` of rectangles.
- `ViewModels/PalletStationViewModel.cs`: the tile while in Palle mode: `PalletText`, `CountText`,
  `OrdersText`, `Rows` (newest five), `OpenText`, the hint line, flash texts as in §2. Same
  `FlashKind` colours (`In` green, `Rejected` amber, a new `Error` red for the printer).
- `ViewModels/MainViewModel.cs`: `Scan` classifies with `ScanCodes.Classify`, then routes by
  Arbejdsform: `Palle` to the station's `PalletStation`; raises `PalletRecorded` (events to store) and `PrintRequested`.
- `MainWindow.xaml(.cs)`: the Palle tile template; `PalletRecorded` to `CloudSync.Record`;
  `PrintRequested` to the printer, then the `Print` event or the error flash; `PalletsLoaded`
  rebuilds the book (journal first, then OptiCloud, as for scans).
- `SetupView.xaml` / `SetupViewModel.cs`: for a `Palle` station, "Printer" (queue picker), "Type"
  (Windows / Zebra), "Kopier", "Prøveudskrift"; "Palle-PC nr." in the PC section; "Tilføj palle-station".
- `DemoScanner`: key 8 scans a window onto the pallet; Shift+8 sends `VS-PRINT` to a print preview
  window instead of a printer (no paper during a demo).
- `Ventisol.Station.Core.csproj`: `ZXing.Net` package; lock files updated (`dotnet restore`).

## 8. Web portal and read model

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
    positions on it, and "Ikke på palle endnu: Pos. 6 stk. 1, 2". Clicking a pallet opens it.
  - Ordrer list: a column "Paller" (`2 · 14 af 16`).
  - `/palle/[id]`: contents grouped by order, its prints, its moves; flags `Ændret efter print`.
  - Search box on Ordrer takes a pallet id (`261125-1-007`, `2611251007` or `VS-PL-…`).
  - "Er nu ved": an element whose latest event is a pallet `Add` after its last station Out shows
    `På palle 261125-1-007`.
- **Chat tools** (`lib/tools`): `order_pallets(order_no)` answers "where is order X / which pallets hold
  order X"; `pallet_contents(pallet_id)` answers "what is on pallet Y". `find_order` also accepts a
  pallet id and returns its orders. Same rpt functions, so the chat equals the page.

## 9. What packing (feature #2) can read

All in `Ventisol.Station.Core`, on the same central PC as the Palle station, so it works offline the
moment a pallet is printed:

```csharp
public sealed class PalletBook
{
    public IReadOnlyList<PalletElement> Contents(PalletId id);         // windows on it now
    public PalletId? PalletOf(string barcode);                          // the pallet a window is on, or null
    public IReadOnlyList<PalletSummary> PalletsFor(int order);         // id, count, printed, changed
    public PalletSummary? Find(PalletId id);                           // null: not known on this PC
    public event EventHandler? Changed;                                 // after a local event or a load
}
public sealed record PalletElement(Barcode Barcode, DateTimeOffset AddedAt);
public sealed record PalletSummary(PalletId Id, int Elements, IReadOnlyList<int> Orders,
    DateTimeOffset? LastPrinted, bool ChangedSincePrint, bool Open);
```

- Packing gets the book from `MainViewModel` (one instance per app). A pallet label at a `Pakning`
  station: `Find`, then tick off `Contents`. An unknown pallet (made on another PC and not synced yet):
  feature #2 shows `Pallen er ikke kendt endnu`.
- An open pallet (not printed) is still readable; feature #2 decides whether to warn
  (`Pallen er ikke printet`). `ChangedSincePrint` lets it warn that the paper is out of date.
- Packing writes nothing to the pallet table. Ticking off is feature #2's data.
- Other PCs read the same book from the 14 days of OptiCloud events; the portal from `core.pallet_elements`.

## 10. Open questions

For Ventisol (Kim, the packing and glass line operators):

1. Where are pallets built, and is one more scanner (an 8th LI3678-SR with cradle) all right there,
   or should an existing station's scanner move to Palle?
2. Which printer: an office A4 printer near the pallets, or should we buy a Zebra label printer?
   Is a paper in a sleeve fine, or do they want a sticky label?
3. May one pallet hold several orders? Allowed in this plan, with every order shown; should it warn?
4. Should the old 3E "Palle label" still be printed, or does our sheet replace it?
5. How many windows on a big pallet (to size the sheet and the 60 limit)?
6. Should a pallet that goes out to the customer be marked shipped (a `VS-SHIPPED` scan at loading)? Not in this plan.
   The word is listed as proposed in `plan-scan-commands.md` §3.1 and reads as Unknown until defined.
7. Until the 8th scanner is bought, one of the 7 stations runs `Palle`. Which one gives up its own work
   for that time, or do pallets wait for the scanner?

For the backend owner (OptiPeople API):

8. Is a second master-data table at this volume fine (a few hundred to a thousand rows a day)?
9. What `keyword` searches on in `GetRowsPaged` (all string columns? exact or contains?), so a pallet or
   an order older than 14 days can be found without reading every page.
10. The same as for scans: whether `Orderby` on `EventTime` is honoured, and a date filter.

## 11. Build steps

Each step is one commit with its tests, in this order. Steps 1 to 7 need nothing from Ventisol.

1. **Pallet rules vectors.** `docs/pallet-rules-vectors.json`: add, remove, move, undo, clear, print,
   reopen, reprint, two stations. The rules of §4 written down first.
2. **`PalletId` and allocator.** Parse, format, counter file, highest-seen, clock set back, 999 limit. Tests.
3. **`PalletEvent` and `PalletBook`.** Columns, values both ways, replay; runs the vectors. Tests.
4. **`PalletStation`.** The state machine, every row of the §4 table, the 10 s clear confirm, the undo stack. Tests.
5. **Generic outbox, journal and table.** `Outbox<T>`, journal and `EventTable<T>`; the scan tests stay
   green unchanged; new tests for the pallet codec and table against FakeOptiCloud.
6. **`CloudSync` pallet loop and read.** Second outbox loop, poll, `PalletsLoaded`; FakeOptiCloud takes
   the new table. Tests: offline then online, a refused event, re-send recognised by `EventId`.
7. **`PalletSheet` and `ZplSheet`.** Grouping, sort, "N af M", other pallets, pages, missing 3E data.
   Golden-text tests for the ZPL.
8. **Settings and Opsætning.** `PalletPc`, printer fields, `Palle` in the Arbejdsform drop-down, "Tilføj
   palle-station", `SetupRules` problems, old settings files still read. Tests for the rules and the JSON.
9. **Windows printer.** `BarcodeVisual`, `PalletSheetView`, `WindowsPalletPrinter`, "Prøveudskrift".
   Test: render a page to a bitmap at 300 dpi and decode every barcode with ZXing.Net.
10. **The Palle tile.** `PalletStationViewModel`, routing in `MainViewModel.Scan`, flashes, print and its
    error, demo keys. View model tests for each message in §2.
11. **Viewer.** Read-only Palle tile from OptiCloud events. Test with two app instances on FakeOptiCloud.
12. **ZPL printer.** RAW job and TCP 9100. Test against a local TCP listener that captures the bytes.
13. **Docs.** `opticloud-scans.md` gets a short "Pallet events" pointer and the station range 1 to 8,
    `apps/station/README.md` the Palle setup; this file becomes the description of what was built.
14. **Portal sync and derive.** `raw.pallet_events`, `core.pallets`, `core.pallet_elements`, the vectors in vitest. Migration test on PGlite.
15. **Portal pages and rpt functions.** Order page section, Ordrer column, `/palle/[id]`, search. Fixture data.
16. **Chat tools.** `order_pallets`, `pallet_contents`, `find_order` by pallet; evals for "hvor er ordre X",
    "hvilke paller har ordre X", "hvad er der på palle Y".

## 12. Test plan

- **Unit (.NET):** steps 2 to 7 above; every row of the §4 table has a test; the pallet vectors run in
  both .NET and vitest and must agree.
- **Barcodes:** every barcode on a rendered A4 page and in the ZPL golden text decodes to what was meant
  (ZXing.Net). The pallet barcode is not taken for an element by `Barcode.TryParseScan`, and an element
  label is not taken for a pallet.
- **Offline:** FakeOptiCloud stopped: build and print three pallets, restart the app with one open,
  start FakeOptiCloud: every event arrives once, the open pallet is still open, ids are unique.
- **Two PCs:** a Scan PC and a viewer on FakeOptiCloud: the viewer shows the open pallet within a
  poll or two and refuses scans.
- **Printer on site:** with the real printer: a 1-window, a 14-window and a 30-window pallet; the LI3678-SR
  reads the pallet barcode from 1 m and every window barcode on the sheet, through a plastic sleeve.
  Printer off, out of paper: the tile says so and the pallet stays open; `VS-PRINT` after fixing works.
- **On the floor (one shift with Ventisol):** build real pallets, move one window, undo one, reprint one;
  then check in the portal that order X shows its pallets and pallet Y its windows, and ask the chat both.
- **Packing (with feature #2):** a pallet label at Pakning ticks off exactly the windows on that pallet,
  also with OptiCloud offline.
