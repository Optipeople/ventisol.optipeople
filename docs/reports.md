# The report layer: what pages and the chat read

Pages and the AI chat read numbers through `apps/web/lib/reports` only. Each
wrapper there calls SQL functions in the schema `rpt`
(`supabase/migrations/20261116130000_rpt.sql`) and returns a typed object
(`apps/web/lib/reports/types.ts`). No page and no chat tool writes SQL.

How the stored numbers are counted is in [read-model.md](read-model.md). This
file says what each report function returns, which definition is behind each
number, and who may call it.

## 1. Rules for every function

**Access.** Every wrapper is `fn(claims, params)` and runs in `withUser`, so
row level security applies. The wrapper checks the capability first
(`ReportAccessError`), and the database checks the role again:

| Group | Capability | Roles | Check in the database |
|---|---|---|---|
| Reports | `reports.view` | admin, ledelse, planner, viewer | row level security |
| Calculated against measured | `costs.view` | admin, ledelse, planner | `rpt.require_role('admin','ledelse','planner')` |
| Ledelse | `ledelse.view` | admin, ledelse | `rpt.require_role('admin','ledelse')` |

`rpt.require_role` raises `insufficient_privilege` (42501). The wrappers turn
that into `ReportAccessError` too. A viewer never receives a calculated time:
only `getCalcVsMeasured` and the month report carry them, and both are closed
to viewer in the wrapper and in the database. `access.test.ts` scans every
result a viewer can reach for the word "calculated".

A user of another account gets empty results from the open functions and is
refused by the checked ones.

**SQL.** All `rpt` functions are `stable`, `security invoker` and have
`set search_path = ''`. The one exception is `rpt.order_documents` (section
5). Execute is granted to `authenticated` only. Values are always parameters.
The two list functions take a sort key, and the column is picked from a fixed
list inside the function. Anything else falls back to the default sort. The
wrappers also refuse unknown sort keys with zod before the database is asked.

**Periods.** A period is `from` and `to` as Copenhagen days (`yyyy-MM-dd`),
both included. An order belongs to the day it was packed
(`core.orders.packed_local_day`), a pass to the day it ended
(`core.station_intervals.local_day`). An order packed 23:30 on the last day is
in, one packed 00:10 the day after is not. See read-model.md section 1.

**The previous period** is the period of equal length right before:
1 to 31 October compares with 31 August to 30 September. The Ledelse functions
compare a calendar month with the calendar month before instead.

**Now.** No function reads the clock. Functions that need "now" take
`now` (epoch milliseconds) and pass it to SQL as `p_now`.

**Two clocks.** Every duration is a `Duration`:
`{ seconds, wallSeconds, workingSeconds }`. `wallSeconds` is clock time,
`workingSeconds` counts only time inside the shifts (read-model.md section 3).
`seconds` is the headline: working time when the setting `deduct_off_shift` is
on, wall time otherwise. The `clock` parameter (`"working"` or `"wall"`)
overrides the setting. The result says which clock it used in `clock`.

**No data is null.** An empty period gives `null` averages and percentages,
never zero. Counts are 0. Percent changes are whole numbers,
`onTimePercent` has one decimal.

## 2. Overblik (`overview.ts`)

### `getPeriodKpis(claims, { from, to, clock? })`: `PeriodKpis`

SQL: `rpt.period_kpis` for the period and for the previous period. Any role.

- `ordersPacked`, `elementsPacked`: orders with `status = 'packed'` packed in
  the period, and their packed elements (read-model.md section 4, Packed).
- `lead`, `work`, `wait`: averages over those orders of lead time, time at
  stations and waiting (section 4, Lead time, work and waiting).
- `onTimePercent`: on time orders out of orders with a known deadline
  (`onTimeOrders` of `onTimeKnown`). Orders without a delivery week are left
  out of both (section 4, On time).
