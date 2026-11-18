# The read model: how the numbers are counted

The portal's reports and chat read `core.*` in Supabase. Those tables are derived from the raw scans (`raw.scans`) and the 3E documents by pure code in `apps/web/lib/derive`. This file is the definition of every figure: for the next developer, and for answering Ventisol ("how is lead time counted?").

Code: `apps/web/lib/derive`. Tables: `supabase/migrations/20261116110000_core.sql`. The contract around it: `docs/portal-architecture.md`. The scan rules it builds on: `docs/opticloud-scans.md`, "Rules".

When a rule changes, change it here, in the code and in its test in the same commit.

## 1. Ground rules

- **Pure.** `lib/derive` does no I/O and never reads the clock. It takes scans, the order's 3E info, a calendar, parameters and `now`, and returns rows. Same input, same output.
- **Rebuildable.** Every `core.*` row can be thrown away and derived again from `raw.*`. Nothing in `core.*` is edited by hand.
- **Unknown is null.** A figure with no data is `null` and shows as "Ingen data endnu". It is never 0 and never an invented number.
- **Two clocks.** Where it matters a duration is stored twice: `x_seconds` is wall clock, `x_working_seconds` is the time inside the shifts (§3). The setting `deduct_off_shift` picks one at read time. Flipping it needs no rebuild.
- **Days are Copenhagen days.** `local_day`, `start_local_day` and `packed_local_day` are Europe/Copenhagen calendar days, stored as `date`, so SQL never has to convert a time zone.
- Row types in `lib/derive/types.ts` are the tables: camelCase field, snake_case column. `core-migration.test.ts` fails when they drift.

## 2. Pairing: from scans to passes

A **pass** (a row in `core.station_intervals`) is one element at one station from its In to its Out. The rules are those of the station screen and the old reports, and the shared vectors in `docs/scan-rules-vectors.json` run against the read model's pairing (`pairing.test.ts`), with the 36 hour read window and without it.

- Scans pair by station number and barcode, oldest first, an In before an Out at the same time. Each `ScanId` counts once.
- In then Out: a pass with status `done`.
- An Out with no In: the start is put back from `DurationSec` (`start_estimated`). Without `DurationSec` it is skipped.
- A re-scan of the same element at the same station is another pass. Passes are numbered per element and station (`visit`); 2 and up are rework (`is_rework`).
- A scan with no station number gets station 0.

What differs from the old reports: the read model pairs an order's **whole history**, with no read window.

### In progress, and the missing scan-out

An In with no Out is one of two things:

| Status | When | Counts in times |
|---|---|---|
| `open` (in progress) | The In is at most 36 hours old, and it is among the latest open Ins at its station, as many as the station's "Max i gang" (`config.stations.max_open`, 1 unless set) | Yes, up to now |
| `missing_out` | Otherwise | No, never |

`missing_out` has a reason:

- `stale`: older than 36 hours. Parameter `staleOpenSeconds`. Why 36 hours: the same limit as the station app, long enough for an element left overnight to still be in progress next morning.
- `superseded`: a later In took its place. Either the same element was scanned In again at the same station (the later In wins), or the station already has as many later open Ins as its "Max i gang" (at a station with 1: another element is open there).

The old reports dropped these scans silently. The read model keeps them as rows so Indstillinger can list them ("scannet ind, aldrig ud"). They add nothing to any time or count.

### Split time: parallel work

At a station with "Max i gang" above 1 (glazing), one person works several elements at once. Each pass keeps its wall-clock time (`duration_seconds`, `duration_working_seconds`), and also gets its **share** of the station's time: `allocated_seconds` and `allocated_working_seconds`.

- Cut the station's timeline at every start and end of its `done` and `open` passes (an `open` one ends now; `missing_out` takes no share). In each piece, the passes on the station share its length by weight. The working variant shares the piece's shift time.
- The weight is set by `config.settings.parallel_split`:
  - `calculated` (the default): the pass's calculated time at that station (`config.calculated_times` for its station and element type). If any pass in the piece has none, that piece is split equally.
  - `equal`: every pass weighs the same.
  - Not normal times: the Normaltid suggestions come from measured time, so weighing by them would feed them back into themselves.
