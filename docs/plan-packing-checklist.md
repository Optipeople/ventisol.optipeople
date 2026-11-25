# Plan: packing checklist and pallets (Pakning)

Feature #2 from Ventisol's feedback of 2026-11-25, with the answers from Morten's visit the same day.
A plan to build from, no code yet. It sits beside `plan-scan-commands.md` (feature #1: command
barcodes and the "Arbejdsform" setting) and `plan-pallet-labels.md` (feature #3: pallet data, pallet
ids, printing and the portal's pallet views). This doc owns the whole floor flow at the packing
station, Arbejdsform `Pakning`: the checklist, building pallets, and the meaning of `VS-UNDO`,
`VS-PRINT`, `VS-REPRINT`, `VS-CLEAR` and a scanned pallet label there.

Feature #1 steps 2 to 4 must land first: the barcode classification (`ScanCodes.Classify`), the
Arbejdsform setting (`StationWorkMode`) and the rows (the `Event` column, `ScanEventKind`,
`Direction = Mark`). Feature #1 owns those; this doc only adds the `Event` values `CheckedOut` and
`Undo`. The pallet part (§2.3 on) uses #3's pallet ids, `VentisolPalletEvents`, `PalletBook` and
printer (#3 §8).

An element still in progress at the packing station's shift end follows `plan-shift-end.md`, as at
every station. A check-out is a moment, not a span, so it is rarely affected.

Written 2026-11-25.

## 1. What Ventisol asked for

> The packing station needs its own view. Once an order is scanned, all positions in the order show
> up in a list. The operator then scans each position, and every time one is scanned it lights up and
> is "checked out" of production. A final checklist: "Yes, we have this window on this pallet now, it's
> ready for transport, so it's out of production and the final time ends here."

And for pallets (feature #3): put the windows on a pallet, scan every window, scan a "print" barcode,
and get a paper with each window's barcode and a pallet id with its own barcode.

Answered at the visit (2026-11-25):

- **Pallets are built at the packing station.** No separate pallet place, no extra scanner, no pallet
  mode. One scan at packing both checks the piece out and puts it on the open pallet.
- **An order can't leave short.** The operator may leave a half-done checklist, but the order stays
  open until every piece is checked out. There is no command to close an order short.
- Pallets may hold several orders.

What that means for us:

- One scan per piece at packing, not an In and an Out.
- The station shows the whole order, not just the piece scanned, so the operator sees what is missing,
  and it shows the open pallet, so he sees what is on it.
- The last check-out of an order is the end of its lead time. Today the docs say no order can be called
  packed from the scans alone (`opticloud-scans.md`, Rules, last line). The checklist is the signal that
  was missing.

## 2. How it works on the floor

The packing station (station 7, "Pakning", kind `Packing`) is set to Arbejdsform `Pakning` in
Opsætning. Its scanner then feeds the checklist and the pallet, not the in/out toggle.

### 2.1 The checklist

1. Nothing open. The widget says **"Scan et element for at åbne pakkelisten"**.
2. The operator scans a window of order 58830 (Pos. 2, piece 1). The station:
   - opens the checklist for 58830 from the order's 3E production list (section 3),
   - checks that piece out at once (judgment: every scan at packing is a window in front of the
     operator; asking for a second scan of the same label would only confuse),
   - puts it on the open pallet, opening a new pallet if none is open (section 2.3),
   - says **"Ordre 58830 åbnet · Pos. 2 stk. 1 tjekket ud"**, lights the piece, plays the OK sound.
3. Each next scan of the same order lights one more piece: **"Pos. 3 stk. 1 tjekket ud"**. The counter
   at the top goes **"2 af 18"**, **"3 af 18"** ...
4. The last expected piece: the checklist turns green, **"Ordre 58830 er færdig · 18 af 18 tjekket
   ud · Klar til transport"**, and the complete sound plays. The list stays on screen until the next
   scan, or 2 minutes, then goes back to step 1. The pallet stays open until `VS-PRINT`.
5. A scan of another order while 58830 is half done: the station switches the checklist to the new
   order and says **"Skiftet til ordre 58831 · Ordre 58830 mangler 6"** (amber, 5 s). The piece goes
   on the same open pallet. 58830 stays open. It shows in the strip of open orders, and its list comes
   back, ticks and all, on the next scan of any of its pieces.

**Rule: an order can't leave short.** A half-done order stays open, in the strip and on the portal's
lists, until every expected piece is checked out. Nothing closes it by hand.

### 2.2 What the operator sees

The checklist shows the order of the piece scanned last. The open pallet is always shown beside it.
**Decision:** both on screen at once, the checklist on the left (about two thirds), the pallet on the
right. Why: each scan changes both, and the operator needs both answers ("what is missing of this
order", "what is on this pallet") without a scan to switch view.

Sketch of the widget (about 8 x 4 cells of the 12 x 6 grid; it scales like `DocumentWidgetView`):

```
+---------------------------------------------------------+----------------------------------+
| PAKNING                       Ordre 58830     12 af 18  | PALLE 261125-1-007   åben 0:12   |
| Jensen Byg ApS · Lev. uge 48                            | 9 vinduer · 2 ordrer             |
|---------------------------------------------------------| Ordre 58830 (7) · 58831 (2)      |
| ## Pos. 1  Drej Kip    1485 x 1380  [1][2][3]   3 af 3  |----------------------------------|
| .. Pos. 2  Fast karm    980 x 1200  [1][ ][ ][ ] 1 af 4 | 58830 Pos. 2 stk. 1    <- sidst  |
| ## Pos. 3  Terrassedør 1890 x 2180  [1]         1 af 1  | 58830 Pos. 1 stk. 3              |
| .. Pos. 4  Bundhængt    600 x  600  [ ][ ][ ][ ][ ][ ]  | 58831 Pos. 4 stk. 1              |
|    ... 2 positioner mere                                | 58831 Pos. 4 stk. 2              |
| !! Pos. 7  Ikke på listen           [1]         ekstra  | ... 5 mere                       |
|---------------------------------------------------------+----------------------------------|
| Pos. 2 stk. 1 tjekket ud · lagt på palle 261125-1-007                                10:42 |
| Åbne ordrer: 58831  3 af 9   ·   58790  7 af 8               Scan VS-PRINT for at udskrive |
+--------------------------------------------------------------------------------------------+
  ## = row lit (all its pieces checked)   .. = not done   !! = extra (amber)
  [n] = piece n lit   [ ] = piece not checked yet
```

UI rules:

- One row per position, a chip per piece. Ventisol positions hold 1 to 50 pieces; a row per piece
  would not fit (judgment: positions are what the office and the PDF talk about).
- Rows are 48 px or more and the counter is 72 px, for reading from a few metres. The last row touched
  flashes once and is scrolled into view. Done rows move nothing: the order stays the PDF's order, so the
  operator learns where to look.
- The pallet panel shows the newest five pieces, newest first, and the orders on the pallet when there
  are two or more. With no pallet open it says `Ingen palle åben · næste vindue starter en ny`. A
  pallet open longer than "Marker efter (timer)" gets an amber `åben over 4 t`, as a forgotten element
  does.
- Colours mean state, as in the rest of the app: green lit, neutral not done, amber extra or warning,
  red outline for a piece that went back to production after it was checked (section 4), red for a
  printer error.
- The station's own tile, when it is on screen, shows the short form:
  `Ordre 58830 · 12 af 18 · Palle 261125-1-007 (9)`. No in-progress rows, no stop button.

### 2.3 Pallets

**Decided: the first piece scanned with no pallet open opens a new pallet.** Why: no "start" card,
one scan less per pallet, and an operator can't forget it. The pallet id is made on the PC at once
(#3 §3), so it needs no network.

- **Each piece scanned** is checked out (a `CheckedOut` row, section 5) and added to the open pallet
  (an `Add` pallet event, #3 §4). Flash: `Pos. 3 stk. 1 tjekket ud · lagt på palle 261125-1-007`.
- **`VS-PRINT`**: the pallet sheet prints (#3 §5) and the pallet closes. Flash:
  `Udskriver palle 261125-1-007` / `9 vinduer · 2 ordrer`. The next piece opens a new pallet.
- **Printer fails**: red flash `Printeren svarer ikke` / `Pallen er gemt – scan VS-PRINT igen`. The
  pallet stays open; nothing is lost.
- **`VS-UNDO`**: one card, one meaning. It takes the piece added last off the open pallet **and**
  un-checks it. `Fortrudt: ordre 58556 · Pos. 5 · stk. 3 · ikke tjekket ud`. Scanned again, the one
  before, down to an empty pallet. It acts at once; it does not wait for a scan. Why: the label of a
  wrong window may already be stacked out of reach.
- **`VS-CLEAR`**, then `VS-CLEAR` again within 10 s: throws the open pallet away. First:
  `Scan VS-CLEAR igen for at tømme palle 261125-1-007`. Then: `Palle 261125-1-007 tømt · 9 vinduer
  ikke tjekket ud`. **Decided:** every piece on it is un-checked too, as if undone one by one. Why:
  the same meaning as `VS-UNDO`; a piece is checked out because it is on a pallet.
- **A pallet label (`VS-PL-…`)** with no pallet open, or the open pallet empty: that pallet reopens,
  `Palle 261125-1-004 åbnet igen – 6 vinduer`. Scan more pieces, then `VS-PRINT` prints a new sheet
  with the same id; the old sheet is thrown away. `VS-PRINT` straight after reopening, with no change,
  prints the same sheet again. Reopening changes no check-out and does not switch the checklist.
- **`VS-REPRINT`**: prints the last pallet printed at this station again (label gone or torn).
- **A piece already checked out and on another pallet** (printed or open at another PC): it moves to
  the open pallet. **Decided:** the check-out time stays the first one; only the pallet changes (an
  `Add` with `FromPallet`, no new `CheckedOut` row). Why: the piece left production at its first
  check-out; moving it between pallets is not a new end of lead time. Flash (amber):
  `Flyttet fra palle 261125-1-004` / `Palle 261125-1-004 skal printes igen` when that one was printed.
- **A piece already checked out and on no pallet** (checked out before pallets were built at
  packing): it goes on the open pallet, the check-out stays. `Lagt på palle · tjekket ud kl. 10:42`.

### 2.4 Messages

| Situation | Screen (Danish) | Sound |
|---|---|---|
| Piece checked | `Pos. 3 stk. 2 tjekket ud · lagt på palle 261125-1-007` | OK |
| Order complete | `Ordre 58830 er færdig · 18 af 18 tjekket ud · Klar til transport` | Complete |
| Already checked, on the open pallet | `Pos. 3 stk. 2 er allerede på pallen · tjekket ud kl. 10:42` | Warning |
| Already checked, on another pallet | `Flyttet fra palle 261125-1-004` / `Palle 261125-1-004 skal printes igen` | Warning |
| Not on the list | `Pos. 7 stk. 1 er ikke på produktionslisten · tjekket ud alligevel` | Warning |
| No list for the order | `Ingen produktionsliste for ordre 58830 · viser kun de scannede` | Warning (first scan only) |
| List still loading | `Henter produktionslisten ...` (the tick is kept and shown when it arrives) | OK |
| Piece was still in progress at an assembly station | `Pos. 3 stk. 2 var stadig i gang på Station 30 · stoppet dér` | Warning |
| Pallet printed | `Udskriver palle 261125-1-007` / `9 vinduer · 2 ordrer` | OK |
| Printer error or none set | `Printeren svarer ikke` / `Ingen printer valgt i Opsætning` (red) | Warning |
| Unreadable or not an element | `Ikke en elementkode` (as today) | Warning |
| A card Pakning does not use (`VS-START`, `VS-PAUSE`, `VS-HOLD`) | `Kortet bruges ikke her` (feature #1's shared message, §3.1), nothing stored | Warning |
| A pallet card or label before build step 11 | `Palle-scanning ved pakning er ikke klar endnu`, nothing stored | Warning |
| An unknown `VS-` card | `Ukendt kort` (feature #1) | Warning |

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
- **Piece not on the list** (position not in the PDF, or piece above Antal): it is still checked out,
  put on the pallet and recorded. It shows as an amber extra row and does not count in "12 af 18".
  Judgment: the floor is never blocked by a wrong list; the read model already lets such an element not
  block packed (`in_document = false`).
- **A newer print** of the PDF: the locator takes the newest, and the list is rebuilt when it changes
  (`OrderDocumentLoad.FileKey`). Ticks are kept by barcode; pieces that drop off the list become extras.

## 4. State and rules

A checklist belongs to an order. The station keeps any number open; one is shown (the active one), the
rest are in the strip. Judgment: a pallet can hold several orders and an operator can switch back and
forth, but one big list at a time is what can be read from a distance.

- **Active order**: the order of the last piece scanned at the station.
- **Open order**: an order with at least one check-out and not complete. It stays open across days and
  restarts until it is complete (§2.1, the order can't leave short). After 14 days with no check-out it
  leaves the station's strip, but stays open: the portal lists it, and its next scan brings it back.
- **Complete**: every expected piece is checked out and none of them went back to production. Extras
  don't count. Without a list, never complete on the station.
- A piece is **checked out** by its latest `CheckedOut` row at a packing station, unless a later scan
  undoes it: an `Undo` row (section 5) or an `In` at an assembly station (rework).
- **Open pallet**: at most one per Pakning station. It survives a restart and the night. The pallet
  rules (one pallet per window, the replay) are #3's (§4 there).
- **Checked out and on a pallet go together.** A scan does both, `VS-UNDO` and `VS-CLEAR` undo both. A
  move changes only the pallet. A checked-out piece on no pallet exists only from before pallets were
  built here.

Edge cases:

| Case | What happens | Why |
|---|---|---|
| Piece scanned twice within 2 s | Ignored (`RepeatScans`, as today) | Scanner double read |
| Piece already checked and on the open pallet, scanned again | No row, no event. `... er allerede på pallen`, warning sound | A toggle at packing would undo work by accident. Undo is a deliberate act (`VS-UNDO`). |
| Piece already checked, on another pallet | Moves to the open pallet; check-out time unchanged | §2.3 |
| Piece not on the list | Checked out, on the pallet, amber extra row | Never block the floor; the portal flags it |
| Piece of another order | Switch the active order, same open pallet, the old order stays open | Mixed pallets are allowed |
| Order left half done | Stays open, in the strip and on the portal's list; its next scan brings the list back | An order can't leave short |
| Piece still in progress at an assembly station | That station gets an `Out` at the check time (as a stop from its tile), then the check-out | An open `In` elsewhere would keep the order "on a station" and not packed in the read model |
| Piece in progress at packing itself (an `In` from Enkel mode, before the switch) | The check-out is its `Out`, with `DurationSec` since that `In` | Pairs as today |
| Checked piece comes back for rework (scanned `In` at Station 30) | The chip turns red outlined, `Tilbage i produktion (Station 30)`; the order is open again. It stays on its pallet in the pallet data, marked the same way in the pallet panel and the portal; checked again later, it moves to the then open pallet and the end time moves | Packed is derived, not latched (`read-model.md` §4) |
| Remake with the same label | Treated as the same piece: if it was checked out and went back, it is checked again | Same barcode, same element |
| Remake of an older order (below 58000) | Accepted when its PDF is in the folder (`OrderHints.Exists`), as today | Existing rule |
| Wrong piece scanned | `VS-UNDO` (the piece added last), or several `VS-UNDO` for one further back | Needs a deliberate command |
| `VS-UNDO`, open pallet empty or none open | Refused, `Intet at fortryde` | Nothing to take off |
| `VS-UNDO` after a move | Off this pallet and un-checked; it does not go back to the old pallet | One meaning for the card |
| `VS-PRINT`, no pallet open | Refused, `Ingen palle åben – scan vinduerne først` | |
| `VS-PRINT`, open pallet empty | Refused, `Pallen er tom` | |
| `VS-CLEAR` once | Asks, `Scan VS-CLEAR igen for at tømme palle X` | A pallet is not thrown away by one stray read |
| Pallet label, open pallet has pieces | Refused, `Print eller tøm palle Y først` | One open pallet per station |
| Pallet label of the open pallet | Nothing, `Det er den åbne palle` | |
| Pallet label never seen (other PC, before sync) | Opens it empty; old pieces show once the events arrive, `Palle X åbnet – ukendt indhold` | Never wait on the network |
| `VS-PL-` with other than 10 digits | Refused, `Ukendt pallelabel` | #3 §3 |
| Over 60 pieces on one pallet | Refused, `Maks 60 vinduer på en palle`, not checked out | A typo-loop guard, not a real limit (#3, open questions) |
| List arrives after the scan (slow share) | The tick is kept; the list is drawn when it arrives | Never wait on the network to record |
| Offline | Check-outs and pallet events go to their outboxes and journals; the screen never waits; printing needs no network | Existing outbox |
| `VS-START`, `VS-PAUSE`, `VS-HOLD` | Refused, nothing stored, `Kortet bruges ikke her` | A Pakning station has no session; feature #1's shared rule (§3.1). The tile shows no `PAUSE` band or `Session` label |

**In time versus pieces scanned twice.** At packing in Pakning mode a scan is a moment, not a span. A
check-out row carries `DurationSec = 0` (or the seconds since its open `In` at packing, if there was
one). A second scan of a checked piece writes no check-out, so a piece is never counted twice and no
packing time is invented. The order's time ends at its last check-out.

## 5. Data in OptiCloud

A scan at packing writes two things, at the same time: a check-out row in `VentisolScans` (below) and
an `Add` event in `VentisolPalletEvents` (#3 §4). Each goes through its own outbox.

| Floor action | `VentisolScans` | `VentisolPalletEvents` (#3) |
|---|---|---|
| Piece scanned | `Out` + `CheckedOut` | `Add` |
| Piece moved from another pallet | nothing | `Add` with `FromPallet` |
| `VS-UNDO` | `Mark` + `Undo` | `Remove` |
| `VS-CLEAR` (twice) | `Mark` + `Undo` per piece on it | `Clear` |
| `VS-PRINT`, `VS-REPRINT` | nothing | `Print` |
| Pallet label (reopen) | nothing | nothing (the next `Add` reopens it) |

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
(`plan-scan-commands.md` §6, its build step 4). This doc adds two values to `ScanEventKind`, listed
in #1 §6.1:

- `CheckedOut`: the piece is on the pallet and out of production. `Direction = Out`.
- `Undo`: cancels the latest `CheckedOut` of the same barcode at the same station. `Direction = Mark`.

A reader that does not know a value reads it as `Scan` (#1 §7.4).

**Undo** (`VS-UNDO`, and each piece of a `VS-CLEAR`): one row with `Direction = Mark`, `Event = Undo`,
at the packing station, at the time of the undo, `DurationSec` left out. A new reader drops it together
with the `CheckedOut` it cancels. `Mark` is a row that carries no time and never pairs (#1 §6), so an
old reader never starts a pass from it: an old station app skips it (unknown direction), and the portal
before #1's raw-scans step stores it with direction null and drops it. Such a reader still counts the
cancelled check-out as a finished pass at packing until it has the new version. Harmless. Judgment:
OptiCloud rows are never edited or deleted by the station (the table is a log, and re-sends rely on
`ScanId`).

**Reading an order's history.** The 36-hour window the station reads is too short: an order is often
assembled days before it is packed. New: `ScanTable.ReadOrderAsync(order)`, `GetRowsPaged` with
`keyword=<order>` and the rows kept whose `OrderNo` is that order, the same way `ExistsAsync` finds a
`ScanId`. If the keyword finds nothing it falls back to the 36-hour window plus the local store. Read
when a checklist is opened or comes back, and every minute while it is active. Open question for the
backend owner: a real column filter. Pallets are read from #3's `PalletBook` (14 days of events).

**Local store.** `packing.json` in the data folder (written with `AtomicFile`): per open order, the
checked pieces (barcode, time, `ScanId`), the time of the last check-out, and the active order. It
restores the widget at once after a restart, before any network, as the journal does for the stations.
OptiCloud wins when both are known (by `ScanId`). The open pallet comes back from #3's pallet journal.

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
    `Completed`. `Uncheck(Barcode, ...)` gives `Undone` or `NotChecked`. `SetList(PackingList)` keeps
    the ticks by barcode.
  - `PackingStation.cs`: the state machine of a Pakning station. It holds the open checklists, the
    active one, the open pallet (read from #3's `PalletBook`, ids from `PalletIdAllocator`) and the
    10 s `VS-CLEAR` confirm window. `Scan(Barcode, now)`, `Command(ScanCommand, now)` and
    `Pallet(PalletId, now)` return a `PackingOutcome`: scan rows to write, pallet events to write, a
    `PrintRequest` when a sheet is due, message key, sound. Open orders with no check-out for 14 days
    leave the strip. Pure, no I/O.
  - `PackingStore.cs`: load and save `packing.json`; tolerant of a missing or broken file (starts
    empty and logs).
- `StationSettings.cs` / `StationSettingsJson.cs`: the Arbejdsform comes from feature #1
  (`StationWorkMode { Enkel, Session, Pakning }`, `StationConfig.WorkMode`, `StationSetup.WorkMode`,
  `FileStation.WorkMode` in `settings.json`). This doc adds `PackingSound` (bool, default true) to
  `StationSettings`. The printer fields and "Palle-PC nr." are #3's (§6 there).
- `SetupRules.cs`: `Pakning` only on a station of kind `Packing` (the setup shows it greyed otherwise:
  `Kun for en pakkestation`). Judgment: the rows must say `StationKind = Packing` for the read model.
- `SetupView`: this doc adds `Pakning (tjekliste og paller)` to the Arbejdsform drop-down (feature #1
  offers only `Enkel` and `Session`).

App (`Ventisol.Station`):

- `ViewModels/MainViewModel.cs`, `Scan`: after `ScanCodes.Classify` (feature #1), when the station's
  Arbejdsform is `Pakning`, an `ElementCode` goes to `PackingStation.Scan`, a `CommandCode` `Undo`,
  `Print`, `Reprint` or `Clear` to `PackingStation.Command`, a `PalletCode` to
  `PackingStation.Pallet`, and any other command is refused with feature #1's shared message. Before a
  check-out, any other station on this PC with that element in progress is stopped through `Stop(...)`
  with a new `StopReason.CheckedOut` (`StationViewModel.cs`). The outcome's scan rows go out through
  `Recorded` like any scan (outbox, journal), its pallet events through `PalletRecorded`, and a
  `PrintRequest` through `PrintRequested` (#3 §6). `Hints` and `LastOrderChanged` work as today.
- `ViewModels/PackingViewModel.cs` (new): what the widget binds to: order, customer line, Lev. uge,
  counter text (`12 af 18`, `5 tjekket ud · listen kendes ikke`), rows with chips, the pallet panel
  (id, open time, count, orders, newest five), the message line with its state, the open-orders strip,
  `IsComplete`. Ticks once a second for the message timeouts, the pallet's open time and the 2-minute
  return to idle.
- `ViewModels/Widgets.cs`: `WidgetKind.Packing`, `PackingWidget(spec, PackingViewModel)` with
  `Spec.Station` set to the packing station. Catalog entry `("Pakkeliste", WidgetKind.Packing, null, 8, 4)`.
  The picker asks which station, as for the Document widget.
- `PackingWidgetView.xaml` (+ `.xaml.cs`, new): the layout of section 2.2, with a size rule like
  `DocumentWidgetView.Fit` (small block: order, counter, pallet id and count, message only).
- `StationViewModel.cs` / the station tile: in Pakning mode the tile shows the short form of §2.2.
- `MainWindow.xaml.cs`: makes the `PackingViewModel` per Pakning station (like `OrderDocumentViewModel`),
  loads the list in the background on the first scan of an order (`OrderDocuments.LoadAsync`, as
  `PrefetchDocument` does), feeds it OptiCloud's order history, and saves `PackingStore` after each
  check. `SendMachineOrders`: the packing station's machine gets the active order number while it is
  open, and none when it is complete (no per-element order at packing).
- `Sounds.cs` (new): three short WAVs as resources (`Assets/Sounds/ok.wav`, `done.wav`, `warn.wav`),
  played with `System.Media.SoundPlayer` off the UI thread, only on a scan PC and only when
  `PackingSound` is on. The scanner's own beep says "read"; the PC's sound says "accepted". Opsætning
  gets `Lyd ved pakning` (Til / Fra).
- `DemoScanner`: key 7 scans a piece at the packing station; Shift+7 sends `VS-PRINT`, which goes to a
  print preview window instead of a printer (#3 §6).
- Viewer mode: the widget works the same from what OptiCloud holds. The active order is the order of
  the newest `CheckedOut` row at that station; the open strip is the orders with check-outs in the 36
  hours read; the open pallet comes from the pallet events. A viewer records nothing, prints nothing
  and plays no sound. The list comes from `CloudDocumentSource` when the viewer has no folder.

Restart: `PackingStore` and the pallet journal give the screen at once, then the scan journal and
outbox, then OptiCloud's order history for the active order and the open ones (as `ApplyLoaded` does
for the stations).

## 7. Web portal / read model changes

- `lib/sync/scans.ts` and the `raw.scans.event` migration come from feature #1 (§8.1, its step 10),
  with `Mark` kept and `event` typed with `CheckedOut` and `Undo`.
- `docs/scan-rules-vectors.json`: feature #1 adds the optional `event` per event. This doc adds cases
  for a check-out (`durationSec` 0, no `In`), an undo (a `Mark` row with `event` `Undo`), and a
  check-out after a rework `In`. Both apps run them.
- `lib/derive/pairing.ts`: a `Mark` row with `event = 'Undo'` drops itself and the `CheckedOut` it
  cancels; it never opens a pass. A pass made from a `CheckedOut` row gets `is_checkout = true` (new
  column on `core.station_intervals`).
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
  `packed`. The Overblik list "Pakket ordre med manglende element" reads it. Since an order can't leave
  short, this list is the office's view of orders still waiting for pieces.
- Order page (`app/(detail)/ordre/[orderNo]`): a "Pakkeliste" panel in the same shape as the station
  (positions with piece chips, lit when checked out, the time on hover), and a "Tjekket ud" column in
  the elements table. The "Elementer pakket" tile reads `12 af 18 tjekket ud` when the order has
  check-outs. The pallets of the order are #3's "Paller" section (§7 there).
- Ugeplan "Klar til afsendt" may read a complete checklist; left as is until Ventisol asks.

## 8. A pallet label scanned at packing

A pallet label `VS-PL-<number>` at a Pakning station **reopens** that pallet (§2.3). It does not tick
anything off: every piece on a pallet was already checked out when it went on. Rules:

- `ScanCodes.Classify` (feature #1) gives a `PalletCode` for `VS-PL-` + 10 digits (`PalletId.TryParse`,
  #3 §3). `PackingStation.Pallet` reads it through `PalletBook.Find(id)` and `Contents(id)`.
- Allowed with no pallet open or the open pallet empty; refused when the open pallet has pieces
  (`Print eller tøm palle Y først`).
- The reopened pallet's pieces become the undo order (newest first), so `VS-UNDO` can take off a piece
  that was put on before the print.
- `VS-PRINT` with no change since reopening is a reprint (`Print` with `Reprint = true`, #3 §4).
- Reopening does not change the active checklist and writes nothing by itself.

## 9. Open questions

Decided with Ventisol on 2026-11-25 (no longer open): pallets are built at packing; pallets may hold
several orders; an order can't leave short and there is no close command; `VS-UNDO` is wanted, with
the meaning of §2.3.

For Ventisol:

1. Does the first scan of an order also check that window out? We assume yes (section 2).
2. A window packed in two parts ("Karm og ramme pakkes særskilt"): one label or two? We tick per label.
3. Does the central PC have speakers, and can the packing operator hear them? Else sound is off and a
   screen by packing matters more.
4. Can the packing operator read the central screen from where they scan, or do they need a screen at
   packing (a viewer PC showing only the Pakkeliste widget)? A viewer lags up to 5 s.
5. When should the packing station switch to `Pakning`? Until then it keeps `Enkel` (scan in, scan out).
6. Is a remade window given the same label as the original?

The printer and the 3E pallet label are open in #3 (open questions there).

For the backend owner:

1. Can `GetRowsPaged` filter on a column (`OrderNo = 58830`)? Today we rely on `keyword`, whose matching
   is not documented (section 5).
2. Does `AddColumn` on `VentisolScans`, with some 100 000 rows, behave (time, locking)? Asked by
   feature #1 too (its §9), which adds `Event`.

## 10. Build steps

Each step is one commit, with its tests, in this order. Feature #1 steps 2 to 4 (classification,
Arbejdsform setting, rows with the `Event` column and `Mark`) land before step 1. Step 3 also needs
feature #1 step 10 (raw scans). Step 11 needs #3 steps 1 to 8 (pallet ids, events, `PalletBook`,
outbox and sync, sheet, settings, Windows printer); those can be built before or alongside steps 1 to
10. Until step 11, pallet cards and labels at Pakning are refused (§2.4).

1. **ScanEvent: `CheckedOut` and `Undo`.** The two values in `ScanEventKind`, their mapping (`Out` +
   `CheckedOut`, `Mark` + `Undo`) through `ScanEvent.From`, `ToValues`, `TryFromValues`. Tests in
   `ScanEventTests` (round trip of both, an `Undo` row is `Direction = Mark`, a check-out row is `Out`
   with `DurationSec`). Add the two values to `opticloud-scans.md`, The table.
2. **Shared vectors and station replay.** The new cases in `scan-rules-vectors.json` (feature #1 adds
   `event`); `ScanReplay` handles a `Mark` / `Undo` row; `WorkRecord.IsCheckout`; `DayReport` leaves
   check-outs out of average time. Tests: `ScanRulesVectorsTests`, `ScanReplayTests`, `DayReportTests`.
3. **Web pairing on the same vectors.** On feature #1's `raw.scans.event` and `Mark`:
   `lib/derive/pairing.ts` (`is_checkout`, a `Mark` / `Undo` row drops its check-out). Tests:
   `scan-rules-vectors.test.ts`, `pairing.test.ts`, `scans.test.ts`. From here old and new readers agree.
4. **PackingList and PackingChecklist.** Pure, in `Packing/`. Tests (`PackingListTests`,
   `PackingChecklistTests`) against the real samples where present (skip without `orderdocs/`) and
   hand-made documents: expected count, sub-positions, `Quantity` null, extras, already checked,
   uncheck, rework `In` after a check-out, a newer list keeping ticks.
5. **Arbejdsform `Pakning` in setup.** On top of feature #1's setting: `Pakning` in the Opsætning
   drop-down, `SetupRules` (only kind `Packing`), `PackingSound` in settings and JSON. Tests:
   `StationSettingsTests`.
6. **PackingStation (checklist) and PackingStore.** Several orders, switching, 14-day strip, the
   outcome's rows and messages; `packing.json` load/save, broken file. Tests: `PackingStationTests`,
   `PackingStoreTests`.
7. **ScanTable.ReadOrderAsync.** Keyword read, exact `OrderNo` filter, fallback. FakeOptiCloud: check
   its keyword search matches an `OrderNo`. Tests: `ScanTableTests`.
8. **Scan routing in MainViewModel.** Pakning stations go to `PackingStation`; stopping an element in
   progress at another station; rows through `Recorded`; pallet cards refused for now. Manual check
   with `DemoScanner` and FakeOptiCloud: rows in `/fake/state` with `Event`.
9. **The widget.** `PackingViewModel`, `PackingWidget`, `PackingWidgetView.xaml`, catalog entry, the
   short form on the station tile, list loading through `OrderDocuments`. The pallet panel is drawn
   empty until step 11. A `--snapshot` style picture for review, like `--snapshot-document`.
10. **Restore, viewer and sound.** `PackingStore` on start, OptiCloud order history, the viewer's
    active order, `Sounds.cs` and `Lyd ved pakning`. Tests for the viewer's choice of active order.
11. **Pallets at packing.** On #3 steps 1 to 9. `PackingStation` opens a pallet on the first piece,
    writes an `Add` with each check-out, moves a checked-out piece (`FromPallet`, check-out time kept),
    `VS-PRINT`, `VS-REPRINT`, `VS-CLEAR` (with the un-checks), a pallet label reopens (§8), the 60
    limit, the printer error. `PalletRecorded` and `PrintRequested` wired; the pallet panel and the
    tile's pallet text; the open pallet restored from the pallet journal; the viewer's open pallet;
    demo keys. Tests: every pallet row of the §4 table in `PackingStationTests`, view model texts for
    §2.4.
12. **Undo (`VS-UNDO`).** On feature #1's `CommandCode` `Undo`: the piece added last off the open
    pallet and un-checked (`Remove` and a `Mark` / `Undo` row), again for the one before, after a
    reopen too, after a move. Tests in `PackingStationTests`; the session commands refused with
    `Kortet bruges ikke her`.
13. **Read model.** `is_checkout` out of piece-time figures, `checked_out_at`, `elements_checked_out`,
    `packed_source = 'checklist'`, the Pakning span in the route, `incomplete_packed_orders`. Tests:
    `order.test.ts`, `station.test.ts`, `lists.test.ts`, `core-migration.test.ts`. Update
    `read-model.md` and `reports.md` in the same commit.
14. **Portal order page.** The Pakkeliste panel, the "Tjekket ud" column, the tile text.
15. **Docs.** `apps/station/README.md` (Arbejdsform Pakning, the widget, pallets, the cards, sound),
    `opticloud-scans.md` Rules (the last line about packed changes: with a checklist the order's end is
    known).

## 11. Test plan

Unit tests are listed per step. On top of them:

- **With FakeOptiCloud, one PC.** Station 7 set to `Pakning`, the documents folder pointed at
  `orderdocs/`, the printer set to the print preview. Scan all pieces of a sample order with
  `DemoScanner`: the counter, the lit rows, the pallet panel, the complete state and sound. `VS-PRINT`:
  the sheet. Check `/fake/state`: one `Out` per piece, `Event = CheckedOut`, `DurationSec = 0`, one
  `Add` per piece and one `Print` in the pallet table, nothing for a repeat.
- **Two orders, one pallet.** Scan half of A, then B, then the rest of A: the switch message, the strip,
  A's ticks back, one pallet with both orders.
- **Move and reopen.** Print pallet 1, scan one of its pieces onto pallet 2: one `Add` with
  `FromPallet`, no new `CheckedOut`, the check-out time unchanged, `Palle … skal printes igen`. Scan
  pallet 1's label: reopened; `VS-PRINT`: a new sheet.
- **Undo and clear.** `VS-UNDO` twice: two `Remove` events and two `Mark` / `Undo` rows, the chips
  unlit. `VS-CLEAR` twice: a `Clear` and one `Undo` row per piece; the last released station app as a
  viewer skips the `Mark` rows.
- **Restart.** Close the app mid-order with a pallet open and start it with FakeOptiCloud stopped: the
  list, ticks and open pallet come back from `packing.json` and the journals. Start FakeOptiCloud:
  nothing is sent twice.
- **Viewer.** A second app (`VENTISOL_STATION_DATA` elsewhere, Visning) with the widget shows the same
  order and pallet within 5 s.
- **Edge cases.** No PDF for the order; a position with Antal unreadable; a piece above Antal; a piece
  still in progress at Station 30 (gets its `Out` there); rework `In` after a check-out (red chip,
  order open again); printer off (pallet stays open); `VS-PAUSE` at Pakning refused.
- **Portal.** Run the sync against FakeOptiCloud: the order is packed at the last check-out,
  `packed_source = 'checklist'`, the packing median of the station day is not 0, a half-done order shows
  in `listIncompletePackedOrders` after 12 quiet hours, the order page shows its pallets (#3).
- **On site, before switching for good.** One shift with the packing station in `Pakning` and an office
  person comparing the screen and the printed sheets with the pallets. Check the sound can be heard,
  and the screen read, from where the operator scans.