- `change`: `leadPercent`, `waitPercent`, `ordersPercent` against the previous
  period, `onTimePoints` in percentage points. Null when either side is null.

### `getLeadTimeSeries(claims, { from, to, bucket, clock? })`: `LeadTimePoint[]`

SQL: `rpt.lead_time_series`. `bucket` is `"week"` (ISO weeks, Monday start) or
`"month"`. One point per bucket that touches the period, empty buckets
included with null durations. Only orders packed inside `from` to `to` count,
so a week cut by the period holds only its days inside. Any role.

### `getBottleneck(claims, { from, to, clock? })`: `Bottleneck`

SQL: `rpt.step_times` and `rpt.station_performance`. Any role.

- `steps`: the seven steps in route order with the average `duration`, `work`
  and `wait` per order (read-model.md section 5). `source` says where the
  step's time comes from, `"none"` means not measured yet.
- `lead`: the sum of the step averages that count in the lead time. It equals
  `getPeriodKpis().current.lead` (tested on both clocks).
- **The bottleneck rule:** the measured step with the largest average waiting
  on the headline clock. A tie goes to the earlier step. Steps without data
  are skipped and named in `missingSteps`. `bottleneck` is null when no order
  was packed or nothing waited. `sentence` says it in Danish.
- `stations`: per station the passes and the average wait in front of it.

### `getTodayStrip(claims, { now, activeDays? })`: `TodayStrip`

SQL: `rpt.today`. The day is the Copenhagen day of `now`. Orders in progress,
of them active in the last `activeDays` (14), at risk (read-model.md section
4, In progress), packed today, passes and elements today, stations running
now and stations in total. Any role.

### `getKpiSummary(claims, { from, to, now, clock? })`: `KpiSummary`

One answer for the overview page and the chat: `kpis`, `bottleneck`, `today`,
the stations to look at today, and `ordersToWatch` (in progress and late or at
risk, at most five, with `ordersToWatchTotal`). Same numbers as the single
functions (tested). Any role.

## 3. Stationer (`stations.ts`)

Normal time, deviation and status are applied at read time, with the settings
in force (read-model.md section 7, Normal, deviation and status).

### `listStations(claims)`: `StationInfo[]`

SQL: `rpt.stations`. Active stations in sort order with kind, Danish kind
label, normal times per element type and `maxOpen` ("Max i gang",
`config.stations.max_open`, 1 unless set). Any role.

### `getStationDay(claims, { day, clock? })`: `StationDayReport`

SQL: `rpt.station_day`. One `StationRow` per active station:

- `countThrough`, `elementsThrough`, `reworkPasses`, `openCount`,
  `missingScanOutCount` from `core.station_day_facts` (section 7).
- `timePerPiece`: the median pass time, in split time (read-model.md §2,
  Split time: at a station with several elements in progress at once each
  pass counts its share). `meanPieceSeconds` is the mean. Utilisation, busy
  time and standstill stay wall clock.
- `normalSeconds` and `deviationPercent`: the normal time weighted by the
  day's element types, and the headline time per piece against it.
- `standstillSeconds`, `gaps`, `utilisationPercent`, `availableSeconds`,
  `observedSeconds`, `busyInShiftSeconds`: section 7.
- `status` and `statusLabel`: `normal`, `slower`, `stood_still`,
  `long_dwell` or `no_data`.
- A station without scans that day is a row with `hasData: false`, status
  `no_data` ("Ingen data endnu") and null numbers.

`attention` is "N stationer afviger fra det normale": the stations with data whose status is
`slower`, `stood_still` or `long_dwell`. Any role.

### `getStationPerformance(claims, { from, to, stationNo?, clock? })`: `StationPeriodReport`

SQL: `rpt.station_performance`. The same row over a period: counts summed,
median and mean over all passes that ended in the period, `daysActive`.
`isComplete` is null for a period. Any role.

### `getStationDetail(claims, { stationNo, day, weeks?, clock? })`: `StationDetail`

