# Plan: command cards Start, Pause and Hold (Arbejdsform "Session")

Feature #1 from Ventisol's feedback of 2026-11-25. A plan to build from; nothing here is built yet.
Features #2 (packing checklist, `Pakning`, [`plan-packing-checklist.md`](plan-packing-checklist.md))
and #3 (pallet labels, `Palle`, `VS-PRINT`, `VS-PL-<10 digits>`, [`plan-pallet-labels.md`](plan-pallet-labels.md))
are planned by others on top of the barcode classification (§3), the Arbejdsform setting (§4) and
the `Event` column with `Direction = Mark` (§6) defined here. Steps 2 to 4 of §10 must land before
either of them.

Read with: [`opticloud-scans.md`](opticloud-scans.md) (table, Writing, Rules, Orders on machines),
[`read-model.md`](read-model.md) (pairing, split time), [`../apps/station/README.md`](../apps/station/README.md).

Where this plan makes a judgment call it says **Decision:** with one line of why.

## 1. What Ventisol asked for

- More barcodes the scanner understands, not only element labels: **Start**, **Pause** and **Hold**,
  printed as command cards at the station.
- Purpose: count active time per order more precisely. The operator can go on a break (Pause), or a
  pane breaks or something odd happens and the work goes on Hold.
- The "multiple order issue": the operator would rather scan Start, then every element he will work
  on, then Hold when he is done with all of them, than scan each element in and out.
- Not every station works like that. Simple stations keep today's scan-to-start, scan-to-stop. So it
  is a setting per station.

## 2. How it works on the floor

Each station has a set of three cards: START, PAUSE, HOLD. The scanner says which station a card is
for, so the cards are the same at every station.

### 2.1 Enkel station (unchanged)

Exactly as today. Scan an element: it starts. Scan it again: it stops. With "Max i gang" 1 a
different element switches. A command card here is refused and nothing is stored:
`Kortet bruges ikke her` / `Station 10 kører Enkel` (the shared message of §3.1).

### 2.2 Session station: the normal day

1. The operator scans **START**. Tile: `Startet` / `Scan elementerne, og Hold når du er færdig`.
   The tile shows `Klar – scan elementer`. Nothing is stored yet.
2. He scans the elements he will work on, one by one. Each is scanned in at its own scan time.
   Tile per scan: `Startet – 3 i gang` / `Ordre 58556 · Pos. 5 · stk. 3`. One row per element with
   its own timer, as on a "Max i gang" station today.
3. He finishes one early: scanning it again scans that one out (`Scannet ud`), the rest go on.
4. He scans **HOLD** when he is done with all. Every element in progress is scanned out.
   Tile: `Hold – 3 afsluttet` / `58556 (2), 58557 (1) · 1 t 12 min`. The station is idle.

**Decision:** each element starts at its own scan, not at the START scan. Why: START may be scanned
long before the first element is picked up, and the scans are seconds apart anyway.

### 2.3 Session station: a break

1. Elements are in progress. He scans **PAUSE**. Every element is scanned out, marked as paused.
   Tile: `Pause` / `3 elementer på pause · tiden er stoppet`. The tile turns grey with
   `PAUSE` and how long the pause has lasted (`Pause 0:12:40`); the element rows stay, with frozen
   timers.
2. He comes back and scans **START**. Every paused element is scanned in again.
   Tile: `Fortsætter` / `3 i gang igen`. The timers go on from where they stopped.
3. An element scanned during the pause is refused, nothing stored:
   `Pause – scan Start først` / `Ordre 58556 · Pos. 5 · stk. 3 er ikke startet`.

### 2.4 Session station: something goes wrong

- One pane breaks: he scans that element again. It is scanned out, the others go on.
- Everything has to stop (the table is needed for something else): he scans **HOLD**. Every element
  is scanned out, as in 2.2.
- A held or scanned-out element is picked up again by scanning it, here or at any other station.
  That is a new pass, as today (rework rules unchanged).

**Decision:** HOLD means "stop all, the session ends". It does not mean "unfinished". Why: Ventisol
uses Hold both for "done with all" and for "something odd happened", so the scans cannot tell the
two apart. Reason cards are an open question (§9).

### 2.5 Session station: shortcuts and mistakes

- An element scanned with no START first starts the session at once (`Startet – 1 i gang`). Why: a
  forgotten START card must not lose a scan.
- START while running: `Allerede i gang` / `3 i gang`. Nothing happens.
- PAUSE while paused: `Allerede på pause` / `Scan Start for at fortsætte`.
- PAUSE or HOLD with nothing in progress: `Intet i gang` / `Scan Start og elementerne først`.
- One element more than "Max i gang": `Maks 4 i gang – scan en ud eller Hold`, not started.
- A `VS-` card the app does not know: `Ukendt kort` / `VS-XYZ`.

