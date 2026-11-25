# Plan: the packing checklist (Pakning)

Feature #2 from Ventisol's feedback of 2026-11-25. A plan to build from, no code yet. It sits beside
`plan-scan-commands.md` (feature #1: command barcodes and the "Arbejdsform" setting) and
`plan-pallet-labels.md` (feature #3: pallets). This doc owns the behaviour of Arbejdsform `Pakning`.

Feature #1 steps 2 to 4 must land first: the barcode classification (`ScanCodes.Classify`), the
Arbejdsform setting (`StationWorkMode`) and the rows (the `Event` column, `ScanEventKind`,
`Direction = Mark`). Feature #1 owns those; this doc only adds the `Event` values `CheckedOut` and
`Undo` and the command `VS-UNDO`'s meaning at Pakning.

Written 2026-11-25.

## 1. What Ventisol asked for

> The packing station needs its own view. Once an order is scanned, all positions in the order show
> up in a list. The operator then scans each position, and every time one is scanned it lights up and
> is "checked out" of production. A final checklist: "Yes, we have this window on this pallet now, it's
> ready for transport, so it's out of production and the final time ends here."

What that means for us:

- One scan per piece at packing, not an In and an Out.
- The station shows the whole order, not just the piece scanned, so the operator sees what is missing.
- The last check-out of an order is the end of its lead time. Today the docs say no order can be called
  packed from the scans alone (`opticloud-scans.md`, Rules, last line). The checklist is the signal that
  was missing.

## 2. How it works on the floor

The packing station (station 7, "Pakning", kind `Packing`) is set to Arbejdsform `Pakning` in
Opsætning. Its scanner then feeds the checklist, not the in/out toggle.

Step by step:

1. Nothing open. The widget says **"Scan et element for at åbne pakkelisten"**.
2. The operator scans a window of order 58830 (Pos. 2, piece 1). The station:
   - opens the checklist for 58830 from the order's 3E production list (section 3),
   - checks that piece out at once (judgment: every scan at packing is a window in front of the
     operator; asking for a second scan of the same label would only confuse),
   - says **"Ordre 58830 åbnet · Pos. 2 stk. 1 tjekket ud"**, lights the piece, plays the OK sound.
3. Each next scan of the same order lights one more piece: **"Pos. 3 stk. 1 tjekket ud"**. The counter
   at the top goes **"2 af 18"**, **"3 af 18"** ...
4. The last expected piece: the whole widget turns green, **"Ordre 58830 er færdig · 18 af 18 tjekket
   ud · Klar til transport"**, and the complete sound plays. The list stays on screen until the next
   scan, or 2 minutes, then goes back to step 1.
5. A scan of another order while 58830 is half done: the station switches to the new order's list and
   says **"Skiftet til ordre 58831 · Ordre 58830 mangler 6"** (amber, 5 s). 58830 stays open. It shows
   in the strip of open orders, and its list comes back, ticks and all, on the next scan of any of its
   pieces.

What else the operator can see:

| Situation | Screen (Danish) | Sound |
|---|---|---|
| Piece checked | `Pos. 3 stk. 2 tjekket ud` | OK |
| Order complete | `Ordre 58830 er færdig · 18 af 18 tjekket ud · Klar til transport` | Complete |
| Already checked | `Pos. 3 stk. 2 er allerede tjekket ud kl. 10:42` | Warning |
| Not on the list | `Pos. 7 stk. 1 er ikke på produktionslisten · tjekket ud alligevel` | Warning |
| No list for the order | `Ingen produktionsliste for ordre 58830 · viser kun de scannede` | Warning (first scan only) |
| List still loading | `Henter produktionslisten ...` (the tick is kept and shown when it arrives) | OK |
| Piece was still in progress at an assembly station | `Pos. 3 stk. 2 var stadig i gang på Station 30 · stoppet dér` | Warning |
| Unreadable or not an element | `Ikke en elementkode` (as today) | Warning |
| Pallet label, before feature #3 | `Palle-scanning ved pakning er ikke klar endnu` | Warning |
| A card Pakning does not use (`VS-START`, `VS-PAUSE`, `VS-HOLD`, `VS-PRINT`, `VS-REPRINT`, `VS-CLEAR`) | `Kortet bruges ikke her` (feature #1's shared message, §3.1), nothing stored | Warning |
| An unknown `VS-` card | `Ukendt kort` (feature #1) | Warning |

Sketch of the widget (about 6 x 4 cells of the 12 x 6 grid; it scales like `DocumentWidgetView`):

```
+----------------------------------------------------------------------+
| PAKNING                                    Ordre 58830     12 af 18  |
| Jensen Byg ApS · Lev. uge 48                                         |
|----------------------------------------------------------------------|
| ## Pos. 1  Drej Kip    1485 x 1380   [1][2][3]              3 af 3   |
| .. Pos. 2  Fast karm    980 x 1200   [1][ ][ ][ ]           1 af 4   |
| ## Pos. 3  Terrassedør 1890 x 2180   [1]                    1 af 1   |
| .. Pos. 4  Bundhængt    600 x  600   [ ][ ][ ][ ][ ][ ]     0 af 6   |
|    ... 2 positioner mere                                            |
| !! Pos. 7  Ikke på listen            [1]                    ekstra   |
|----------------------------------------------------------------------|
| Pos. 2 stk. 1 tjekket ud                                      10:42  |
| Åbne ordrer: 58831  3 af 9   ·   58790  7 af 8                       |
+----------------------------------------------------------------------+
  ## = row lit (all its pieces checked)   .. = not done   !! = extra (amber)
  [n] = piece n lit   [ ] = piece not checked yet
```

UI rules:

- One row per position, a chip per piece. Ventisol positions hold 1 to 50 pieces; a row per piece
  would not fit (judgment: positions are what the office and the PDF talk about).
- Rows are 48 px or more and the counter is 72 px, for reading from a few metres. The last row touched
  flashes once and is scrolled into view. Done rows move nothing: the order stays the PDF's order, so the
  operator learns where to look.
- Colours mean state, as in the rest of the app: green lit, neutral not done, amber extra or warning,
  red outline for a piece that went back to production after it was checked (section 4).
- The station's own tile, when it is on screen, shows the short form: `Ordre 58830 · 12 af 18`.

## 3. Where the list of pieces comes from

**Choice: the order's 3E production list PDF, parsed on the station (`OrderDocuments.LoadAsync`,
`OrderDocumentParser`).** Each `OrderPosition` gives `Number`, `SubNumber` and `Quantity` (Antal). The
expected pieces are pieces 1 to Antal of every position, with sub-position 01 (or `SubNumber + 1` if 3E
ever prints "5.1", the rule in `order-documents.md`, Barcode and sub-position).

Why this one:

- The station already reads it, from the share or from the copy in OptiCloud (`CloudDocumentSource`),
  with a local copy when both are gone. Viewers can read it too.
- The web read model uses the same list for "packed" (`ExpectedElement.quantity` in
  `apps/web/lib/derive/types.ts`, from `lib/orderdoc`), so the station and the portal count the same
  pieces.
- It exists for every order from the day it is printed, before the first scan.

The others, and why not:

| Source | Why not (now) |
|---|---|
| The ugeplan / `rpt.week_plan_documents` in Supabase | Built from the same PDFs, one step further away; the station does not talk to Supabase (OptiCloud is the source of truth). |
| The 3E Access export ("Uge 48.MDB") | Dropped by hand on a web page, per week, not on the station. Could later correct the PDF's count. |
| The Schirmer XML files | Profiles and batches, not delivered elements; not read by the station. |
| OptiPeople orders (`api/optipeople-orders.md`) | Holds one order per element barcode, set by the station itself. It has no list of an order's pieces. |
| The scans | Only what has been seen. Used as the fallback below, never as the expected list. |

When the list is missing or wrong:

- **No PDF** (not printed, older than 60 days on a PC reading from OptiCloud, share down with no copy):
  the list is the pieces of the order seen in any scan (section 5, Reading), marked
  `Uden produktionsliste`. The counter reads **"5 tjekket ud · listen kendes ikke"** and the order is
  never shown as complete on the station. Judgment: we can't claim complete without knowing the count;
  the portal's 12-hour quiet rule (`packedQuietSeconds`) still closes it there.
- **Antal unreadable** for a position (`Quantity` null, `Problems` not empty): that position shows the
  pieces seen, with `Antal ukendt`, and the order can't be complete on the station.
- **Piece not on the list** (position not in the PDF, or piece above Antal): it is still checked out
  and recorded. It shows as an amber extra row and does not count in "12 af 18". Judgment: the floor is
  never blocked by a wrong list; the read model already lets such an element not block packed
  (`in_document = false`).
- **A newer print** of the PDF: the locator takes the newest, and the list is rebuilt when it changes
  (`OrderDocumentLoad.FileKey`). Ticks are kept by barcode; pieces that drop off the list become extras.

## 4. State and rules

A checklist belongs to an order. The station keeps any number open; one is shown (the active one), the
rest are in the strip. Judgment: a pallet can hold several orders and an operator can switch back and
forth, but one big list at a time is what can be read from a distance.

- **Active order**: the order of the last element scanned at the station.
- **Open**: an order with at least one check-out and not complete. It stays open across days and
  restarts until it is complete, or 14 days after its last check-out (then only the portal lists it).
- **Complete**: every expected piece is checked out and none of them went back to production. Extras
  don't count. Without a list, never complete on the station.
- A piece is **checked out** by its latest `CheckedOut` row at a packing station, unless a later scan
  undoes it: an `Undo` row (section 5) or an `In` at an assembly station (rework).

Edge cases:

| Case | What happens | Why |
|---|---|---|
| Piece scanned twice within 2 s | Ignored (`RepeatScans`, as today) | Scanner double read |
| Piece already checked, scanned again | No row written. `... er allerede tjekket ud kl. 10:42`, warning sound | A toggle at packing would undo work by accident. Undo is a deliberate act (`VS-UNDO`). |
| Piece not on the list | Recorded, amber extra row | Never block the floor; the portal flags it |
| Piece of another order | Switch the active order, the old one stays open | Half-done orders are normal (a pallet goes, the rest follows) |
| Order left half done | Stays open, in the strip and on the portal's list; its next scan brings the list back | Ventisol: "it stays open, shows on next scan" |
| Piece still in progress at an assembly station | That station gets an `Out` at the check time (as a stop from its tile), then the check-out | An open `In` elsewhere would keep the order "on a station" and not packed in the read model |
| Piece in progress at packing itself (an `In` from Enkel mode, before the switch) | The check-out is its `Out`, with `DurationSec` since that `In` | Pairs as today |
| Checked piece comes back for rework (scanned `In` at Station 30) | The chip turns red outlined, `Tilbage i produktion (Station 30)`; the order is open again; checking it again later moves the end time | Packed is derived, not latched (`read-model.md` §4) |
| Remake with the same label | Treated as the same piece: if it was checked out and went back, it is checked again | Same barcode, same element |
| Remake of an older order (below 58000) | Accepted when its PDF is in the folder (`OrderHints.Exists`), as today | Existing rule |
| Wrong piece checked by mistake | `VS-UNDO`, then scan the piece: `Pos. 3 stk. 2 er ikke længere tjekket ud` | Needs a deliberate command; see section 5 |
| List arrives after the scan (slow share) | The tick is kept; the list is drawn when it arrives | Never wait on the network to record |
| Offline | Check-outs go to the outbox and journal as every scan does; the screen never waits | Existing outbox |
| Pallet label at packing | Before feature #3: refused with a message, nothing stored. After: section 8 | |
| `VS-START`, `VS-PAUSE`, `VS-HOLD`, or #3's `VS-PRINT`, `VS-REPRINT`, `VS-CLEAR` | Refused, nothing stored, `Kortet bruges ikke her` | A Pakning station has no session and no open pallet; feature #1's shared rule (§3.1). The tile shows no `PAUSE` band or `Session` label |

**In time versus pieces scanned twice.** At packing in Pakning mode a scan is a moment, not a span. A
check-out row carries `DurationSec = 0` (or the seconds since its open `In` at packing, if there was
one). A second scan of a checked piece writes nothing, so a piece is never counted twice and no packing
time is invented. The order's time ends at its last check-out.

## 5. Data in OptiCloud

**Choice: a check-out is the existing `Out` row at the packing station, with feature #1's column
`Event` = `CheckedOut`.**

| Column | Value on a check-out |
|---|---|
| `Direction` | `Out` |
| `StationKind` | `Packing` |
| `DurationSec` | `0`, or seconds since the piece's open `In` at packing |
| `Event` | `CheckedOut` |

Why not a new `Direction` value: every reader today drops a row whose direction is not `In` or `Out`
(`ScanEvent.TryFromValues`, `lib/sync/scans.ts`). An `Out` with `DurationSec = 0` pairs in every
version already out there as a finished pass of zero length at packing. So the read model's packed
rule ("every expected element has a finished pass at a packing station") and `packed_at` work without a
change, and older station versions on viewers don't break.

The `Event` column, `ScanEventKind` and `Direction = Mark` come from feature #1
(`plan-scan-commands.md` §6, its build step 4). This doc adds two values to `ScanEventKind`
(`Scan, Pause, Resume, Hold, CheckedOut, Undo`), listed in #1 §6.1:

- `CheckedOut`: the piece is on the pallet and out of production. `Direction = Out`.
- `Undo`: cancels the latest `CheckedOut` of the same barcode at the same station. `Direction = Mark`.

A reader that does not know a value reads it as `Scan` (#1 §7.4).

**Undo** (`VS-UNDO`, see section 9): one row with `Direction = Mark`, `Event = Undo`, at the packing
station, at the time of the undo, `DurationSec` left out. A new reader drops it together with the
`CheckedOut` it cancels. `Mark` is a row that carries no time and never pairs (#1 §6), so an old reader
never starts a pass from it: an old station app skips it (unknown direction), and the portal before
#1's raw-scans step stores it with direction null and drops it. Such a reader still counts the
cancelled check-out as a finished pass at packing until it has the new version. Harmless. Judgment:
OptiCloud rows are never edited or deleted by the station (the table is a log, and re-sends rely on
`ScanId`).

**Reading an order's history.** The 36-hour window the station reads is too short: an order is often
assembled days before it is packed. New: `ScanTable.ReadOrderAsync(order)`, `GetRowsPaged` with
`keyword=<order>` and the rows kept whose `OrderNo` is that order, the same way `ExistsAsync` finds a
`ScanId`. If the keyword finds nothing it falls back to the 36-hour window plus the local store. Read
when a checklist is opened or comes back, and every minute while it is active. Open question for the
backend owner: a real column filter.

**Local store.** `packing.json` in the data folder (written with `AtomicFile`): per open order, the
checked pieces (barcode, time, `ScanId`), the time of the last check-out, and the active order. It
restores the widget at once after a restart, before any network, as the journal does for the stations.
OptiCloud wins when both are known (by `ScanId`).

## 6. Station app changes

Core (`Ventisol.Station.Core`), all pure and tested:

- `Cloud/ScanEvent.cs`: feature #1 gives `ScanEventKind`, the `Event` property and column,
  `ScanDirection.Mark`, `ToValues` (leaves out `Scan`) and `TryFromValues` (unknown reads as `Scan`).
  This doc adds `CheckedOut` and `Undo` to `ScanEventKind`. No new `ScanKind`: a check-out is a
  `ScanResult` of kind `Out` with `Event = CheckedOut`, an undo one of kind `Mark` (#1) with
  `Event = Undo`. `ScanEvent.From` already copies `Event` and maps `Mark` (#1 §7.4).
- `StationState.cs`: unchanged by this doc; a Pakning station does not use it.
- `Cloud/ScanReplay.cs`: a `Mark` row with `Event = Undo` removes the latest `CheckedOut` of its
  barcode and station before it, and is itself dropped. It is told from #1's `Mark` / `Hold` (which
  closes a pause) by `Event`. `WorkRecord` (in `DayReport.cs`) gets `bool IsCheckout`. `DayReport`
  leaves check-outs out of the average time per station, and counts them in elements and in "Ordrer
  ved pakning".
- `Cloud/ScanTable.cs`: `ReadOrderAsync(int order)` as in section 5.
- New folder `Packing/`:
  - `PackingList.cs`: `PackingList` (order, header lines, `IReadOnlyList<PackingPosition>`, `Source`
    `Document | Scans`, `Complete` known or not). `PackingPosition` (number, sub-position, label text
    from `System`, first field's `Opening` and `SizeWithoutCoupling`, `Quantity` or null).
    `PackingList.FromDocument(OrderDocument)` and `PackingList.FromScans(int order, IEnumerable<ScanEvent>)`.
  - `PackingChecklist.cs`: one order's state. `Apply(IEnumerable<ScanEvent>)` rebuilds it from the
    history (check-outs, undos, assembly `In`s after a check-out). `Check(Barcode, DateTimeOffset)`
    gives a `PackingResult`: `Checked`, `AlreadyChecked(at)`, `Extra`, with `Count`, `Expected`,
    `Completed`. `Undo(Barcode, ...)` gives `Undone` or `NotChecked`. `SetList(PackingList)` keeps the
    ticks by barcode.
  - `PackingStation.cs`: the station's open checklists and the active one. `Scan(Barcode, now)` picks
    or opens the checklist, switches the active order, and returns what to record and what to say
    (`PackingOutcome`: rows to write, message key, sound). Open orders older than 14 days drop.
  - `PackingStore.cs`: load and save `packing.json`; tolerant of a missing or broken file (starts
    empty and logs).
- `StationSettings.cs` / `StationSettingsJson.cs`: the Arbejdsform comes from feature #1
  (`StationWorkMode { Enkel, Session, Pakning, Palle }`, `StationConfig.WorkMode`,
  `StationSetup.WorkMode`, `FileStation.WorkMode` in `settings.json`). This doc adds
  `PackingSound` (bool, default true) to `StationSettings`.
- `SetupRules.cs`: `Pakning` only on a station of kind `Packing` (the setup shows it greyed otherwise:
  `Kun for en pakkestation`). Judgment: the rows must say `StationKind = Packing` for the read model.
- `SetupView`: this doc adds `Pakning (tjekliste)` to the Arbejdsform drop-down (feature #1 offers only
  `Enkel` and `Session`).

App (`Ventisol.Station`):

- `ViewModels/MainViewModel.cs`, `Scan`: after `ScanCodes.Classify` (feature #1), when the station's
  Arbejdsform is `Pakning`, an `ElementCode` goes to `PackingStation.Scan` instead of the station
  workflow, a `CommandCode` `Undo` arms the undo, a `PalletCode` goes to section 8, and any other
  command is refused with feature #1's shared message. Before the check-out, any other station
  on this PC with that element in progress is stopped through `Stop(...)` with a new
  `StopReason.CheckedOut` (`StationViewModel.cs`). The outcome's rows go out through `Recorded` like
  any scan (outbox, journal). `Hints` and `LastOrderChanged` work as today.
- `ViewModels/PackingViewModel.cs` (new): what the widget binds to: order, customer line, Lev. uge,
  counter text (`12 af 18`, `5 tjekket ud · listen kendes ikke`), rows with chips, the message line
  with its state, the open-orders strip, `IsComplete`. Ticks once a second for the message timeouts and
  the 2-minute return to idle.
- `ViewModels/Widgets.cs`: `WidgetKind.Packing`, `PackingWidget(spec, PackingViewModel)` with
  `Spec.Station` set to the packing station. Catalog entry `("Pakkeliste", WidgetKind.Packing, null, 6, 4)`.
  The picker asks which station, as for the Document widget.
- `PackingWidgetView.xaml` (+ `.xaml.cs`, new): the layout of section 2, with a size rule like
  `DocumentWidgetView.Fit` (small block: order, counter and message only).
- `StationViewModel.cs` / the station tile: in Pakning mode the tile shows `Ordre 58830 · 12 af 18`,
  and no in-progress rows or stop button.
- `MainWindow.xaml.cs`: makes the `PackingViewModel` per Pakning station (like `OrderDocumentViewModel`),
  loads the list in the background on the first scan of an order (`OrderDocuments.LoadAsync`, as
  `PrefetchDocument` does), feeds it OptiCloud's order history, and saves `PackingStore` after each
  check. `SendMachineOrders`: the packing station's machine gets the active order number while it is
  open, and none when it is complete (no per-element order at packing).
- `Sounds.cs` (new): three short WAVs as resources (`Assets/Sounds/ok.wav`, `done.wav`, `warn.wav`),
  played with `System.Media.SoundPlayer` off the UI thread, only on a scan PC and only when
  `PackingSound` is on. The scanner's own beep says "read"; the PC's sound says "accepted". Opsætning
  gets `Lyd ved pakning` (Til / Fra).
- Viewer mode: the widget works the same from what OptiCloud holds. The active order is the order of
  the newest `CheckedOut` row at that station; the open strip is the orders with check-outs in the 36
  hours read. A viewer records nothing and plays no sound. The list comes from `CloudDocumentSource`
  when the viewer has no folder.

Restart: `PackingStore` gives the screen at once, then the journal and outbox, then OptiCloud's order
history for the active order and the open ones (as `ApplyLoaded` does for the stations).

## 7. Web portal / read model changes

- `lib/sync/scans.ts` and the `raw.scans.event` migration come from feature #1 (§8.1, its step 10),
  with `Mark` kept and `event` typed with `CheckedOut` and `Undo`.
- `docs/scan-rules-vectors.json`: feature #1 adds the optional `event` per event. This doc adds cases
  for a check-out (`durationSec` 0, no `In`), an undo (a `Mark` row with `event` `Undo`), and a
  check-out after a rework `In`. Both apps run them.
- `lib/derive/pairing.ts`: a `Mark` row with `event = 'Undo'` drops itself and the `CheckedOut` it
  cancels; it never opens a pass. A pass made from a
  `CheckedOut` row gets `is_checkout = true` (new column on `core.station_intervals`).
- Time per piece (station day facts, `getBaselineSuggestion`, Normaltid, "Mod normalt") leaves
  `is_checkout` passes out. They have no measured length; counting them as 0 would drag the packing
  median down. They still count in "Gennem i dag".
- `core.elements.checked_out_at`: the time of its standing check-out, null if none.
- `core.orders`: `elements_checked_out`, and `packed_source` gets the value `checklist` when every
  expected element is checked out. Packed itself keeps its rule (any finished pass at packing), so
  orders packed before the checklist still count. `packed_at` is unchanged: the last packing `Out`, so
  with the checklist the last check-out. That is the end of lead time Ventisol asked for.
- The route (§5 of `read-model.md`): with check-outs, the span from the order's first check-out to its
  last is **Pakning** work while no element is at an assembly station. Judgment: with one scan per
  piece there is no per-piece packing time, but loading an order's windows is work, and without this
  rule all of it would read as "Venter før pakning".
- `listIncompletePackedOrders` (`rpt.incomplete_packed_orders`): also an order with a check-out whose
  expected pieces are not all checked out after `quietHours`. `missingElements` gets `checkedOut` beside
  `packed`. The Overblik list "Pakket ordre med manglende element" reads it.
- Order page (`app/(detail)/ordre/[orderNo]`): a "Pakkeliste" panel in the same shape as the station
  (positions with piece chips, lit when checked out, the time on hover), and a "Tjekket ud" column in
  the elements table. The "Elementer pakket" tile reads `12 af 18 tjekket ud` when the order has
  check-outs.
- Ugeplan "Klar til afsendt" may read a complete checklist; left as is until Ventisol asks.

## 8. Later: pallet scan at packing

Once feature #3 exists, a pallet label `VS-PL-<number>` scanned at a Pakning station ticks off every
window on that pallet in one go. This depends on `plan-pallet-labels.md` for where a pallet's windows
are stored and how to read them; nothing here stores pallets.

- `ScanCodes.Classify` (feature #1) gives a `PalletCode` for `VS-PL-` + 10 digits (`PalletId.TryParse`).
  Packing reads the pallet through `PalletBook` (doc #3, §9): `Find(id)`, then `Contents(id)`.
  `PackingStation.ScanPallet(PalletId, IReadOnlyList<PalletElement>, now)` runs `Check` for each
  window, in order, and writes one `CheckedOut` row per window (same time, own `ScanId`), so the read
  model needs nothing new. Packing writes nothing to `VentisolPalletEvents`.
- Windows of several orders on one pallet: each order's checklist gets its ticks; the active order is
  the one with the most windows on the pallet.
- Message: `Palle VS-PL-2611251007: 8 vinduer tjekket ud · Ordre 58830 12 af 18`. Already checked and
  extras are counted in the message, not listed.
- `Find` gives null (made on another PC, not synced yet): `Pallen er ikke kendt endnu`, nothing written.
  An empty pallet: `Pallen er tom`.
- An open pallet (not printed) is still ticked off, with the amber line `Pallen er ikke printet`; a
  pallet with `ChangedSincePrint` gets `Papiret på pallen er ikke opdateret`. Judgment: the windows are
  there either way; the warning is about the paper.
- The portal can show which pallet each window left on by joining `core.pallet_elements` (doc #3) on
  the barcode and the check-out time. No pallet column on the scan row.

## 9. Open questions

For Ventisol:

1. Does the first scan of an order also check that window out? We assume yes (section 2).
2. A window packed in two parts ("Karm og ramme pakkes særskilt"): one label or two? We tick per label.
3. Can one pallet hold several orders? The design allows it; we need to know if it is common.
4. An order that leaves short (a part delivery): should the operator be able to close it as sent
   incomplete? Not in this plan. It would need a command such as `VS-CLOSE` (flagged, not defined;
   listed as proposed in `plan-scan-commands.md` §3.1, Unknown until defined).
5. Do they want `VS-UNDO` (undo the next scanned check-out)? We plan it as the last station step.
   It is the same card as the Palle station's `VS-UNDO` (feature #3), listed in `plan-scan-commands.md`
   §3.1; at Pakning it cancels the next scanned check-out. It needs a printed card at packing.
6. Does the central PC have speakers, and can the packing operator hear them? Else sound is off and a
   screen by packing matters more.
7. Can the packing operator read the central screen from where they scan, or do they need a screen at
   packing (a viewer PC showing only the Pakkeliste widget)? A viewer lags up to 5 s.
8. When should the packing station switch to `Pakning`? Until then it keeps `Enkel` (scan in, scan out).
9. Is a remade window given the same label as the original?

For the backend owner:

1. Can `GetRowsPaged` filter on a column (`OrderNo = 58830`)? Today we rely on `keyword`, whose matching
   is not documented (section 5).
2. Does `AddColumn` on `VentisolScans`, with some 100 000 rows, behave (time, locking)? Asked by
   feature #1 too (its §9), which adds `Event`.

## 10. Build steps

Each step is one commit, with its tests, in this order. Feature #1 steps 2 to 4 (classification,
Arbejdsform setting, rows with the `Event` column and `Mark`) land before step 1. Step 3 also needs
feature #1 step 10 (raw scans).

1. **ScanEvent: `CheckedOut` and `Undo`.** The two values in `ScanEventKind`, their mapping (`Out` +
   `CheckedOut`, `Mark` + `Undo`) through `ScanEvent.From`, `ToValues`, `TryFromValues`. Tests in
   `ScanEventTests` (round trip of both, an `Undo` row is `Direction = Mark`, a check-out row is `Out`
   with `DurationSec`). Add the two values to `opticloud-scans.md`, The table.
2. **Shared vectors and station replay.** The new cases in `scan-rules-vectors.json` (feature #1 adds
   `event`); `ScanReplay` handles a `Mark` / `Undo` row; `WorkRecord.IsCheckout`; `DayReport` leaves check-outs out of average
   time. Tests: `ScanRulesVectorsTests`, `ScanReplayTests`, `DayReportTests`.
3. **Web pairing on the same vectors.** On feature #1's `raw.scans.event` and `Mark`:
   `lib/derive/pairing.ts` (`is_checkout`, a `Mark` / `Undo` row drops its check-out). Tests: `scan-rules-vectors.test.ts`, `pairing.test.ts`,
   `scans.test.ts`. From here old and new readers agree.
4. **PackingList and PackingChecklist.** Pure, in `Packing/`. Tests (`PackingListTests`,
   `PackingChecklistTests`) against the real samples where present (skip without `orderdocs/`) and
   hand-made documents: expected count, sub-positions, `Quantity` null, extras, already checked, undo,
   rework `In` after a check-out, a newer list keeping ticks.
5. **Arbejdsform `Pakning` in setup.** On top of feature #1's setting: `Pakning` in the Opsætning
   drop-down, `SetupRules` (only kind `Packing`), `PackingSound` in settings and JSON. Tests:
   `StationSettingsTests`.
6. **PackingStation and PackingStore.** Several orders, switching, 14-day drop, the outcome's rows and
   messages; `packing.json` load/save, broken file. Tests: `PackingStationTests`, `PackingStoreTests`.
7. **ScanTable.ReadOrderAsync.** Keyword read, exact `OrderNo` filter, fallback. FakeOptiCloud: check
   its keyword search matches an `OrderNo`. Tests: `ScanTableTests`.
8. **Scan routing in MainViewModel.** Pakning stations go to `PackingStation`; stopping an element in
   progress at another station; rows through `Recorded`. Manual check with `DemoScanner` and
   FakeOptiCloud: rows in `/fake/state` with `Event`.
9. **The widget.** `PackingViewModel`, `PackingWidget`, `PackingWidgetView.xaml`, catalog entry, the
   short form on the station tile, list loading through `OrderDocuments`. A `--snapshot` style picture
   for review, like `--snapshot-document`.
10. **Restore, viewer and sound.** `PackingStore` on start, OptiCloud order history, the viewer's
    active order, `Sounds.cs` and `Lyd ved pakning`. Tests for the viewer's choice of active order.
11. **Undo (`VS-UNDO`).** On feature #1's `CommandCode` `Undo`. 30 s window for the next element scan;
    a `Mark` row with `Event = Undo`. Tests in `PackingStationTests`; the other commands refused with
    `Kortet bruges ikke her`.
12. **Read model.** `is_checkout` out of piece-time figures, `checked_out_at`, `elements_checked_out`,
    `packed_source = 'checklist'`, the Pakning span in the route, `incomplete_packed_orders`. Tests:
    `order.test.ts`, `station.test.ts`, `lists.test.ts`, `core-migration.test.ts`. Update
    `read-model.md` and `reports.md` in the same commit.
13. **Portal order page.** The Pakkeliste panel, the "Tjekket ud" column, the tile text.
14. **Docs.** `apps/station/README.md` (Arbejdsform Pakning, the widget, sound), `opticloud-scans.md`
    Rules (the last line about packed changes: with a checklist the order's end is known).

## 11. Test plan

Unit tests are listed per step. On top of them:

- **With FakeOptiCloud, one PC.** Station 7 set to `Pakning`, the documents folder pointed at
  `orderdocs/`. Scan all pieces of a sample order with `DemoScanner`: the counter, the lit rows, the
  complete state and sound. Check the rows in `/fake/state`: one `Out` per piece, `Event = CheckedOut`,
  `DurationSec = 0`, no row for a repeat.
- **Two orders.** Scan half of A, then B, then the rest of A: the switch message, the strip, A's ticks
  back.
- **Restart.** Close the app mid-order and start it with FakeOptiCloud stopped: the list and ticks
  come back from `packing.json` and the journal. Start FakeOptiCloud: nothing is sent twice.
- **Viewer.** A second app (`VENTISOL_STATION_DATA` elsewhere, Visning) with the widget shows the same
  order within 5 s.
- **Edge cases.** No PDF for the order; a position with Antal unreadable; a piece above Antal; a piece
  still in progress at Station 30 (gets its `Out` there); rework `In` after a check-out (red chip,
  order open again); undo (one `Mark` row with `Event = Undo` in `/fake/state`, the last released
  station app as a viewer skips it); `VS-PAUSE` at Pakning refused.
- **Portal.** Run the sync against FakeOptiCloud: the order is packed at the last check-out,
  `packed_source = 'checklist'`, the packing median of the station day is not 0, a half-done order shows
  in `listIncompletePackedOrders` after 12 quiet hours.
- **On site, before switching for good.** One shift with the packing station in `Pakning` and an office
  person comparing the screen with the pallet. Check the sound can be heard, and the screen read, from
  where the operator scans.