SQL: `rpt.station_day`, `rpt.station_timeline`,
`rpt.station_type_distribution`, `rpt.station_performance` per week. The
station's row for the day, the day's passes (`timeline`), the spread of pass
times per element type over the last `weeks` ISO weeks (12) ending with the
week of `day` (`distribution`, with min, quartiles, median, max, in split
time), and the weekly `trend` against normal. Each timeline pass has
`duration` (wall clock) and `split` (its share of the station's time; the
same as `duration` when it was alone, up to now while open). A station that is not configured comes back as
a placeholder with `configured: false`. Any role.

## 4. Ordrer (`orders.ts`)

### `listFinishedOrders(claims, { search?, from?, to?, status?, sort?, dir?, page?, pageSize?, clock? })`: `Paged<FinishedOrderRow>`

SQL: `rpt.orders_finished`. Packed orders, newest packed first.

- `search` matches the start of the order number, or any part of the customer
  or the case name, without regard to case. `%` and `_` are plain characters.
- `status`: `on_time`, `late`, `unknown` (no delivery week).
- `sort`: `order`, `customer`, `elements`, `start`, `packed`, `lead`, `wait`,
  `status`. `lead` and `wait` sort on the headline clock.
- `total` is the number of matches before paging. A page past the end has no
  rows and still the total. `pageSize` is at most 200.

Any role.

### `listInProgressOrders(claims, { now, search?, status?, sort?, dir?, activeDays?, page?, pageSize?, clock? })`: `Paged<InProgressOrderRow>`

SQL: `rpt.orders_in_progress`. Orders not packed, newest started first. Where
the order is (`currentStep`, `currentStationNos`, `currentLabel`), time so far
(`elapsed`, split in `work` and `wait`), the forecast and `atRisk`
(read-model.md section 4, In progress).

**Delivery status of an order in progress:** `late` when the deadline has
passed, else `at_risk` when the forecast lands after the deadline, else
`on_time` when the forecast is inside, else `unknown`. `sort`: `order`,
`customer`, `elements`, `start`, `elapsed`, `forecast`, `due`, `last_scan`.
`activeDays` keeps only orders scanned in the last N days. Any role.

### `findOrders(claims, { query, limit? })`: `FoundOrder[]`

SQL: `rpt.find_orders`. For the search field and the chat. Exact order number
first, then numbers that start with the digits, then customer and case name.
`match` says which. An empty query finds nothing. Any role.

### `getOrderDetail(claims, { orderNo, now, clock? })`: `OrderDetail | null`

SQL: `rpt.order_detail` (one jsonb object: the order, its steps, elements and
passes) and `rpt.order_documents`. Null when the order does not exist.

- `order`: the `core.orders` row with `lead`, `work`, `wait` or `elapsed` as
  durations, `currentLabel`, delivery status and label.
- `steps`: the seven steps (section 5) with `deviation: true` where a note
  points at the step.
- `elements`: section 6, with `pathLabels` (the stations in order).
- `intervals`: every pass with duration, wait before, the normal time for the
  station and element type, and `deviationPercent` against it.
- `notes` and `notesHeadline`: the deviation notes below.
- `documents`: section 5 of this file.

**Deviation notes.** Each note has a `severity`, a `code`, a Danish `text`
and, where it applies, step, station, barcode and seconds.

| Code | Severity | When |
|---|---|---|
| `packed_late` | problem | packed after the deadline (`on_time` false) |
| `deadline_passed` | problem | in progress and the deadline has passed |
| `forecast_late` | watch | in progress and the forecast lands after the deadline |
| `missing_scan_out` | problem | a pass was scanned In and never Out |
| `rework` | problem | an element came back to a station it had left |
| `long_wait` | problem | an element waited longer than `long_dwell_threshold_minutes` before a station |
| `slow_pass` | watch | a finished pass took more than `slow_threshold_percent` over the normal time |
| `missing_elements` | watch | something is packed and a position on the 3E list is not fully packed |