## 3. Barcodes

### 3.1 The scheme

Element labels are digits only. Every other barcode Ventisol prints for this system is Code 128
with a payload of capital letters, digits and `-`, always beginning `VS-`. So the two can never be
mistaken for each other, and a retail code (digits) is never a command.

| Payload | Kind | Owner | Meaning |
|---|---|---|---|
| `058556050103` (and the 11 and 14 digit forms) | Element | today | an element, rules unchanged (`Barcode.TryParseScan`) |
| `VS-START` | Command `Start` | #1 | Session: start a session, or go on after a pause |
| `VS-PAUSE` | Command `Pause` | #1 | Session: stop every clock at the station, keep the elements |
| `VS-HOLD` | Command `Hold` | #1 | Session: stop every element, end the session |
| `VS-UNDO` | Command `Undo` | #2 and #3 | Pakning: cancel the next scanned check-out. Palle: take the window added last off the open pallet |
| `VS-PRINT` | Command `Print` | #3 | Palle: print the open pallet and close it |
| `VS-REPRINT` | Command `Reprint` | #3 | Palle: print the last pallet printed at the station again |
| `VS-CLEAR` | Command `Clear` | #3 | Palle: scanned twice within 10 s, empty the open pallet |
| `VS-PL-<10 digits>` | Pallet | #3 | a pallet label. Format owned by #3: `yyMMdd` + PC digit + 3-digit counter. Any other `VS-PL-…` is Unknown (`Ukendt pallelabel`) |
| `VS-CLOSE` | proposed | #2 | close an order as sent short (#2 §9); Unknown until defined |
| `VS-SHIPPED` | proposed | #3 | mark a pallet shipped at loading (#3 §10); Unknown until defined |
| `VS-HOLD-<WORD>` | reserved | future | a Hold with a reason, if Ventisol wants reasons (§9); Unknown until then |
| any other `VS-<WORD>` | Unknown | | refused, `Ukendt kort` |

