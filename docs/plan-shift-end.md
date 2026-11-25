# Plan: stop at shift end

Feature #16 from Ventisol's feedback of 2026-11-25. A plan to build from; nothing here is built yet.
It builds on the `Event` column, `ScanEventKind` and `Direction = Mark` of feature #13
([`plan-scan-commands.md`](plan-scan-commands.md) §6, its build step 4). It can be built right after
that step, before Session (#13 steps 5 on).

Read with: [`opticloud-scans.md`](opticloud-scans.md) (Writing, Rules, Orders on machines),
[`read-model.md`](read-model.md) (§2 the missing scan-out, §3 working time),
[`reports.md`](reports.md) (`listMissingScanOuts`), [`../apps/station/README.md`](../apps/station/README.md).

Where this plan makes a judgment call it says **Decision:** with one line of why.

## 1. Problem and decision

An operator forgot to scan an element out. It stayed in progress at the station over night, and its
order ran on until the next day. Today nothing stops that: the station shows it as in progress for up
to 36 hours, OptiPeople keeps it as the machine's order, and the portal counts the night as work on
the wall clock (the working-time column leaves the night out, but every wall-clock figure has it).

The same will happen with Session mode (#13): a forgotten HOLD leaves every element of the session
running, and a forgotten PAUSE leaves a paused set over night.

Ventisol's decision: at the end of a shift an element still running should stop. It keeps running
for a while, and if nothing happens its stop time is set to the shift end. Overtime work that ends
with a real scan-out keeps its real time.

Fixed before this plan:

- The stop is an `Out` row back-dated to the stop time (`ScanTime` = the stop time, `DurationSec`
  counted to it), with `Event = ShiftEnd`.
- It applies to every Arbejdsform (`Enkel`, `Session`, `Pakning`).
- A paused Session element already has its Out (the PAUSE wrote it). Only its pause is closed, with a
  `Mark` row, as #13 does for HOLD on a paused element.

## 2. How it works on the floor

### 2.1 The normal case: forgotten scan-out

1. Station 10 works 06:00 to 14:00. At 13:20 an element is scanned in. Nobody scans it out.
2. At 14:00 the shift ends. The element keeps running. The tile turns amber at the top:
   `Vagten sluttede 14:00` / `Stopper om 60 min, hvis intet sker`, counting down.
   The tile also gets a button `Arbejder videre`.
3. Nothing happens at the station. At 15:00 the app writes an Out for the element, back-dated to
   14:00, with `Event = ShiftEnd`. The pass is 13:20 to 14:00.
4. The tile flashes `Stoppet ved vagtskifte 14:00` / `Ordre 58556 · Pos. 5 · stk. 3` and then goes
   idle with the line `Stoppet ved vagtskifte 14:00` under the idle text, until the next scan or the
   next shift start.
5. The machine's order in OptiPeople is cleared after the usual 3 s settle.
6. Next morning the operator scans the element. It starts a new pass (an `In`), not an Out. The flash
   says `Startet igen` / `Blev stoppet ved vagtskifte i går 14:00 – scan igen for at stoppe`.

### 2.2 Overtime

1. Same station, same element in progress at 14:00. At 14:25 the operator scans another element in
   (or out, or any scan at that station). That is activity: the station is in overtime.
2. The element keeps running. The countdown starts over from the last activity:
   `Overarbejde` / `Stopper om 60 min, hvis intet sker`.
3. At 15:10 he scans the element out. A normal Out, real time 13:20 to 15:10. Overtime kept.
4. If he forgets and goes home after his last scan at 15:10, the station is quiet. At 16:10 what still
   runs there is stopped, back-dated to 15:10 (the last sign of work at the station).

### 2.3 "Arbejder videre"

An operator working on one long element after 14:00 scans nothing. He taps `Arbejder videre` on the
tile. That counts as activity and starts the countdown over. It writes no row.

### 2.4 Session station (#13)

- Running session at shift end, nothing happens: every element in progress gets an Out with
  `Event = ShiftEnd`, as HOLD would. The station is Idle.
- Paused session at shift end, nothing happens: every paused element gets a `Mark` row with
  `Event = ShiftEnd` at the stop time. The pause is closed. Next morning START says
  `Intet på pause – scan elementerne` (#13's existing text).
- A START, PAUSE or HOLD card in the grace period is activity, like an element scan.

### 2.5 Pakning station (#14)

A check-out is an Out of zero length and leaves nothing running. Only an element with an open `In` at
the packing station (scanned in under Enkel, or by an older app) is stopped. An open order checklist on
the screen is a view, not a running element: it is left as it is.

## 3. Where shift times come from

### 3.1 OptiCloud machine shifts

Each station is set up with a machine (`MachineId`). Shifts in OptiCloud are per machine. The swagger
(`docs/api/optipeople.swagger.json`) has:

| Call | What it gives |
|---|---|
| `GET /api/MachineShift/ExternalGetMachineShiftByMachineId?machineId=` | The machine's weekly shifts. The `External` calls are the ones meant for outside clients (the app already uses `ExternalSetPartOrder`). |
| `GET /api/Machine/GetNextShift?machineId=&currentTime=` | The next shift from a given time. |
| `GET /api/ShiftTemplate/GetTemplatesByMachineId?machineId=` | Shift templates applied to the machine, with dated versions (`MachineShiftFromTemplate`: `startDate`, `endDate`). |
| `GET /api/Machine/GetShiftTimeLine?id=`, `GET /api/RealtimeDashboard/GetShiftTimeline?machineId=` | The current shift as it runs (with dynamic start and stop). |

Every answer is the generic `ResponseViewModel`, so the swagger does not show the shape. The schemas
it does list say what a shift holds. `MachineShift`: `day` (`DayOfWeek`, 0 Sunday to 6 Saturday),
`startHour`, `startMinute`, `endHour`, `endMinute`, `isDynamicStart`, `isDynamicStop`,
`shiftIdentifierId`, `childShiftId` and `parentShiftId` (a shift over midnight is two rows, the
"glue" shift), `skipMachineShifts` (a skipped shift on a date, `activeDate`), `isDeleted`.
`MachineShiftViewModel` adds `startTime` and `stopTime` as text and `isSkipActive`.

The station app calls none of these today. It calls `Machine/GetByAccountId`, `Machine/Get/{id}` (for
`factoryId`) and the order calls (`OptiCloudClient`).

**Decision:** read `ExternalGetMachineShiftByMachineId` per mapped machine and build a weekly
schedule from it. Why: it is the call meant for clients like ours, it returns the plain weekly rows,
and one call per machine an hour is cheap. Build step 1 calls it in Ventisol's account and saves a
real answer next to the swagger before any code depends on its shape.

- Read on start, every 60 minutes, after Gem in Opsætning, and 10 minutes before each known shift end,
  so a shift changed during the day is seen in time.
- Kept in `shifts.json` in the data folder (per machine: the rows as read and when), so a start without
  network still knows the shifts. A cache older than 7 days is still used, and the log says so once.
- A read that fails keeps the cached schedule and retries with the usual backoff.
- Times are local wall clock (Danish). Each row becomes real instants per date in the PC's time zone,
  so a shift is 8 hours on both sides of a clock change, as `WorkCalendar` does in the portal.
- `skipMachineShifts` with an `activeDate`: that shift does not happen on that date, if the answer
  carries it (§8 asks).

**Decision:** the planned end is used, also on a machine with `isDynamicStop`. Why: dynamic stop
ends the shift when the machine stops, and these machines have no device to stop; the grace rule
(§4) already does what dynamic stop is for, from the scans.

**Decision:** templates and the running timeline are not read in the first version. Why: they are
for the backend owner to confirm (§8); if Ventisol's machines get their shifts from templates and
`ExternalGetMachineShiftByMachineId` comes back empty, step 1 finds out and the plan switches to
`GetTemplatesByMachineId` before step 3.

### 3.2 The portal's calendar is not used

The portal has its own calendar (`config.calendar_shifts`, Indstillinger > Kalender, read-model.md
§3). The station app does not talk to the portal, and OptiCloud is the source of truth for shifts.
The two can differ; §8 asks whether the portal should take its calendar from the machines later.

### 3.3 Fallback in Opsætning

A station with no machine, or a machine with no shifts in OptiCloud, uses a standard shift set on the
PC in Opsætning, under a new heading `VAGTSLUT`:

| Field | Default | What |
|---|---|---|
| `Stop ved vagtslut` | Til | the whole feature on or off for this PC |
| `Vent efter vagtslut (min)` | 60 | the grace period, 15 to 90 |
| `Standardvagt` | empty | start and end time, Monday to Friday, e.g. 06:00 to 14:00; empty means none |

Per station row, Opsætning shows where the shifts come from, as text:
`Vagter fra OptiPeople: man–fre 06:00–14:00`, `Ingen vagter i OptiPeople – bruger standardvagt
06:00–14:00`, or `Ingen vagter – stopper ikke ved vagtslut`.

**Decision:** a station with neither machine shifts nor a standard shift is never stopped. Why: a
guess of the shift would stop real work; the portal's 36 hour `stale` rule stays as the safety net.

**Decision:** one standard shift per PC, not per station, and not per weekday. Why: it is only a
fallback until the machines have shifts; a full calendar belongs in OptiCloud.

**Decision:** `Stop ved vagtslut` is on by default after the update. Why: Ventisol asked for it, and
a station without shifts does nothing anyway.

## 4. Rules

### 4.1 Terms

- **Working span**: a shift, with shifts that touch or lie less than 2 hours apart joined into one
  span. A shift over midnight (the two glued rows) is one span.
- **Shift end** (E): the end of a span. **Off shift**: the time between a span's end and the next
  span's start (N).
- **Activity** at a station: a row written for that station (In, Out, Mark, by this PC or seen in
  OptiCloud from another), any scan the station hears (also one refused or unreadable), a command card,
  a stop on its tile, and a tap on `Arbejder videre`. Not a `ShiftEnd` row.
- **Grace** (G): `Vent efter vagtslut`, 60 minutes unless set.

**Decision:** spans closer than 2 hours are one. Why: a lunch or coffee break set up as two shifts
must not stop elements; a forgotten scan-out over a break is the old 60 minute pause rule's job.

**Decision:** activity is per station, not per element. Why: at a station with "Max i gang" above 1
the operator works on several elements and scans only some, and in Session he scans nothing between
START and HOLD.

### 4.2 The rule

For a station with elements in progress or paused, during an off-shift period [E, N):

1. Let `x` = the later of E and the station's last activity before now.
2. If there is no activity for G after `x`, and `x + G` is before N, the station is stopped at `x`:
   - every element in progress gets an `Out`, `ScanTime = x`, `DurationSec` = `x` minus its In (its
     segment since its last In, as every Out), `Event = ShiftEnd`;
   - every paused element (Session) gets a `Mark`, `ScanTime = x`, `Event = ShiftEnd`.
3. Any activity moves `x` on. If N comes first, nothing is stopped and the next shift end is judged
   the same way.

So:

- Nothing after E: stop at E. That is Ventisol's rule.
- Activity after E (overtime): stop at the last activity, once the station has been quiet for G.
- Every element at the station stops at the same `x`. `x` is never before any row at the station, so
  a `ShiftEnd` row is never earlier than another row there.

**Decision:** the overtime stop is the last activity, not the shift end and not the time of the
check. Why: inside the shift we assume work (Ventisol's rule); outside it we count only what a scan
proves, and never invent the grace period as work.

**Decision:** the same rolling rule in the grace period and in overtime, one check, no fixed "end of
overtime". Why: one rule to explain on the floor ("quiet for an hour after the shift, and what runs
stops"), and it clears OptiPeople's order soon after work ends rather than the next morning.

The cost: an element scanned in after 14:00 and then left alone gets a pass of zero length (stopped
at its own In). It shows as auto-stopped in the portal (§7). The countdown and `Arbejder videre` are
there so a long overtime element is kept.

### 4.3 Who writes the row

**Decision:** the station app in Scan mode writes it. Why: it is the only writer of
`VentisolScans`, it has the outbox with client scan times, and it knows its own activity.

- It is recorded exactly like a scan (`Recorded`: journal, outbox, `VentisolScans`), with its
  back-dated time.
- The check runs every 30 seconds on the UI thread from `MainWindow`'s tick, and once at start.
- **Viewer mode writes nothing.** A viewer shows the stop when the row arrives (§6.6).
- **Not before the rebuild from OptiCloud.** As with machine orders, no `ShiftEnd` is written until
  the screen has been rebuilt from OptiCloud's 36 hours, so an element scanned out on another PC is
  known. Without network for long: after 5 minutes from start it goes on with the journal alone, as
  the station is the only writer.
- **The ScanId is derived**, not random: a name-based UUID (v5) of the element's `In` `ScanId` and the
  text `ShiftEnd`. A second write of the same stop (a restart in between, two PCs) has the same
  `ScanId` and is refused by the unique key. **Decision:** derived id. Why: it makes the stop
  idempotent with no lookup, using the duplicate handling `Outbox` already has.
- **Checked against OptiCloud first.** Right before writing, the app looks in the newest rows it has
  read (the 5 s polls) for an Out or In of that element at that station after its In. Found: it writes
  nothing and takes the other row (the screen follows it at the next replay).
- Network down: it writes anyway. The outbox sends it later with its own time.

### 4.4 Catch-up after the PC was off

The PC was off over a shift end (power cut, update, crash). On start, after the rebuild:

- The rule of §4.2 runs over the time since each element's In, from the rows (journal and OptiCloud).
  For every element in progress it walks the shift ends after its In in order, and stops it at the
  first one where the rows show no activity for G after `x`.
- Activity known only on the PC (a tap, a refused scan) was lost with the PC, except what is kept in
  `shift-end.json` (§6.2).
- The window is the app's usual 36 hours. An In older than that is not in progress on the screen and
  gets no `ShiftEnd`; the portal shows it as `missing_out` / `stale`, as today.

**Decision:** catch-up stays inside the 36 hour window. Why: the same window as every other rule,
and a station PC off for more than a day and a half is rare.

### 4.5 After the stop

- The element is no longer in progress at the station. Its next scan there is an `In`.
- The read model joins the next morning's pass to the same visit, not rework (§7.3).
- The stop is final. Rows are never edited or deleted.

### 4.6 A late Out after a ShiftEnd

Readers (station replay and portal) see an Out of the same element at the same station after a
`ShiftEnd` Out, with no In between. That can only come from a second PC (a setup mistake) or a
scan-out that sat in another PC's outbox.

**Decision:** the real Out wins if it is at most 12 hours after the `ShiftEnd` time: the pass ends at
the real Out and the `ShiftEnd` row is ignored. A later one is ignored. Why: an Out the same evening
is overtime Ventisol wants kept; one the next day is the forgotten scan-out this feature exists to stop.
Today such an Out (no open In) would make a second pass from its `DurationSec`, counting the time
twice; this rule ends that.

### 4.7 Edge cases

| Case | What happens | Why |
|---|---|---|
| Shift over midnight (22:00 to 06:00) | One span, from the two glued rows; the shift end is 06:00 | `childShiftId` / `parentShiftId` |
| Two shifts back to back (06:00 to 14:00, 14:00 to 22:00) | One span 06:00 to 22:00; nothing stops at 14:00 | spans less than 2 h apart are joined |
| Lunch break as two shifts (06:00 to 10:00, 10:30 to 14:00) | One span | same |
| A day with no shift (holiday, skipped shift) | No shift end that day. An element left from the day before was stopped then | the rule runs off shift whatever the day |
| Weekend work, no shift | Off shift since Friday's end. Saturday scans are activity; when the station is quiet for G, what runs stops at the last activity | same rule |
| Element left Friday, PC on | Stopped Friday at E + G, back-dated to E | the normal case |
| Element left Friday, PC off all weekend | Not stopped if its In is older than 36 h at start; portal says `stale` | §4.4 |
| Shift changed in OptiCloud during the day | Seen at the next read (hourly, and 10 min before each end) | the cache is not trusted blindly |
| Shift changed after a stop was written | The stop stays | rows are a log |
| Machine changed on the station in Opsætning | Schedule read again on Gem | |
| Station with no machine, no standard shift | Never stopped; Opsætning says so | §3.3 |
| Two stations on one machine | Both use that machine's shifts | shifts belong to the machine |
| An element in progress at two stations | Each pass judged at its own station | rules pair by station |
| "Max i gang" above 1 | All elements at the station stop at the same `x` | activity is per station |
| Clock change in the night | Shift times are wall clock per date; the stop is in UTC | as `WorkCalendar` |
| A shift end at a time that does not exist (02:30 in spring) | The next real instant | |
| A shift end at a time that exists twice (02:30 in autumn) | The later instant | the shift is not cut short |
| PC clock wrong | Stops are as wrong as its scans already are | not new |
| Update or restart in the grace period | Rebuilt from rows and `shift-end.json`; the countdown goes on | §6.2 |
| Real Out sent late from the outbox of another PC | Real Out wins within 12 h | §4.6 |
| Element scanned out on another PC, already in OptiCloud | No `ShiftEnd` written | §4.3 check |
| Two PCs both write the stop | Same derived `ScanId`; the second is refused | §4.3 |
| Session running, no elements | Nothing stored; the session goes Idle in memory | #13 §5.1 |
| Session paused over the shift end | `Mark` / `ShiftEnd` for each paused element | §2.4 |
| Pakning open checklist | Not touched | §2.5 |
| Grace set to 0 or feature off | Nothing is stopped | |
| OptiPeople stops the order in the grace period | That element ends as today (`Stoppet i OptiPeople`) | unchanged |

### 4.8 Fit with #13's plan

**Decided (Morten, 2026-11-25):** a forgotten pause is closed at shift end too, as a stop. `plan-scan-commands.md`
already follows this plan: §5.3 (a forgotten PAUSE is closed with `Mark` / `ShiftEnd`, a forgotten
HOLD stops with `Out` / `ShiftEnd`), §6.1 (`ShiftEnd` in `ScanEventKind` and both rows), and no
auto-pause question left in §9.

## 5. Data in OptiCloud

### 5.1 Rows

No new column. `ScanEventKind` (#13 §6.1) gains one value:

```csharp
public enum ScanEventKind { Scan, Pause, Resume, Hold, CheckedOut, Undo, ShiftEnd }
```

| Direction | Event | Written when | Pairs? |
|---|---|---|---|
| `Out` | `ShiftEnd` | an element in progress is stopped at shift end (§4.2) | yes, like any Out |
| `Mark` | `ShiftEnd` | a paused element's pause is closed at shift end | no: closes the pause, no time |

| Column | Value on a `ShiftEnd` Out |
|---|---|
| `ScanId` | UUID v5 of the In's `ScanId` and `ShiftEnd` (§4.3) |
| `ScanTime` | the stop time `x`, not the time it was written |
| `DurationSec` | `x` minus the element's last In |
| `Device` | the PC that wrote it |
| `Event` | `ShiftEnd` |
| the rest | as on any Out of that element at that station |

### 5.2 Compatibility

- An old station app or viewer reads a `ShiftEnd` Out as an ordinary Out (an unknown or missing
  `Event` reads as `Scan`; an older app does not know the column). Times are right. It skips the `Mark`
  (#13 §6.2).
- The portal before §7 pairs the `ShiftEnd` Out as an ordinary pass. Time is right; only the
  auto-stopped mark is missing.
- No shift data is written to OptiCloud.

## 6. Station app changes

All in `apps/station/src`. Core first, UI on top.

### 6.1 `Ventisol.Station.Core/Cloud/OptiCloudClient.cs` and a new `Cloud/MachineShifts.cs`

- `OptiCloudClient.GetMachineShiftsAsync(Guid machineId)`: `MachineShift/ExternalGetMachineShiftByMachineId`.
  Returns `IReadOnlyList<MachineShiftRow>` (`Day`, `Start`, `End` as `TimeOnly`, `IsDynamicStop`,
  `ParentId`, `ChildId`, `SkipDates`). Reads `day` as number or name, field names case-insensitive, as
  the other calls do. Deleted rows dropped.
- `MachineShifts`: per mapped machine, read on start, hourly and before each end; cache in
  `shifts.json` (`AtomicFile`). Raises `Changed`. Its own loop with backoff, as `MachineOrderSync`.
  Only in Scan mode with OptiCloud set up.

### 6.2 New `Ventisol.Station.Core/ShiftEnd.cs`

Pure, no clock, no I/O.

```csharp
// A machine's or the standard shift as weekly wall-clock blocks, turned into real spans per date.
public sealed record ShiftSchedule(IReadOnlyList<ShiftBlock> Blocks, IReadOnlyList<DateOnly> SkipDates)
{
    public static ShiftSchedule? From(IReadOnlyList<MachineShiftRow> rows);
    public static ShiftSchedule Standard(TimeOnly start, TimeOnly end);          // Monday to Friday
    public IReadOnlyList<(DateTimeOffset Start, DateTimeOffset End)> Spans(DateTimeOffset from, DateTimeOffset to, TimeZoneInfo zone);
}

public sealed record ShiftEndDue(int Station, DateTimeOffset StopAt, DateTimeOffset DueAt, DateTimeOffset ShiftEnd);

public static class ShiftEndRule
{
    public static readonly TimeSpan JoinGap = TimeSpan.FromHours(2);
    public static readonly TimeSpan LateOutWins = TimeSpan.FromHours(12);

    // For one station: null while in a span or nothing runs; else when it stops (StopAt = x) and
    // when that is due (x + grace). Due <= now means write it.
    public static ShiftEndDue? Evaluate(int station, ShiftSchedule schedule, IReadOnlyList<DateTimeOffset> activity,
        DateTimeOffset earliestRunningSince, TimeSpan grace, DateTimeOffset now, TimeZoneInfo zone);

    public static Guid StopId(Guid inScanId);   // UUID v5, namespace fixed in code
}
```

- `ShiftEndActivity`: the local activity per station (refused scans, taps), kept in
  `shift-end.json` in the data folder for 36 hours, so a restart in the grace period keeps it.

### 6.3 `StationState.cs`, `StationSettings.cs`, `StationSettingsJson.cs`, `SetupRules.cs`

- `ActiveElement` gains `InScanId` (`Guid?`), set when recorded and when restored from replay, for
  `StopId`. Null only for an element from an old journal line; then the id is made from barcode,
  station and In time.
- `StationState.StopAll(DateTimeOffset at, ScanEventKind ev)`: an `Out` per element in progress at
  `at`, `Event = ev`. For Session (#13) `SessionWorkflow.ShiftEnd(at)`: Outs for running, `Mark`s for
  paused, state `Idle`. `ScanResult.Event` comes from #13 §7.3.
- `StationSettings` gains `ShiftEndOn` (true), `ShiftEndGraceMinutes` (60, 15 to 90), `StandardShift`
  (`TimeOnly? Start, End`). Old files read the defaults. Version stays 1.
- `SetupRules`: the per-station source text of §3.3; a hint when the standard shift's end is before
  its start (`Standardvagt slutter før den starter`), not a refusal (a night shift is allowed).

### 6.4 `Cloud/ScanReplay.cs`, `DayReport.cs`

- `WorkRecord` gains `EndEvent` (`ScanEventKind`, default `Scan`).
- The late Out rule of §4.6: when an Out finds no open In, and the last record of that station and
  barcode ended with `ShiftEnd` at most 12 h before, that record's end moves to this Out and its
  `EndEvent` becomes `Scan`. Beyond 12 h the Out is skipped.
- `ReplayResult` gains `AutoStopped`: per station, the latest `ShiftEnd` time and its elements, within
  the window. The idle line and the `Startet igen` text read it.
- `DayReport` counts a `ShiftEnd` record as done, like any.

### 6.5 `Ventisol.Station` (UI)

- `MainWindow.xaml.cs`: on each tick (30 s) in Scan mode, after the OptiCloud rebuild, for each station
  call `ShiftEndRule.Evaluate` with its schedule (machine, else standard), its activity (rows from the
  last load plus `_recorded` plus `ShiftEndActivity`), and the earliest `Since` of its elements. When
  due: the §4.3 check against the loaded rows, then `_vm.ShiftEnd(station, x, shiftEnd)`, then
  `SendMachineOrders()`. Log: `Station N: ordre X (barcode) stoppet ved vagtskifte 14:00`.
- `MainViewModel.ShiftEnd(int station, DateTimeOffset at, DateTimeOffset shiftEnd)`: as `Stop`, for
  every element of the station, raising `Recorded` per row in In order, then `History` records.
  Not a scan: no `Scanned`, `LastScanAt` unchanged.
- `MainViewModel.Scan`: every scan that reaches a station (also unreadable or refused) notes activity.
- `StopReason` gains `ShiftEnd`; `StationViewModel.Stop` flashes `Stoppet ved vagtskifte 14:00`.
- `StationViewModel`: `ShiftEndState` (`None`, `Grace`, `Overtime`, `Stopped`), `ShiftEndText`
  (`Vagten sluttede 14:00` / `Overarbejde` and `Stopper om 42 min, hvis intet sker`), the
  `Arbejder videre` command (activity), the idle line `Stoppet ved vagtskifte 14:00` until the next
  scan or span start, and the `Startet igen` flash of §2.1 when an In follows a `ShiftEnd` of the same
  element here within 36 h.
- `MainWindow.xaml` tile template: the amber band with the countdown and the button (a big touch
  target, as the stop button), the idle line.
- `SetupView`: the `VAGTSLUT` heading and its three fields; the source text per station row.
- `DemoScanner`: `Alt`+`V` sets a fake shift end at now for every station, for a demo of the countdown
  with grace shortened to 1 minute in a dev build.
- Viewer mode: no countdown, no button. The idle line and the stop come from the rows
  (`ReplayResult.AutoStopped`). **Decision:** no countdown on a viewer. Why: the viewer cannot see the
  scan PC's taps and refused scans, so its countdown could be wrong.

### 6.6 `Cloud/MachineOrders.cs` (OptiPeople)

- No code change. A stopped element leaves the station with nothing in progress, so the desired order
  is none and the machine is cleared after the 3 s settle, as after any Out.
- OptiPeople's run ends when the clear arrives (the server stamps the time), so at `x + G`, not at
  `x`. There is no time field to back-date it. OptiPeople counts order time inside its own shift, so
  the grace period after the shift adds nothing to its shift figures; overtime it would have counted
  anyway. §8 asks the backend owner.

### 6.7 `tools/FakeOptiCloud`

- `MachineShift/ExternalGetMachineShiftByMachineId`, shaped like the saved real answer (step 1), from
  a `shifts` section in `fakeopticloud-data.json` (default Monday to Friday 06:00 to 14:00 per machine),
  shown in `/fake/state`.

## 7. Web portal and read model

### 7.1 Raw scans

- Needs `raw.scans.event` from #13 §8.1 (its step 10). If #16 comes first, its portal step adds the
  column and the `toRawScan` copy; #13 step 10 then adds only `Mark`.
- `lib/scans.ts`: `Scan.event` gains `"ShiftEnd"`.

### 7.2 Pairing (`lib/derive/pairing.ts`)

- A `ShiftEnd` Out pairs like any Out: status `done`, counted in every time and count.
- `core.station_intervals.end_event` (#13 §8.2; if #16 comes first it adds `end_event`, and #13 step 11
  adds `start_event`). A `ShiftEnd` pass has `end_event = 'shift_end'`. `PairedInterval.autoStopped`
  is `endEvent === 'shift_end'`.
- The late Out rule of §4.6, the same as the station's, in the shared vectors.
- A `Mark` / `ShiftEnd` closes a pause like any `Mark` (#13's rule reads any `Mark`).
- **Visits**: a pass that starts after a `ShiftEnd` end of the same element at the same station
  continues that visit, like a `Resume` (#13 §8.2). **Decision:** not rework. Why: it is the same work
  going on the next day; the 60 minute shift-time pause rule already joins most of them, this makes it
  sure.

### 7.3 Times

- The pass ends at the shift end, so wall clock and working time both lose the night. Nothing else to
  change.
- **Decision:** no capping of missing scan-outs of the read model's own. Why: the station writes the
  end from OptiCloud's shifts; a second rule in the portal on its own calendar could disagree. The
  `stale` (36 h) and `superseded` reasons stay as the safety net for stations without shifts and PCs
  that were off.

### 7.4 Lists and pages

- `rpt.missing_scan_outs` / `listMissingScanOuts` (`lib/reports/lists.ts`, reports.md §7): auto-stopped
  passes are listed too, as forgotten scan-outs that were caught. `MissingScanOut` gains
  `kind: "missing" | "auto_stopped"` and `endAt`. The reason shows `Stoppet ved vagtskifte 14:00`
  for them, the old reasons for the others. They count in times; the list says so.
  **Decision:** one list with a kind, not a new list. Why: Ventisol wants to see who forgets to scan
  out, caught or not, in one place.
- `components/stations/missing-scan-outs.tsx`: the kind as a grey chip `Auto-stop` beside the red
  `Mangler ud-scanning`.
- `components/orders/order-tables.tsx` and `components/stations/passes-table.tsx`: a pass ending with
  `shift_end` shows its end time with `(vagtskifte)` after it.
- Stationer day row: the number of auto-stops that day (`station_day_facts.auto_stopped_count`).
- Chat: the order and station tools report `autoStopped`; the prompt says the end time of such a pass
  is the shift end, not a scan.
- `lib/export/columns.ts`: an `Auto-stop` column (Ja/Nej) on the passes export.

## 8. Open questions

For Ventisol:

1. Grace 60 minutes: right? Shorter catches more, longer keeps more overtime.
2. Overtime: an element started after the shift and left alone gets zero time (stopped at its own In).
   Acceptable, with the countdown and `Arbejder videre`?
3. Are the stations' machines in OptiCloud set up with the real shifts (06:00 to 14:00?), and do you
   work two shifts or nights anywhere?
4. The next morning's scan of an auto-stopped element starts it again. Is that what the operator
   expects, or should the first scan the next day on an auto-stopped element do nothing but show the
   message?
5. Who should see the auto-stops: only the portal list, or also a daily mail to the foreman?

For the OptiCloud backend owner:

1. What does `ExternalGetMachineShiftByMachineId` return: the shape, `day` as number or name, and does
   it include shifts that come from shift templates, and skipped shifts (`skipMachineShifts`)?
2. If machines get shifts from templates, which call gives the effective shifts of a machine for a
   date range (`GetTemplatesByMachineId`, `GetShiftTimeLine`, `GetNextShift`)?
3. Is a break inside a shift modelled as two shifts, or as something else we should read?
4. When our clear (`SetOrderToMachine` with `""`) arrives after the shift ended, does OptiPeople count
   any of that time on the order? Is there a way to end a run at a given time?
5. Rate limits on reading shifts for 7 machines once an hour: any concern?

## 9. Build steps

Each step is one commit with its tests, in this order. It depends on #13 steps 2 to 4 (classification,
Arbejdsform, the `Event` column). Steps 2 to 7 can ship before Session; the Session parts (step 8) come
with or after #13 step 5.

1. **Shift answer and rules.** Call `ExternalGetMachineShiftByMachineId` in Ventisol's account for
   every mapped machine; save a sample as `docs/api/machine-shifts.sample.json` (no personal data).
   `opticloud-scans.md`: the `ShiftEnd` rows and the late Out rule. `scan-rules-vectors.json`: new cases
   tagged `"needs": "events"`: a `ShiftEnd` Out pairs, a late Out within 12 h replaces it, a late Out
   after 12 h is skipped, a `Mark` / `ShiftEnd` closes a pause, the next In after a `ShiftEnd`.
2. **`ScanEventKind.ShiftEnd`.** The value in `ScanEvent`, `ScanJson`, round trips. Tests: a `ShiftEnd`
   Out and `Mark` round trip, an old reader's view (unknown reads as `Scan`).
3. **Schedule.** `MachineShiftRow`, `GetMachineShiftsAsync`, `ShiftSchedule.From` and `Standard`,
   `Spans` (joined, over midnight, skip dates, clock change). FakeOptiCloud endpoint. Tests: the saved
   sample parses; Monday 22:00 to Tuesday 06:00 is one span; 06:00 to 10:00 and 10:30 to 14:00 join; spring and
   autumn nights; a skipped date; an empty answer.
4. **The rule.** `ShiftEndRule.Evaluate`, `StopId`, `ShiftEndActivity`. Tests: nothing after E stops at
   E, due at E + G; a scan at E + 25 min stops at E + 25 min, due at E + 85 min; the next span before
   `x + G` stops nothing; weekend activity; "Max i gang" 3 stops all at one `x`; `StopId` stable.
5. **Replay.** `WorkRecord.EndEvent`, the late Out rule, `ReplayResult.AutoStopped`, `InScanId` on
   `ActiveElement`. Lift the vector tag in `ScanRulesVectorsTests`. Tests: restart after a stop; the
   late Out cases; a stop then an In next morning.
6. **Settings and Opsætning.** `StationSettings` fields, JSON, `SetupRules` texts, `MachineShifts`
   loop with `shifts.json`. Tests: old file reads defaults; grace clamped; source texts per case.
7. **Writing and the screen.** `MainWindow` tick, the §4.3 check, `MainViewModel.ShiftEnd`,
   `StopReason.ShiftEnd`, tile band, countdown, `Arbejder videre`, idle line, `Startet igen`,
   catch-up on start, viewer from rows. Tests: view model texts per state; catch-up writes the
   back-dated rows in order; no write before the rebuild; no write when OptiCloud has an Out; derived
   id refused on the second write against `FakeOptiCloud`; the machine order cleared after the stop
   (`MachineOrdersTests`).
8. **Session.** `SessionWorkflow.ShiftEnd`: Outs for running, `Mark`s for paused, state Idle.
   With or after #13 step 5. Tests: running and paused sessions at a shift end; a card in the grace
   period is activity.
9. **Portal raw scans and pairing.** `event` (if #13 step 10 is not in), `ShiftEnd`, `end_event`
   (if #13 step 11 is not in), `autoStopped`, the late Out rule, the visit rule. Lift the vector tag in
   `pairing.test.ts`. Tests: the vectors; next-morning pass is visit 1.
10. **Portal lists and pages.** `rpt.missing_scan_outs` with `kind` and `end_at`, `listMissingScanOuts`,
    the tables, `auto_stopped_count`, export column, chat tools. Tests: `lists.test.ts` with an
    auto-stopped pass; `export.test.ts`; the tools' output.
11. **Docs and rollout.** `apps/station/README.md` (Vagtslut in Opsætning, the tile), `read-model.md`
    (§2 the new end, visits), `reports.md` (`listMissingScanOuts`), and the lines of #13 named in §4.8.
    Release, check the source text per station in Opsætning on site, and watch one shift end.

## 10. Test plan

- **Unit, station app**: steps 2 to 8. The existing tests stay green with `Stop ved vagtslut` off and
  with stations that have no shifts: that is the proof nothing else changed.
- **Unit, portal**: steps 9 and 10. Existing tests stay green on rows without `Event`.
- **Shared vectors**: the cases of step 1 in both suites, so the station and the portal agree on where
  a pass ends.
- **Against FakeOptiCloud**: one scan PC and one viewer, grace 1 minute in a dev build, a fake shift
  ending in 2 minutes. Scan an element in; wait: the row in `/fake/state` is an Out with
  `Event = ShiftEnd`, `ScanTime` at the shift end, the machine's order cleared, the viewer's tile idle
  with `Stoppet ved vagtskifte`. Again with a scan in the grace period: the stop moves to that scan.
  Again with the scan PC closed over the shift end and started after: the catch-up row has the same
  times. Start a second scan PC on the same data: no second row (the derived id).
- **Old readers**: the last released app as a viewer on the same data: it starts, shows the element
  done at the shift end, and skips the `Mark`.
- **Clock change**: unit tests only (the last Sunday of March and of October, a night shift).
- **On site**: one shift end with Ventisol, a station left with an element on purpose. Check the next
  morning: the portal shows the pass ending at 14:00 in the missing scan-outs list as `Auto-stop`, and
  the order did not run over night.