The headline is "Her gik det galt" with at least one problem, "Hold øje med"
with only watch notes, and "Ingen afvigelser" with none. A pass that lies
wholly outside the shifts has zero working time. It is not compared with the
normal time on the working clock (`deviationPercent` null).

Any role.

### `getOrderStatus(claims, { orderNo, now, clock? })`: `OrderStatusSummary | null`

The short answer for the chat: where the order is, element counts, delivery
status, forecast, time so far or lead time, and the notes. Any role.

### `getOrderRoute(claims, { orderNo, now, clock? })`: `OrderRoute | null`

The route for the chat: the seven steps, every pass, and the notes. Any role.

## 5. Order documents

### `getOrderDocuments(claims, { orderNo })`: `OrderDocumentInfo[]`

SQL: `rpt.order_documents`. The 3E documents of one order, newest print date
first: file name, prefix, print date, blob reference and name, content type,
size, when it was synced and parsed, and from the parsed content only
`pageCount`, `header`, `positions` and `problems`.

Users have no access to `raw.order_documents`: the table is for the sync
alone. This function is therefore `security definer`, and it is the only one
in `rpt`. It is kept narrow:

- it checks `app.has_role('admin','ledelse','planner','viewer')` itself and
  raises `insufficient_privilege` otherwise, so another account is refused;
- it takes one order number and returns the documents of that order only;
- it returns a fixed list of columns, not the row (no hash, no device);
- `search_path` is pinned to empty and every name is schema qualified.

The sync writes nothing new for this: the function reads what
`raw.order_documents` already holds. Any role.

## 6. Ledelse (`management.ts`)

### `getCalcVsMeasured(claims, { from, to, elementTypeId?, stationNo?, clock? })`: `CalcVsMeasured`

SQL: `rpt.calc_vs_measured`. Roles admin, ledelse and planner.

- `rows`: one per station and element type with a calculated time in
  `config.calculated_times`: `calculatedSeconds`, the normal time, the number
  of finished passes that ended in the period, `measured` (the median pass
  time in split time, both clocks), `deviationPercent` of measured against calculated, and
  `flagged` when the deviation is over
  `calculation_deviation_threshold_percent` in either direction.
- `byElementType`: per element type the sum of the calculated times and the
  sum of the measured medians over the stations that have both
  (`stationsCompared`). `stationsIncomplete` counts stations with a calculated
  time and no passes.
- No passes in the period: `measured` and `deviationPercent` are null and the
  row is not flagged.

### `getManagementKpis(claims, { month, clock? })`: `PeriodKpis`

The KPIs of section 2 for a calendar month against the calendar month before.
`month` is `yyyy-MM` or any day of the month. Roles admin and ledelse.

### `getMonthlyLeadTime(claims, { month, months?, clock? })`: `LeadTimePoint[]`

Lead time month by month, `months` (12) points ending with `month`. Roles
admin and ledelse.

### `getMonthReport(claims, { month, now, live?, clock? })`: `MonthReportResult`

SQL: `rpt.month_report` (one jsonb object with the raw parts) or
`rpt.snapshots`. Everything the monthly report shows: settings, KPIs against
the month before, twelve months and the weeks of the month, the bottleneck,
the station table, calculated against measured, the notes and the number of
missing scan outs.

A frozen month is read from its snapshot (`frozen: true`) and no longer moves
when facts change. `live: true` computes it from the facts anyway. Roles admin
and ledelse.

### `listSnapshots(claims)`: `SnapshotInfo[]` and `getSnapshot(claims, { month })`: `MonthReportResult | null`

The frozen months, newest first, and one of them. Roles admin and ledelse.

### `freezeMonth(month, now, { force? })`: `FreezeResult`

For the cron job, not for users: it takes no claims and runs as service. It
writes the month report into `rpt.snapshots`. A month that is frozen already
is left alone (`written: false`) unless `force` is set. It writes no audit
row, since there is no user. A page that lets a user freeze a month must check
the role and write the audit row itself.