Rules for new words (features #2, #3 and later): one word of `A` to `Z`, at most 12 letters, or
`<WORD>-<value>`. Each new word is added to the registry in `Barcode.cs` and to this table. Words are
English; the Danish is on the printed card and the screen.

**Decision:** a known command at a station whose Arbejdsform does not use it is refused, nothing is
stored, with one shared message: `Kortet bruges ikke her` / `Station 30 kører Session` (the station's
name and Arbejdsform). The same goes for a pallet label at a station that is not `Pakning` or `Palle`.
Why: one rule the operator learns once, and each mode needs no texts for the other modes' cards.
Which words each mode uses:

| Arbejdsform | Uses |
|---|---|
| `Enkel` | no command, no pallet label |
| `Session` | `VS-START`, `VS-PAUSE`, `VS-HOLD` |
| `Pakning` | `VS-UNDO`, pallet labels (#2 §8, once #3 exists) |
| `Palle` | `VS-UNDO`, `VS-PRINT`, `VS-REPRINT`, `VS-CLEAR`, pallet labels |

**Decision:** no separate Resume, Done or Cancel card. Why: three cards are easier to keep at a
table than six, and each is a clear state: START = clocks run, PAUSE = clocks stop, HOLD = all done.
A second START or PAUSE does nothing (commands set a state; they do not toggle), so a double read or
a nervous second scan is harmless. A wrong element is taken back by scanning it again, as today.

### 3.2 Reading a payload

- Trim, upper-case.
- The separator after `VS` may arrive as `-` or `+`. Why: a Zebra cradle in keyboard mode on a
  Danish Windows layout types the US `-` key as `+`. In COM port mode (production) the bytes arrive
  as printed. Inside the payload (`VS+PL+2611251007`) the same goes.
- Only digits: the element rules, as today. A `VS` payload: the command registry. Anything else:
  Unknown (`Ukendt stregkode`, as today).

### 3.3 Classification in `Barcode.cs`

`Barcode` stays as it is. Next to it, one entry point the other features reuse:

```csharp
public enum ScanCommand { Start, Pause, Hold, Undo, Print, Reprint, Clear }

public abstract record ScanCode(string Raw);
public sealed record ElementCode(string Raw, Barcode Barcode, bool Strict) : ScanCode(Raw);   // Strict: passed TryParseScan
public sealed record CommandCode(string Raw, ScanCommand Command) : ScanCode(Raw);
public sealed record PalletCode(string Raw, string Number) : ScanCode(Raw);                   // exactly 10 digits (#3 §3)
public sealed record UnknownCode(string Raw, bool LooksLikeCommand) : ScanCode(Raw);          // true: began VS-

public static class ScanCodes
{
    public const string Prefix = "VS-";
    // New scans. inProgress: the station's elements in progress, so one can always be scanned out
    // (today's TryParseInProgress); also the paused ones (§5).
    public static ScanCode Classify(string? text, OrderHints? hints, IEnumerable<Barcode> inProgress);
}
```

Stored rows never hold a command as their barcode (§6), so `Barcode.TryParse` for stored scans is
unchanged.

## 4. The Arbejdsform setting

Per station in Opsætning, next to "Max i gang": **Arbejdsform**, a drop-down.

```csharp
public enum StationWorkMode { Enkel, Session, Pakning, Palle }
```

| Value | Shown as | Behaviour |
|---|---|---|
| `Enkel` | `Enkel (scan ind / scan ud)` | today's toggle; the default; every station after the update |
| `Session` | `Session (Start / Pause / Hold)` | this plan |
| `Pakning` | `Pakning (tjekliste)` | feature #2; not offered until built; #2 adds it to the drop-down in its own setup step |
| `Palle` | `Palle (pallelabels)` | feature #3; not offered until built; #3 adds it to the drop-down in its own setup step |

- Stored in `settings.json` per station as `"workMode": "Session"`, as text. A file without it is
  `Enkel`. A value this version does not know (a newer app wrote it) reads as `Enkel` and the PC logs
  it once. **Decision:** read it as a string, not with the enum converter. Why: an unknown enum value
  makes the whole `settings.json` unreadable today.
- Independent of `StationKind` (Assembly, Packing) and of "Max i gang". A Session station takes "Max
  i gang" as the most elements in one session. Session with "Max i gang" 1 is allowed (Pause for a
  single element); Opsætning then shows a hint, `Session med Maks 1: ét element ad gangen`.
- A viewer shows it in Opsætning too, so a PC switched to Scan mode has it, but a viewer's state
  comes from the rows (§7.6), not from the setting.
- Not mirrored in the portal: the rows say what happened (§6), so the read model needs no setting.
- Changing it while a station has elements on pause: Opsætning warns
  `Station 30 har 3 elementer på pause. De afsluttes, når du gemmer.` and Gem ends them as a HOLD
  would (§5, `Mark` rows). Elements in progress stay in progress in either mode.

## 5. State and rules

### 5.1 The station (Session mode)

```
          START / element            PAUSE
  Idle ───────────────────▶ Running ───────▶ Paused
   ▲                        │  ▲              │  │
   │          HOLD          │  └──── START ───┘  │
   └────────────────────────┘                    │
   └──────────────────────── HOLD ───────────────┘
```

- **Idle**: nothing in progress, nothing paused.
- **Running**: the session is open, 0 to "Max i gang" elements in progress, clocks running.
- **Paused**: the clocks are stopped. The elements that were in progress are kept as the paused set,
  with the time each had worked so far in this session.

Running with 0 elements and Paused with 0 elements exist only in memory: nothing is stored for them,
and a restart brings the station back as Idle. That loses nothing (no time runs).

### 5.2 One element at a Session station

| Element state | Element scanned | START | PAUSE | HOLD |
|---|---|---|---|---|
| not here | In (Running; refused beyond max; refused while Paused) | | | |
| in progress | Out (finished, the session goes on) | nothing | Out, event `Pause` | Out, event `Hold` |
| paused | refused, `Pause – scan Start først` | In, event `Resume` | nothing | `Mark`, event `Hold` |

- The rows are in §6. An Out by PAUSE carries `DurationSec` of the segment since its last In, as
  every Out does. So every reader that pairs In and Out already counts the right active time.
- Resume rows of one START are stamped 1 ms apart, in the order the elements were first scanned in.
  Why: the element scanned in last must stay the last after a restart, or OptiPeople gets a new run
  (`MachineOrders`, "the one scanned In last").
- A paused element scanned at another station is an ordinary In there and leaves the paused set
  here. A later START here resumes the rest.
- The stop button on a tile row works as today on an element in progress (Out). On a paused row it
  ends that one element with a `Mark` / `Hold` row.

### 5.3 Edge cases

| Case | What happens | Why |
|---|---|---|
| START twice | second does nothing, `Allerede i gang` | commands set a state |
| PAUSE twice | second does nothing, `Allerede på pause` | same |
| PAUSE or HOLD at Idle | refused, `Intet i gang`, not stored | nothing to stop |
| Element while Paused | refused, not stored | resuming half a session silently would surprise; the message says what to do |
| Element at Idle | starts the session and the element | a forgotten START must not lose a scan |
| Same card read twice within 2 s | ignored (`RepeatScans`) | the cradle reads twice; harmless anyway |
| Element beyond "Max i gang" | refused, `Maks 4 i gang – scan en ud eller Hold` | as today |
| Forgotten PAUSE over night | no time counted (the elements are out); START next morning resumes | paused time is never work |
| Paused over a weekend (more than 36 h) | the paused set is forgotten; START says `Intet på pause – scan elementerne` | the read window is 36 h (§9 asks if that is fine) |
| Forgotten HOLD over night (running) | counts as today: wall clock runs, the portal's working-time column leaves the night out, the row turns amber after "Marker efter" | same as a forgotten element today; auto-pause is an open question |
| Restart while Running or Paused | rebuilt from journal and OptiCloud (§7.5) | the rows hold it |
| Network down | outbox, as today | unchanged |
| OptiPeople stops the element's order | that element ends (Out), the others go on | as today |
| Mode changed while Paused | warned, ended with `Mark` / `Hold` on Gem | no orphan pauses |
| Command card at an Enkel station | refused, `Kortet bruges ikke her` | Enkel stations keep exactly today's data |
| `VS-UNDO`, `VS-PRINT`, `VS-REPRINT`, `VS-CLEAR` or a pallet label at a Session station | refused, `Kortet bruges ikke her` | belongs to #2 and #3 (§3.1) |
| Viewer on an older version | sees paused elements as not on the station; times right | old readers only pair In and Out |
| Clock change (summer time) | nothing | every time is UTC |

## 6. Data in OptiCloud

### 6.1 Table change

One new column in `VentisolScans`, added on connect like any missing column (`ScanEvent.Columns`):

| Column | Type | What |
|---|---|---|
| `Event` | String (0), friendly name "Hændelse" | why the row was written, one of `ScanEventKind` below; empty means `Scan` |

This plan owns the values. Every feature that writes a value adds it here:

```csharp
public enum ScanEventKind { Scan, Pause, Resume, Hold, CheckedOut, Undo }
```

| Value | Written by | Meaning |
|---|---|---|
| `Scan` | today, #1 | an ordinary scan; left out of the row |
| `Pause` | #1 | an Out by PAUSE |
| `Resume` | #1 | an In by START after PAUSE |
| `Hold` | #1 | an Out by HOLD, or a `Mark` ending a paused element |
| `CheckedOut` | #2 | a check-out at a Pakning station |
| `Undo` | #2 | cancels the latest `CheckedOut` of the same barcode at the same station |

And one new value of `Direction`: `Mark`, a row that carries no time and never pairs.

| Direction | Event | Written when | Pairs? |
|---|---|---|---|
| `In` | empty | an element is scanned in (Enkel and Session) | yes |
| `Out` | empty | scanned out, switched, stopped on the tile, stopped in OptiPeople | yes |
| `Out` | `Pause` | PAUSE, per element in progress | yes |
| `In` | `Resume` | START after PAUSE, per paused element | yes |
| `Out` | `Hold` | HOLD, per element in progress | yes |
| `Mark` | `Hold` | HOLD (or a stop, or a mode change) of an element already on pause | no: closes the pause, no time |
| `Out` | `CheckedOut` | #2: a check-out at a Pakning station, `DurationSec` 0 or since its open In there | yes |
| `Mark` | `Undo` | #2: `VS-UNDO` then a scan of a checked piece at a Pakning station | no: cancels that check-out, no time |

- Every row still carries the element's barcode, order, position and station. No row is written for
  START with no elements, or for PAUSE or HOLD with nothing in progress.
- **Decision:** `Event` is left out of the row when it is `Scan`. Why: an Enkel station's rows stay
  exactly as today's, and old rows (no column value) read the same as new ones.
- **Decision:** pause is stored as an Out and a Resume In, not as marks on an open In. Why: every
  reader that exists (station app, viewers, portal, old reports) pairs In and Out, so paused time is
  left out of every time already, before any reader is changed. The price is that one session pass
  becomes several passes; the readers that count pieces chain them (§7.5, §8).
- **Decision:** no station-level rows (no row for the START card itself). Why: every state that
  matters can be rebuilt from the element rows; a station row would need its own pairing and old
  readers would have to skip it.
- `Mark` is used for the paused case here and for #2's `Undo`. A reader tells them apart by `Event`.
  Later rows that carry no time use `Mark` too, with their own `Event` value added to the tables above.

### 6.2 Compatibility

- **Old rows** have no `Event`: read as `Scan`. Nothing changes for them.
- **Old station apps and viewers** read new rows like this: Pause-Out and Resume-In are ordinary Out
  and In, so times are right and a paused element shows as not on the station. A `Mark` row fails
  `ScanEvent.TryFromValues` (unknown direction) and is skipped (`ScanTable` counts it as skipped).
- **The portal before its update**: `toRawScan` stores `Mark` as direction null (the column has a
  check), and `parseScanRow` drops it. Pause and Resume pair as ordinary passes. Nothing breaks; a
  pause over 60 minutes counts as rework until §8 is in.
- **Rollback of the station app** (`StartupGuard`): an outbox file with `"direction": "Mark"` cannot be
  read by the old version and goes to `outbox\failed`; the next new version moves it back. A
  Pause-Out sent by the old version loses its `Event`. Both are rare and lose no time.
- **Feature #3** writes no rows to `VentisolScans`: pallets have their own table,
  `VentisolPalletEvents` (#3 §5). A later row that is not an element would use `Barcode` = the `VS-`
  payload and `Direction` = `Mark`. Old apps then skip it (`Barcode.TryParse` fails on letters), and
  the portal stores it without placing it.

## 7. Station app changes

All in `apps/station/src`. Core first, UI on top.

### 7.1 `Ventisol.Station.Core/Barcode.cs`

- Add `ScanCommand`, `ScanCode` and its four records, and `ScanCodes.Classify` (§3.3). The command
  registry is a dictionary from word to `ScanCommand`; `VS-PL-` is matched before it.
- `Classify` runs today's chain for digits: `TryParseScan`, else `TryParseInProgress` (now given the
  in-progress and the paused elements).

### 7.2 `StationConfig.cs`, `StationSettings.cs`, `StationSettingsJson.cs`, `SetupRules.cs`

- `StationWorkMode` enum (§4). `StationConfig` gains `WorkMode = StationWorkMode.Enkel`;
  `StationSetup` too, and `Config` passes it on.
- `FileStation` gains `string? WorkMode`; `Deserialize` parses it with a fallback to `Enkel`;
  `Serialize` writes the name. Version stays 1 (an added field with a default).
- `Normalize`: `Pakning` and `Palle` stay as they are (a newer app's file must round-trip); only an
  unknown text falls back.
- `SetupRules.Hints(StationSettings)`: the `Session med Maks 1` hint. `SetupRules.ModeChanges(old,
  new, pausedPerStation)`: the warnings of §4. Neither stops a save.

### 7.3 `StationState.cs` and a new `StationWorkflow.cs`

- `ScanKind` gains `Mark`. `ScanResult` gains `Event` (`ScanEventKind`, default `Scan`).
- `ActiveElement` gains `Before` (time worked earlier in this session, `TimeSpan.Zero` by default);
  `Elapsed(now) = Before + (now - Since)`.
- `StationState` gains `Session` (`Idle`, `Running`, `Paused`), `Paused` (the paused set, with each
  element's `Before`), `PausedSince`, and `Start(now)`, `Pause(now)`, `Hold(now)`, `EndPaused(raw,
  now)`. Each returns a `StationOutcome`.
- `StationOutcome(OutcomeKind Kind, IReadOnlyList<ScanResult> Records)`: what the tile flashes and the
  rows to record, in order. `OutcomeKind`: `In`, `Out`, `Switched`, `Started`, `Paused`, `Resumed`,
  `Held`, `NoChange`, `Rejected` (with a reason code the view model turns into Danish).
- `IStationWorkflow { StationOutcome Handle(ScanCode code, DateTimeOffset now); }` with
  `EnkelWorkflow` (today's `Scan`, commands refused) and `SessionWorkflow` (§5).
  `StationWorkflow.For(StationState)` picks by `WorkMode`. Features #2 and #3 route `Pakning` and
  `Palle` to their own engines (`PackingStation`, `PalletStation`) in `MainViewModel.Scan`; those
  refuse the words they do not use with the shared message of §3.1. Why an interface: four modes in
  one switch would grow into one long method.
- `Restore(active, paused, pausedSince)`: as today, plus the paused set.

### 7.4 `Cloud/ScanEvent.cs`, `Cloud/ScanJson.cs`, `Cloud/ScanTable.cs`

- `ScanDirection` gains `Mark`. New `ScanEventKind { Scan, Pause, Resume, Hold, CheckedOut, Undo }`
  (§6.1; #2 adds the last two with its own step). `ScanEvent` gains `Event` (last, default `Scan`).
- `Columns` gains `new("Event", "Hændelse", ColumnType.String)`; the table gets it on connect.
- `From(ScanResult)` maps `ScanKind.Mark` to a `Mark` row and copies `Event`. `ToValues` leaves out
  `Event` when it is `Scan`. `TryFromValues` reads it, case-insensitive; an unknown text reads as
  `Scan` and is logged once (a newer app may add values).
- `ScanJson.FileScan` gains `Event` (string, nullable). Unknown properties are already ignored.

### 7.5 `Cloud/ScanReplay.cs` and `DayReport.cs`

- Pairing stays as it is for In and Out. On top:
  - **Paused**: per station, the elements whose last row anywhere is an Out with `Event = Pause` at
    that station, not closed by a later `Mark` row, inside the window. `PausedSince` is the latest
    such Out. `ReplayResult` gains `Paused` (per station number: elements with `Before`, and since).
  - **Before**: for an element in progress or paused, the sum of the segments of its chain at that
    station: passes joined where an Out with `Pause` is followed by an In with `Resume`.
  - **Done**: a chain counts as one `WorkRecord`. `WorkRecord` gains `Active` (sum of its segments);
    `Start` is the chain's first In, `End` its last Out. `DayReport` uses `Active` for time and counts
    the record once.
- `MainViewModel.Apply` passes the paused sets to the stations.

### 7.6 `Ventisol.Station` (UI)

- `MainViewModel.Scan`: `ScanCodes.Classify`, then `station.Workflow.Handle`, then `Recorded` for each
  record in order, then `Scanned` once. The `_lastOrder` and `RepeatScans` handling stays; `RepeatScans`
  also keys commands by their payload.
- `MainViewModel.Stop` on a paused row calls `EndPaused` (a `Mark` row).
- `StationViewModel`: flashes and texts of §2. New `IsPaused`, `PauseText` (`Pause 0:12:40`),
  `IsSessionReady` (`Klar – scan elementer`). `Unreadable` gains the `Ukendt kort` text for a
  `VS-` payload.
- `ActiveRowViewModel`: the timer shows `Elapsed` (with `Before`), frozen and grey while paused. The
  "Marker efter" amber goes by active time.
- `MainWindow.xaml` tile template: the grey `PAUSE` band, the ready text, and a small `Session` label in
  the tile header so a Session station is told from an Enkel one.
- `SetupView`: the Arbejdsform drop-down per station row (only `Enkel` and `Session` offered; #2 and
  #3 each add their value in their own setup step), the hint and the warning of §4.
- `DemoScanner`: with a station's number, `Alt` + number cycles START, PAUSE, HOLD at that station.
- Viewer mode: state comes from `ScanReplay` (in progress and paused, from the rows), whatever the
  viewer's own Arbejdsform. A viewer never sees Running with 0 elements (not stored).

### 7.7 `Cloud/MachineOrders.cs` (OptiPeople)

- The rule stays: a machine's order is the element in progress scanned in last, else none.
- That gives: PAUSE clears the machine's order after the 3 s settle (OptiPeople's order time leaves the
  break out); START sets the element scanned in last again; HOLD clears it.
- A paused station is a station with nothing in progress, so a restart while paused clears only our own
  element, as today.
- No code change is expected; tests prove it (§10 step 8). The 1 ms stamps of §5.2 keep "scanned in
  last" stable across a restart.

## 8. Web portal and read model

### 8.1 Raw scans

- Migration: `raw.scans` gains `event text`; the direction check becomes `in ('In', 'Out', 'Mark')`.
- `lib/sync/scans.ts` `toRawScan`: keep `Mark`, copy `Event` (empty means `Scan`).
- `lib/scans.ts`: `Scan` gains `event: "Scan" | "Pause" | "Resume" | "Hold" | "CheckedOut" | "Undo"`;
  `Direction` gains `"Mark"`. #2 builds its pairing of `CheckedOut` and `Undo` on this.
  `parseScanRow` keeps `Mark` rows. `lib/report.ts` (the old pairing) ignores `Mark`.

### 8.2 Pairing (`lib/derive/pairing.ts`)

- `PairedInterval` gains `startEvent` and `endEvent`. `core.station_intervals` gains `start_event` and
  `end_event` (text, null on old rows, read as `scan`).
- New status **`paused`**: an element whose last row is an Out with `Pause` at a station, not closed by a
  `Mark` and not scanned anywhere since, and paused at most `staleOpenSeconds` ago. One row,
  `start_at` = the pause, `end_at` null. It counts in no time and no count, like `missing_out`. After 36
  hours it is not written at all: the pause simply ended. Migration: the status check gains `paused`.
- **Visits**: a pass that starts with `Resume` always continues the visit before it (`numberVisits`
  gets a "continues" test besides the 60 minute gap). Why: a long break is not rework.
- `inProgress` and "Max i gang": paused elements are Out, so they take no place. Unchanged.

### 8.3 Times

- **Active time**: every time that sums passes (touch time, split time, wall-clock pass time) already
  leaves the pause out, because the element was Out. Nothing to change.
- **Split time**: a paused element has no open pass, so it takes no share while paused. Unchanged.
- **Hold**: just the end of a pass (`end_event = 'hold'`). No own figure until reasons exist (§9).
- **Pieces by visit** (its own step, §10 step 11): `count_through` counts visits that ended that day
  (a visit ends with its last pass), and time per piece (median and mean) is the sum of a visit's split
  time. **Decision:** count by visit for every pass, also today's heuristic pauses (60 minutes). Why:
  with PAUSE one element becomes several passes, and counting passes would count it several times
  and halve its piece time. It moves past figures a little where the 60 minute rule already joined
  passes, so it ships with one full rebuild and a line in the changelog to Ventisol.
- **Station day**: `station_day_facts` gains `paused_seconds`: shift time where the station had paused
  elements and none in progress. Such time is not a gap, so a registered break is never "Stod stille".
  Busy time and utilisation leave it out (the station was not working).
- **Orders**: paused time is waiting, not work (`work_seconds` is time with an element at a station
  with a pass open). `current_station_nos` includes a station where an element of the order is paused;
  `currentLabel` says `Station 30 (pause)`.

### 8.4 Pages

- Ordre detail: passes show `Pause` / `Fortsat` / `Hold` at their ends; a paused element shows
  `På pause siden 11:30`.
- Stationer: a station with paused elements shows `Pause` and the count; the day row shows pause time.
- Chat: the `station_timeline` tool and the order tools report paused and held, and the prompt
  explains that a pause is not work.
- **Command cards page**: `/indstillinger/kommandokort`, a print page (A4, three cards per sheet, or
  one sheet per station with its name). Each card: the word in large type (`START`, `PAUSE`, `HOLD`),
  its colour (green, amber, red), the Code 128 barcode and the payload under it. **Decision:** print
  from the portal, with a small Code 128 encoder of our own (`lib/barcode/code128.ts`, tested against
  known patterns). Why: an office browser prints anywhere, the station PC may have no printer, no
  dependency, and features #2 and #3 add their cards to the same page.

## 9. Open questions

For Ventisol:

1. HOLD is both "done with all" and "something went wrong". Do you need to tell them apart in the
   reports? If yes: reason cards (`VS-HOLD-GLAS`, `VS-HOLD-MANGLER` ...), reserved in §3.
2. Which stations work in Session? Glazing (Station 30)? The assembly tables?
3. At the end of a shift, should a running session pause by itself (an "Auto-pause kl." setting), or is
   the amber mark enough?
4. A pause over a weekend (more than 36 hours) is forgotten and the elements must be scanned again.
   Acceptable, or do you pause over weekends?
5. An element scanned during a pause is refused. Would you rather it resumed the session?
6. Should the break time per station show in the reports (pause minutes per day)?
7. Cards: one set per station, laminated, A6? Fixed to the table?

For the OptiCloud backend owner:

1. Adding a column (`Event`) to `VentisolScans` with tens of thousands of rows: any cost or limit?
2. A new text value in an existing column (`Direction = Mark`): anything in OptiCloud's own reports
   on this table that filters on it?
3. Is there an API to register a stop on a machine with a reason (downtime "Pause" or "Hold") instead
   of clearing its order? It would show the break in OptiPeople's own OEE.

## 10. Build steps

Each step is one commit with its tests, in this order. Steps 1 to 8 are the station app, 9 to 13 the
portal. The station app may ship before the portal (§6.2).

1. **Rules and vectors.** `opticloud-scans.md`: the Event column, `Mark`, the Session rules.
   `scan-rules-vectors.json`: events gain `event`; expected outputs gain `paused` per station and
   `activeSec` on done records; new cases tagged `"needs": "events"` (pause and resume, pause over the
   window, Mark closing a pause, resume across a restart, paused element scanned at another station,
   1 ms resume order). Both test suites skip tagged cases until their step lifts it.
2. **Barcode classification.** `ScanCodes.Classify` and the records in `Barcode.cs`. Tests: every
   payload in §3.1, `VS+START`, lower case, spaces, `VS-PL-2611251007` and `vs+pl+2611251007` as
   PalletCode, `VS-PL-0042` as Unknown, `VS-CLOSE`, `VS-SHIPPED` and `VS-HOLD-GLAS` as Unknown, digits
   unchanged (all existing `Barcode` tests pass as they are).
3. **Arbejdsform setting.** Enum, `StationConfig`, `StationSetup`, JSON with fallback, `SetupRules`
   hint and warning. Opsætning drop-down. Tests: old file reads `Enkel`, unknown text reads `Enkel`,
   `Pakning` round-trips, hint and warning texts.
4. **Rows.** `ScanEvent.Event` (with `Scan`, `Pause`, `Resume`, `Hold`; #2 step 1 adds
   `CheckedOut` and `Undo`), `ScanDirection.Mark`, the `Event` column, `ToValues`,
   `TryFromValues`, `ScanJson`. Tests: Enkel rows identical to today's, round trips, old row reads
   `Scan`, unknown event reads `Scan`, `Mark` row round trip, the column is created on connect against
   `FakeOptiCloud`.
5. **Session engine.** `StationOutcome`, `IStationWorkflow`, `EnkelWorkflow` (today's behaviour,
   today's tests moved over unchanged), `SessionWorkflow`, `ActiveElement.Before`. Tests: every cell of
   §5.2 and every row of §5.3 that is in the engine.
6. **Replay.** `ScanReplay` paused sets, `Before`, chained `WorkRecord`, `DayReport` by chain. Lift the
   vector tag in the station tests. Tests: restart while paused and while running, journal only, cloud
   only, both.
7. **Screen.** `MainViewModel` dispatch, `StationViewModel` texts and states, frozen rows, tile
   template, paused-row stop, `DemoScanner`. Tests: view model texts per outcome, the flash order.
8. **OptiPeople.** Tests only, unless they fail: PAUSE clears after the settle, START sets the latest,
   HOLD clears, a restart while paused sets nothing, the resume order survives a restart.
9. **Command cards.** `lib/barcode/code128.ts` and `/indstillinger/kommandokort`. Tests: the encoder
   against known Code 128 patterns and check digits; a scan of the printed page with a real LI3678
   before the floor test.
10. **Raw scans.** Migration (`event`, direction check), `toRawScan`, `Scan.event`, `parseScanRow`,
    `lib/report.ts` ignores `Mark`. Tests: mapping of every row kind of §6.1, old rows.
11. **Pairing.** `start_event`, `end_event`, status `paused`, Resume continues the visit. Migration of
    `core.station_intervals`. Lift the vector tag in `pairing.test.ts`. Tests: the vectors, a 2 hour
    pause is visit 1, Mark closes a pause, a stale pause writes nothing.
12. **Counting by visit and pause time.** `count_through` and time per piece by visit,
    `paused_seconds`, gaps without pause, `currentLabel` with `(pause)`. Full rebuild on deploy. Tests:
    station day with a pause, an order paused now, split time with a paused element.
13. **Pages and chat.** Ordre detail, Stationer, chat tools and prompt. Tests: the tools' output with a
    paused element.
14. **Docs and rollout.** `apps/station/README.md` (Arbejdsform, cards), `read-model.md` (§8),
    `opticloud-scans.md` final. Release, then set one station to Session with Ventisol and watch a day.

## 11. Test plan

- **Unit, station app**: steps 2 to 8. The existing 558 tests stay green with every station `Enkel`;
  that is the proof Enkel is unchanged.
- **Unit, portal**: steps 9 to 13. The existing tests stay green on rows without `Event`.
- **Shared vectors**: the same new cases in both suites (step 1), so the station screen and the portal
  agree on in progress, paused and done.
- **Against FakeOptiCloud**: one scan PC and one viewer. Session station: START, three elements, PAUSE,
  wait, START, one element out, HOLD. Check the rows in `/fake/state`, the viewer's tiles at each step,
  the machine's order (cleared during the pause), and a restart of the scan PC while paused.
- **Old readers**: the last released station app as a viewer against the same FakeOptiCloud data: it
  must start, show the right times and skip the `Mark` row. The portal before step 10 synced against
  it: no error, times right.
- **Rollback**: install the new version, pause a station, roll back with `StartupGuard`'s path: nothing
  lost, the `Mark` file comes back on the next new version.
- **Scanners**: print the cards; scan each with an LI3678 in COM port mode and in keyboard mode on a
  Danish layout (`VS+START`), at the distance the cards will hang.
- **Floor**: one station in Session for a day with Ventisol. Compare the portal's active time per order
  with the operator's own account of the breaks.