- A pass alone on its station gets its whole time, so at a station with 1 the split time equals the wall-clock time.
- Rounded to whole seconds per pass.
- The split is worked out per station over time, not per order, so it is made in the station-day rebuild (`replaceStationDays`, `splitStationTime` in `lib/derive/allocate.ts`), from every pass at the station that overlaps the passes of the days rebuilt (they cross midnight, so they are read by time, not by day). An open pass's share moves with the clock; today's station days are rebuilt on every run, so it follows.
- The order rebuild (`replaceOrders`) deletes and inserts an order's passes before the split exists. A pass that is the same as before (same id, start, end and status) gets its old share back there, and a new or changed one is null until the station-day rebuild of the same run, a few milliseconds later. Every run that rebuilds orders also rebuilds the station days their passes lie on (§9, step 7), so a null lasts only while a rebuild that ran out of time waits for the next cron run. A null counts as its wall-clock time everywhere (`coalesce(allocated_seconds, duration_seconds)`).
- **Order touch time** (`core.orders.touch_seconds`, `core.elements.touch_seconds`, `core.order_steps.touch_seconds` of assembly and packing) is the sum of the passes' split time. It cannot be worked out per order, so `deriveOrders` writes the wall-clock sum and the writer puts the split sum over it (`refreshTouch`): after the order rebuild, and again for every order whose passes got a new share in the station-day rebuild. A pass not split yet counts its wall-clock time, an open one up to now. The report functions read the column as before.
- What rebuilds it: a changed "Max i gang" (`onMaxOpenChanged`) or `parallel_split` (`onSettingsChanged`) rebuilds everything; a changed calculated time (`onCalculatedTimesChanged`) does too, but only while the split is `calculated` and some station has "Max i gang" above 1. Indstillinger calls these after the save, with a 5 second budget; the cron run goes on with the rest. The split columns are filled the first time by any full rebuild (Indstillinger, Synkronisering, "Genopbyg"); until then every figure reads the wall clock, as before.
- **Which figures use it:**
  - Split time: time per piece (median, mean, by element type), "Mod normalt" and Langsommere, Kalkule mod målt, Normaltid suggestions, order touch time, a station's pass-time total.
  - Wall clock: busy time, utilisation and gaps (overlap already counts once), lead time, order work time and waiting time.

## 3. Working time

`WorkCalendar`: shift blocks per ISO weekday in Copenhagen wall clock, plus closed days. It maps onto `config.calendar_shifts` and `config.calendar_closed_days`. A break is two blocks.

`workingSecondsBetween(a, b, calendar)` is the shift time between two instants. It is DST safe: a block is turned into real instants per day, so the day shift is 8 hours on both sides of a clock change, and a block that spans the change is an hour longer or shorter in real time.

Choices:

- **Only shift time counts.** Work scanned outside the shifts (overtime) counts on the wall clock but is 0 in working time. Reason: the scans cannot tell overtime from an element left on the table. If Ventisol works regular overtime, the calendar should hold it.
- **A changed calendar needs a rebuild** of the working-time columns (all orders and station days). The `deduct_off_shift` setting does not.
- The default calendar (Monday to Friday 06:00 to 14:00) is the seed, not confirmed by Ventisol (plan §9, question 5).

## 4. Orders (`core.orders`)

One row per order. `core.order_facts` of the first plan is merged into it: both were one row per order and always replaced together.

### Start

`start_at` is the order's first scan (or the estimated start of its first pass, when that is earlier). `start_source` is `first_scan`. When the Schirmer and KMW connectors exist, the start moves back to the first machine event and `start_source` becomes `machine`.

### Packed

- **With a 3E document:** the order is packed when every expected element has a finished pass at a packing station, and nothing on the order is on a station. Expected elements are counted per position (and sub-position): a position with quantity 3 needs 3 different barcodes packed. `packed_source = 'document'`.
- **Without a document** (fallback): packed when every element *seen in a scan* is packed, nothing is on a station, and the order has had no scan for 12 hours (`packedQuietSeconds`). `packed_source = 'scans'` and `expected_source = 'scans'`, so the UI can say "uden produktionsliste". Reason for the quiet time: without the list we cannot know more elements are coming, and the first element is often packed before the last one is first scanned.
- `packed_at` is the last packing Out among the packed elements.
- An element scanned that the document does not list never blocks packed (`in_document = false` on the element).
- A later scan reopens the order: packed is derived, not latched. When the document arrives after the fallback said packed, the order is judged again by the document.
- `missing_elements` lists the document positions not fully packed (`expected`, `seen`, `packed`): the source for "pakket ordre med manglende element".