### `getManagementNotes(claims, { month })` and `saveManagementNotes(claims, { month, highlights, decisions, now })`: `ManagementNotes`

"Det vigtigste" and "Til beslutning" of one month in `rpt.management_notes`.
At most 20 lines each, 1 to 1000 characters a line. Saving replaces the notes
of the month and writes the audit row `management_notes.saved` in the same
transaction. Roles admin and ledelse.

## 7. Lists and chat questions (`lists.ts`)

All open to any role. None of them carries a calculated time.

### `listMissingScanOuts(claims, { from?, to?, page?, pageSize? })`: `Paged<MissingScanOut>`

SQL: `rpt.missing_scan_outs`. Passes scanned In and never Out
(read-model.md section 2, the missing scan-out), newest first, with the
reason in Danish. The period is on the local day of the In scan.

### `listIncompletePackedOrders(claims, { now, quietHours?, page?, pageSize? })`: `Paged<IncompletePackedOrder>`

SQL: `rpt.incomplete_packed_orders`. Orders where something is packed, a
position on the 3E list is not fully packed, and nothing was scanned for
`quietHours` (12). `missingElements` lists the positions with expected, seen
and packed.

### `getBaselineSuggestion(claims, { from, to, minSamples?, clock? })`: `BaselineSuggestion`

SQL: `rpt.baseline_suggestion`. Per station and element type: the number of
finished passes that ended in the period, median (the suggestion), mean,
quartiles (all in split time) and the normal time in force with its source. Pairs with fewer than
`minSamples` (5) passes are left out. `weeks` is the length of the period.

### `getCapacityPlan(claims, { day })`: `CapacityPlan`

SQL: `rpt.capacity_plan`. The portal gets no planned orders from 3E yet, so
the answer is `available: false` with a Danish message and what is known: the
shift time of each day of the week, closed days, the number of assembly
stations and the orders in progress due that week.

### `getStaffingAnalysis(claims, { from, to, stationNo?, clock? })`: `StaffingAnalysis`

SQL: `rpt.staffing`. Staffing per station is not recorded anywhere, so the
answer is `available: false` with a Danish message and what is known: count
and time per piece per station per day. `people` is null.

## 8. The chat registry (`index.ts`)

`REPORT_QUERIES` maps a tool name to a description, the capability, a zod
schema and the wrapper. `runReportQuery(claims, name, input)` is the only way
a tool call reaches a report: an unknown name throws, a missing capability is
`ReportAccessError` (checked before the input is read), bad input is a
`ZodError`. `reportQueriesFor(claims)` lists the names a role may run.

## 9. Timings

Measured by `performance.test.ts` on 2400 packed orders (4800 passes) in
PGlite, second call. PGlite runs in process on one thread, so hosted Postgres
should not be slower.

| Call | Time |
|---|---|
| `listFinishedOrders`, first page, deep page, one month, search | 6 to 11 ms |
| `listFinishedOrders`, sorted by lead time, 200 rows | 17 ms |
| `listInProgressOrders` | 3 ms |
| `findOrders` | 4 to 10 ms |
| `getPeriodKpis`, three months | 5 ms |
| `getLeadTimeSeries`, weeks of three months | 11 ms |
| `getBottleneck`, three months | 39 ms |
| `getStationPerformance`, three months | 21 ms |

Plans: the default finished list walks `orders_packed_at_idx` and stops at the
limit, and passes of a period use `station_intervals_local_day_idx`. Two
things to know:

- The list functions return the total with `count(*) over ()`, so they read
  every match even for one page. That is the cost of a correct total. It is
  small at these volumes.
- The text search is one OR over customer, case name and order number, so it
  reads `core.orders` once. There is no index for it. `EXPLAIN` on a plpgsql
  list function shows only a function scan, so the test explains the inner
  statement.