### Lead time, work and waiting

- **Lead time (Gennemløbstid)** = `packed_at - start_at`. `lead_seconds` on the wall clock, `lead_working_seconds` in shift time. Null until packed.
- `elapsed_seconds` is the same span for an order in progress, up to `computed_at` ("Tid indtil nu").
- **Work (Arbejde)** = the time when at least one element of the order was at a station. Two elements worked on side by side count once.
- **Waiting (Ventetid)** = the rest: `work_seconds + wait_seconds = elapsed_seconds`, always, to the second.
- `touch_seconds` is something else: the sum of all passes in split time (§2, Split time). Two elements at two stations side by side count twice; several elements on one station at once share its time. It is the "time per order" of the station screen and the old reports (which show wall clock only), and the figure to hold against a calculated time.

### On time (Leveret til tiden)

`due_at` is the first instant that is too late: the end of the target week, Copenhagen time. `on_time = packed_at < due_at`. Null until packed, and null without a delivery week.

- Target week = Lev. uge + `onTimeWeekOffset` weeks. Default 0. Set -1 if Ventisol says the shipping week is the target.
- `onTimeGraceDays` days are added after the end of the week. Default 0. Maps to `config.settings.late_threshold`.
- The 3E list carries a week but may not carry a year: without `deliveryYear` the year whose week lies nearest the order's first scan is used.
- Open with Ventisol (plan §9, question 2): Lev. uge or shipping week, and whether "delivered" is the last packing scan. That is why both are parameters.

### In progress: where it is, and the forecast

- `current_station_nos`: the stations with an element of the order on them now. `current_step`: the step the order is in. `currentLabel()` turns the two into "Er nu ved" (station names, else "Montage, venter" or "Venter før pakning").
- **Forecast v1 is an estimate** (`forecast_ready_at`, "Forventet klar"). For every element not packed, take the typical time at each station it still has to pass, and add up per station. Stations work side by side, so the order needs the largest of those loads, plus one typical piece time at every other station still in play, plus the typical wait before packing while packing has not begun. That many shift seconds from now is the answer.
  - With a document, elements not yet scanned are included (`forecast_basis = 'document'`). Without one it can only speak for the elements seen (`'seen_elements'`), and the UI should say so.
  - Typical times are an input (per station, optionally per element type, with the share of elements that pass the station). No typical times, no forecast.
  - It does not know about other orders queueing at the same stations. It will be optimistic on a busy day.
- `at_risk`: the deadline has passed, or the forecast lands after it. Null when neither can be said.

## 5. The route (`core.order_steps`)

Always seven rows per order, in this order:

| seq | step | Label | Kind | Source today |
|---|---|---|---|---|
| 1 | `schirmer` | Schirmer | work | `none`, or `assumed` when `schirmerAssumedSeconds` is set |
| 2 | `wait_kmw` | Venter før KMW | wait | `none` |
| 3 | `kmw` | KMW-anlægget | work | `none` |
| 4 | `buffer` | Buffer | wait | `none` |
| 5 | `assembly` | Montage | work | `scans` |
| 6 | `wait_packing` | Venter før pakning | wait | `scans` |
| 7 | `packing` | Pakning | work | `scans` |

- Steps 1 to 4 have no data until the machine connectors exist (plan §7). Their durations are null. An assumed Schirmer time is marked `source = 'assumed'` (show as "antaget") and has `counts_in_lead = false`: **the measured lead time never contains an assumed number.** The UI may show steps 2 to 4 as one span "Før montage".
- **The steps with `counts_in_lead` add up to the order's lead time** (to `elapsed_seconds` while in progress), on both clocks, to the second. Seconds are rounded so the parts keep the sum (`roundParts`).

### How the time is split

Every instant between start and packed goes to exactly one step:

1. An element of the order is at an assembly station: **Montage**, as work.
2. Else an element is at the packing station: **Pakning**, as work.
3. Else nothing on the order is being worked on. If assembly work still lies ahead, it is **Montage**, as waiting. Otherwise it is **Venter før pakning**.

So:

- **Overlap:** when the first elements are being packed while the last is still being assembled, that time is Montage. Assembly wins. Reason: one rule, and the order is not "in packing" while it still needs assembly. Packing gets the packing time that assembly did not take.
- Idle time between two elements in assembly is waiting *inside* Montage (`wait_seconds` on the assembly row). It is not called Buffer: the buffer is a machine step with no data yet.
- "Assembly work still lies ahead" means: a later assembly pass exists, or (for an order in progress) not every expected element has been through assembly. An element that reached packing counts as through assembly, also when an assembly scan was missed.
- Because steps can interleave, `duration_seconds` is the time counted to the step and can be less than `end_at - start_at`. A Gantt should draw `start_at` to `end_at` and print `duration_seconds`.
- A step not reached yet has null durations. `is_open` marks the step the order is in now.

## 6. Elements (`core.elements`)

One row per barcode seen in a scan. Elements on the 3E list that were never scanned have no row (they show in the order's `missing_elements`).

- `station_path`: station numbers in the order visited, one entry per pass, so rework shows as a repeat.
- `total_seconds`: first In to last Out of its passes (to now while one is open). `touch_seconds`: the sum of its passes, in split time.
- `element_type_id`, `system`, `width_mm`, `height_mm` come from the document line of its position. Null without a document.
- `assembled_at`: its last assembly Out. `packed_at`: its last packing Out, null while it is on a station.

## 7. Stations (`core.station_day_facts`)

One row per station per Copenhagen day with activity. A day with nothing has no row (so an unused station does not read as standing still).

- **Gennem i dag** (`count_through`): finished passes that **ended** that day. A pass over midnight counts on the day it ends, as on the station screen. `elements_through` is the distinct elements.
- **Tid pr. stk.** (`time_per_piece_seconds`): the **median** pass time, in split time (§2, Split time). Why not the mean: one element left on the table over a break or a night would move the mean of the whole day, and "foreslå fra baseline" is a median too. The mean is stored beside it (`mean_piece_seconds`). For a period longer than a day, take the median from `core.station_intervals`, not the average of daily medians.
- `available_seconds`: the shift time of the day. `observed_seconds`: the shift time so far (today).
- `busy_seconds`: time with an element on the station inside the day. `busy_in_shift_seconds`: the part inside the shifts. Utilisation = `busy_in_shift_seconds / observed_seconds`.
- **Stod stille:** the station's **gaps** are the stretches of shift time with no element on it. `gaps` stores each gap of at least 5 minutes (`gapFloorSeconds`) with its start and end. "Stod stille" is the **sum of the gaps of at least the standstill threshold** (15 minutes, `config.settings.standstill_threshold_minutes`), applied at read time. No such gap shows as "Ingen".
  - Why a sum of long gaps and not all idle time: a scan station is idle for a moment between every two elements, so total idle time is never "Ingen" and says little. Why not only the longest gap: three stops of 20 minutes are an hour lost.
  - The gaps are watched **from the station's first scan of the day to the end of the shift** (to now, today). The time before the first scan is not a standstill (a station opened later is a staffing choice); the time after the last scan is (a station that stopped at 10 stood still). Both are parameters: `standstillCountBeforeFirstScan`, `standstillCountAfterLastScan`.
  - Breaks: model them as two shift blocks, or every lunch is a standstill.
- `longest_wait_before_seconds`: the longest time an element waited between its previous Out (any station) and its In here. The source for "Lang liggetid".
- `by_element_type`: count, median and mean per element type, for comparing with normal times.

### Normal, deviation and status: at read time

Nothing that depends on a setting is stored. `stationStatus(facts, normalSeconds, thresholds)` gives "Normalt", "Mod normalt" and the status label, so changing a normal time or a threshold needs no rebuild.

- "Mod normalt" = (time per piece - normal) / normal, in percent. `normalForMix()` weighs the normal times of the element types by how many of each went through.
- One status, the most pressing first:
  1. **Stod stille**: there is a gap of at least the standstill threshold.
  2. **Lang liggetid**: an element waited longer than `long_dwell_threshold_minutes` before this station.
  3. **Langsommere**: time per piece is more than `slow_threshold_percent` over normal.
  4. **Normal**.
- No facts row (a machine with no connector): "Ingen data endnu".

## 8. Empty for now

`core.batches`, `core.batch_elements` and `core.machine_events` exist with their access rules and are empty. They are shaped for plan §7: a batch with its elements, and one row per machine event or run (Schirmer start and stop, KMW welding, corner cleaning, buffer in, out and fill level) with a `source_id` so a re-sent event is recognised. Connector work fills them; then `deriveOrders` gets the machine events as one more input and fills steps 1 to 4.

## 9. Keeping `core.*` right (for the writer in `lib/sync`)

On every run, after new rows have landed in `raw.scans`:

1. `plan = affectedBy(newScans)`. It goes by scan time, so a scan sent late with an old time names the old day.
2. Orders to rebuild = `plan.orderNos`, plus every order in `core.orders` where `needsClockRefresh(order, now)` (in progress and scanned within 14 days: its time so far, open passes and forecast move with the clock), plus every order whose 3E document was parsed or changed since the last run.
3. Read the old `core.station_intervals` rows of those orders. Keep them for step 7.
4. Load **all** `raw.scans` rows of those orders (the whole history, not just the new ones), and their `OrderInfo` from the parsed documents.
5. `otherOpenInsByStation`: per station, the `start_at` of every `open` row in `core.station_intervals` belonging to an order **not** in the set (at most "Max i gang" per station), and `maxOpen`: `config.stations.max_open` of the stations set above 1. Then `deriveOrders(scans, infos, { now, calendar, params, typical, maxOpen, otherOpenInsByStation })`. An open In is superseded when its station already has `max_open` later open Ins, of this set and of the others together; on a tie in time the In of this set stays open.
6. In one transaction per order: `delete from core.orders where order_no = $1` (elements, intervals and steps cascade), then insert `order`, `elements`, `intervals`, `steps` in that order. `insertSql()` in `rows.ts` builds the statements.
7. Station days to rebuild = `mergeStationDays(plan.stationDays, stationDaysTouched(oldRows, now), stationDaysTouched(newRows, now))`, plus today for every station (today's row moves with the clock). The old rows matter: a pass that moved or vanished must leave the day it used to lie on.
8. For each station day: load the station's `core.station_intervals` rows that touch the day (`station_no = $1 and start_at < dayEnd and (end_at >= dayStart or end_at is null)`), call `deriveStationDay`, and upsert the row, or delete it when the result is null.

Also:

- **Nightly reconcile** (plan §3.4): a scan row that changed or vanished in OptiCloud is handled like a new one: pass the old and the new version to `affectedBy`.
- **Full rebuild**: truncate `core.orders` (cascades) and `core.station_day_facts`, derive every order, then every station day found by `stationDaysTouched` over all rows. Needed after a change of calendar, of `staleOpenSeconds`, `packedQuietSeconds`, the on-time parameters or the gap floor, of a station's "Max i gang", of `parallel_split`, and of a calculated time while the split weighs by them.
- Step 8 also makes the split time (§2, Split time) of the passes it reads, and brings the touch times of their orders in line.
- Typical times for the forecast: the median pass time per station (and element type) over the last weeks, from `core.station_intervals`.

## 10. Parameters

| Parameter | Default | Changes |
|---|---|---|
| `staleOpenSeconds` | 36 hours | When an In with no Out stops being in progress |
| `packedQuietSeconds` | 12 hours | Fallback packed rule without a document |
| `onTimeWeekOffset` | 0 | Target week relative to Lev. uge |
| `onTimeGraceDays` | 0 | Days after the target week before late |
| `schirmerAssumedSeconds` | null | Assumed Schirmer time, shown as "antaget" |
| `gapFloorSeconds` | 5 minutes | Smallest gap stored per station day |
| `standstillCountBeforeFirstScan` | false | Whether the time before the first scan can be a standstill |
| `standstillCountAfterLastScan` | true | Whether the time after the last scan can be a standstill |

Read-time thresholds (`StationThresholds`): `slowPercent` 20, `standstillMinGapSeconds` 15 minutes, `longDwellSeconds` 480 minutes, `useWorkingTime` true. They mirror the seeds in `config.settings`.
