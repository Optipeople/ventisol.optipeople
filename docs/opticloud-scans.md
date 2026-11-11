# Scans in OptiCloud

Every scan-in and scan-out at a Ventisol station is one row in a master-data table in the
Ventisol account in OptiCloud. The station app writes the rows; the station app (on restart and
in viewer mode) and the reports site read them. OptiCloud stays the single source of truth.

## Why a master-data table, not ItemScan

`ItemScan` (`/api/ItemScan/*`) was looked at first. It does not fit:

- `itemId` is the uuid of a row in the account's Items table (products/articles). Each physical
  element (12-digit label) would have to become an Items row first.
- It has no scan time (the server stamps arrival) and no in/out direction.
- It looks built for "which item is loaded on this machine now" (the dashboard Item scanner
  widget, OP-5764), and no client calls it yet.

A master-data table holds exactly what we need, takes a scan time from the client (so a scan
can be sent late, after the network was down), and OptiCloud already reports on such tables.

## The table

Name `VentisolScans`, friendly name "Ventisol scanninger". The station app creates it, and any
missing column, on first connect (`MasterData/GetTables`, `CreateTable`, `GetColumns`, `AddColumn`).

| Column | Type (`dataType`) | What |
|---|---|---|
| `ScanId` | String (0), key, unique | uuid made by the station app, so a re-send is recognised (see Writing) |
| `Barcode` | String (0) | the 12 digits, e.g. `058556050103` |
| `OrderNo` | Int (2) | `58556` |
| `Position` | Int (2) | `5` |
| `SubPosition` | Int (2) | `1` (01 is the position itself, as on the label) |
| `Piece` | Int (2) | `3` |
| `Station` | String (0) | station name, e.g. `Station 10`, `Pakning` |
| `StationNo` | Int (2) | scanner/station number 1 to 7 |
| `StationKind` | String (0) | `Assembly` or `Packing` |
| `MachineId` | String (0) | the station's OptiCloud machine id, empty if not set up |
| `Direction` | String (0) | `In` or `Out` |
| `ScanTime` | DateTime (3) | when it was scanned, UTC, ISO 8601 |
| `DurationSec` | Int (2) | on `Out`: seconds since the matching `In`; empty on `In` |
| `Device` | String (0) | the PC that sent it (Windows machine name) |

Rejected scans (a second element while one is in progress, an unknown barcode) are only shown
on the screen and not stored.

No column is required. `DurationSec` is left out of the row on `In`, not sent as null.
`MachineId` is an empty string when the station has no machine.

`MasterDataColumnType` in the swagger has nine values (0 to 8): String, Decimal, Int, DateTime,
Bool, Long, Lookup, Link (7, value `{ name, url }`) and Blob (8, a file, see Files in a list). `GetColumns` may return `dataType` as the
number or as the name; the app accepts both. `GetTables` takes `includeHidden` (default false);
the app does not set it, so a table hidden in OptiCloud would not be found and a second one made.

Row values come back keyed by column name; match names case-insensitively (the API may
camelCase them).

## Files in a list

Tried on 2026-11-11 in the Ventisol account with two order PDFs (7 and 67 KB) in a throwaway list.
Nothing in the apps uses it yet.

- `POST /api/MasterDataBlob/Upload/{tableId}` (multipart, field `file`) stores the file and answers
  `data: { name, contentType, reference }`. `reference` is
  `masterdata/<accountId>/<tableId>/<new uuid>.pdf`. The same file sent twice gives two references.
- The upload alone makes no row. Put the answer in a Blob column (`dataType` 8) of a row:
  `values: { File: { name, contentType, reference } }`. A plain string is taken as the reference
  with `name` and `contentType` null. Rows read back as `{ contentType, name, reference }`.
- `GET /api/MasterDataBlob/GetTempUrl?path=<reference>&fileName=&contentType=&disposition=inline`
  answers `data` as a read-only Azure Blob link, valid about 30 minutes, that opens without a
  login (served as `application/pdf`, inline). `GET /api/MasterDataBlob/Get?path=...` returns the
  bytes and needs the bearer token (401 without). Both gave back the exact bytes.
- Permanently deleting the list deleted the files its rows pointed to (also behind a temp link
  already handed out). A file uploaded but never put in a row stayed, and there is no endpoint to
  delete a file: always write the row, and never upload what may not be kept.
- Not tried: a size limit, other file types, what deleting or updating a single row does to its file.

## Writing

- Scans go to an outbox on the station PC first (one file per scan) and are sent oldest first,
  with backoff when OptiCloud can't be reached. A restart or a network outage loses nothing.
- A re-send of a scan that already got in (the app stopped between sending and crossing it off)
  is refused by the unique `ScanId`. Before giving up on a refused scan, the app looks for a row
  with that `ScanId`: `GetRowsPaged` with `keyword=<ScanId>`, matched exactly on the value, and
  if that finds nothing, the rows from a minute before the scan's time on. Found means sent.
- A scan refused for another reason (any 4xx except 401, 403, 404, 408, 429, or errors with a
  200) is tried again with backoff, and only moved aside to `outbox\failed` on the PC (and logged)
  when it has been refused 3 times in a row with the same message: one refusal may be a passing
  fault on the server. The menu then says `Forbundet · 2 scanninger afvist, se log`.
- 401 (after renewing the token) and 403 are the user's access, not the scan: the scan stays in
  line and is tried again with backoff, and the menu says `Fejl: OptiCloud afviser brugeren (adgang)`.
- On every start the app moves everything in `outbox\failed` back in line once, so a setup that
  was fixed (a user given access, a column added) sends them. One that did get in is recognised
  by its `ScanId`, as above.
- A sent scan whose file can't be deleted (held by a virus scanner...) is remembered as sent and
  not sent again; the file is deleted later, with backoff.
- A PC switched from Scan to Viewer mode still sends what waits in its outbox. A viewer never
  records scans of its own.
- A 404 on `CreateRow` means the table is gone: the app makes it again (with its columns) and
  sends once more. If it is still 404, it is treated like no network: wait and try again.
- A new scan, a change of the network, or reads working again after failing make the app try the
  oldest scan at once, but only when the last try could not reach OptiCloud. After an answer (a
  refusal, a 500, no access, a wrong password) the backoff runs its course, so scans every few
  seconds can't use up the 3 refusals in seconds.
- The status (green, `Sender ikke`, `Offline` and the banner) judges by how long the oldest scan
  has waited and how long since OptiCloud last answered, measured on a monotonic clock: a PC
  clock set back or forward changes nothing. A scan that waited from before the start counts
  from the start, so the first tries get their minute. While scans are getting in (one in the
  last minute), a backlog draining after an outage is not shown as an outage.

## The journal on the PC

In Scan mode the app also appends every scan it records to `journal\yyyy-MM-dd.jsonl` (one JSON
line per scan, by the scan's local date, kept 3 days, longer for a day holding a scan that still
waits in the outbox) in its data folder. The outbox forgets a
scan once it is sent; the journal keeps it. On start the screen is rebuilt at once from the
journal and the outbox, before any network, and again when OptiCloud has been read, with all of
it together (each `ScanId` once). So a restart never waits for the network, and works without
it. A viewer has no journal: it records nothing.

## Reading

- `GET /api/MasterData/GetRowsPaged/{tableId}?page=1&pageSize=500&Orderby=ScanTime&IsAscending=false`
  returns `data: { rows: [{ id, createdDate, values: {...} }], count, totalPage, ... }`.
- There is no date filter. Read pages newest first and stop at the first row older than the period wanted.
  If the ordering is ignored, read all pages (the app stops at 50).
- The app reads the last 36 hours, not just today: an element scanned in before midnight and out
  in the morning must still be in progress after a restart in the night (an update, a reboot).
  What is done is then limited to today (see Rules).
- A scan station (Scan mode) reads it the same way once its start has read the 36 hours. Its
  widgets and report (Seneste ordrer, the numbers, the day's orders and stations) then count what
  OptiCloud has, from every PC, plus its own scans not sent yet. Its stations keep their own state:
  only what is done today follows OptiCloud (`LoadedScans.Refresh`, `MainViewModel.ApplyDone`).
- What that costs: a few thousand rows a day is about 6 pages of 500 a day, so about 9 for the
  36 hours. A viewer or a scan station polls every 5 seconds; most polls read only from 10 minutes before the newest
  scan (one page), and every 12th poll (about once a minute) reads the whole 36 hours, to catch
  scans a station sent late with their own, older scan time. A late scan shows on viewers within
  about a minute.

## Rules

The station app (`ScanReplay`, `DayReport`) and the reports site follow the same rules, and both
run the test vectors in [`scan-rules-vectors.json`](scan-rules-vectors.json) (how to run one is in
its `_doc`). Change a rule there and here first.

- Scans are read from a window: the last 36 hours. Each `ScanId` counts once.
- Scans pair by `StationNo` and `Barcode`, oldest first, an `In` before an `Out` at the same time.
  Not by station name: a station can be renamed.
- An element is worked on at a station from its `In` to its `Out` there: one work record. A
  re-scan for rework is another pair and adds time.
- A second `In` of the same element at the same station while one is open: the later `In` wins,
  the earlier is dropped (it never got its `Out`; the station refuses a second element while one
  is in progress, so it is a missed scan, not parallel work).
- An `Out` with no `In` in the window: its start is put back from `DurationSec`. Without
  `DurationSec` it can't be timed and is skipped.
- In progress: per station, its latest `In` with no `Out`, over the whole window. An `In` older
  than the window with no `Out` is forgotten.
- Done today: the work records that end today (local midnight on). One that spans midnight counts
  for the day it ends.
- Time per order = the sum over its elements and stations; time in progress counts up to now.
- No order is called packed or done: the scans can't tell that without the order's element count.
  An order not in progress shows the station it was last scanned out at.

## Orders on machines

Each station set up with a machine (`MachineId`) keeps that machine's current order in OptiPeople
in step with the station, so OptiCloud's order time and reports follow the scans. The
`VentisolScans` rows are written exactly as before; this comes on top.

- The rule: a machine's order is the element in progress at its station, else none. Time is
  kept per element: the order number is the full 12-digit barcode, `058556050103` as it is, so
  every element is an order of its own in OptiPeople. Scan In sets it, Scan Out clears it, a
  switch to another element (a different barcode while busy) gives it the new element, also when
  that is the next piece of the same order.
- Each order also carries the barcode's parts as its own custom fields (`customFieldItems`, text),
  as plain digits: `058556050103` gives `Ordre` 58556, `Position` 5, `Underposition` 1, `Emne` 3
  (`MachineOrder.From`). Nothing is set up for them, per machine or anywhere else.
- A fifth field, `Scannet ind`, is when the element in progress was scanned In at the station, as
  the PC's local (Danish) time without offset: `2026-11-10 08:05:09`. It is the station's own
  start of the element, also after a restart (rebuilt from the journal or OptiCloud), so the true
  start is kept however late the order reaches OptiPeople, whose run starts when the set arrives.
- The fields may change while the number does not: a rework (Out, then a new In of the same
  element) gives a new In time. The same number never sets again; the fields are sent again
  when the machine runs that order, which updates `Scannet ind`. An Out and In within the 3
  seconds sends nothing at all, so the run and its fields keep the first In. After a longer
  gap the clear went out, so the new In is a new run on the same order with the new time.
- `POST /api/RealtimeDashboard/SetOrderToMachine` `{ "machineId": "<uuid>", "number": "058556050103", "expectedSpeed": 0 }`
  makes it the machine's current order and ends the run of the one before; `number: ""` clears it
  (OptiPeople then runs a hidden default order). An unknown number is created in the factory.
  The server stamps the time; there is no time field. Always HTTP 200, errors in the envelope.
- It is not idempotent: the same number again starts a new run. So the app only sends what
  differs from what the machine has.
- `GET /api/RealtimeDashboard/GetCurrentOrderActiveByMachineId?machineId=` reads what it has.
  No order comes two ways: a machine never given one has all-zero ids and `number: null`; a
  cleared one has `isDefaultPartInfo: true` and `number: ""`. Both count as none.
- `SetOrderToMachine` ignores custom fields, so they go by a call of their own once the machine is
  known to run the element (after a set, or when a read finds it already there, as after a
  restart): `POST /api/PartOrderNumber/ExternalSetPartOrder`
  `{ "factoryId": "<uuid>", "partOrderNumber": "058556050103", "customFields": [{ "label": "Ordre", "text": "58556" }, { "label": "Position", "text": "5" }, { "label": "Underposition", "text": "1" }, { "label": "Emne", "text": "3" }, { "label": "Scannet ind", "text": "2026-11-10 08:05:09" }] }`.
  It upserts by label and leaves the run alone, so it is safe to repeat. It comes after the set,
  which is known to create the order. Never for a clear.
- `factoryId` is the machine's, from `GET /api/Machine/Get/{machineId}` (`data.factoryId`), asked
  once per machine and kept for as long as the app runs.
- A failed fields call never causes a set again (that would split the run). The fields wait in a
  queue per machine with their own backoff, behind any read or set that is due. Fields of an
  element the machine has since left are still sent, oldest first: they belong to that order.
  Newer fields for an order already waiting replace the older ones. At most 20 orders wait per
  machine; beyond that the oldest is dropped.
- Desired state, not history: since the server stamps the time, scans are never replayed. Per
  machine only the latest wish counts, and it is sent once it has held for 3 seconds. An Out and
  In of the same element within that sends nothing; a quick Out and In of another element (of
  the same order or another) sends only the new one.
- On start nothing is sent until the screen has been rebuilt from OptiCloud's 36 hours (the
  journal alone may miss an element in progress). Then every mapped machine is read and set only
  if it differs. So a restart leaves a running order alone, and a machine whose station has
  nothing in progress is cleared when it runs one of our elements (a 12-digit element barcode).
  The app only ever clears its own: any other order (started by hand on the dashboard) is left
  as it is while the station has nothing in progress. A scan In still sets the element over it.
- OptiPeople leads when someone stops or changes an order there ("Start New Order" on the
  dashboard): a machine in step on an element is read again every 5 seconds, and when it no
  longer runs that element it is not set back (that would split the run). The station ends the
  element as an Out, recorded like a scanned one (journal, outbox, `VentisolScans`), and logs
  `ordre X stoppet i OptiPeople, afsluttet på station N`. The machine is then left alone, also
  when someone started another order on it by hand, until its station scans in an element again.
  A scan at the station while the read was under way wins, also an Out and In of the same
  element: that element is kept and sent.
  The first read on start and the read after a failure still set what the station has.
- An element can also be stopped by hand on a scan station: the stop button top-left on a busy
  tile asks "Stop ordre X på Station N?" first. Stop ends it exactly like a scan Out (journal,
  outbox, `VentisolScans`), the tile flashes "Stoppet manuelt" and the log says
  `Station N: ordre X (barcode) stoppet manuelt`. The machine's order is then cleared in
  OptiPeople after the settle, as after any Out. A viewer has no stop button.
- Nothing is ever set while the machine's order is unknown. After a failed call (it may have got
  in) the machine is read again first. A read that fails for any reason (no network, refused, an
  answer we can't use) is retried with backoff, never skipped.
- Failures wait 2, 5, 15, 30, then every 60 seconds (a wrong password 15 minutes), and then send
  whatever is wished by then. Settle and backoff run on a monotonic clock. Each distinct failure
  is logged once until a machine is in step again; each set is logged. Its own loop: a failure
  there never stops the scans being sent. Nothing
  is shown on the screen.
- Only in Scan mode with OptiCloud set up, and only machines a station is mapped to: a viewer and
  a station with no machine never send, and other machines are never touched. Two stations on one
  machine (a setup mistake): the one that started last wins.
- Code: `MachineOrder`, `MachineOrders` and `MachineOrderSync` (`Cloud/MachineOrders.cs`), the calls
  in `OptiCloudClient`, driven by `CloudSync`
  with the same login; `MainWindow.SendMachineOrders` after every scan and every rebuild.

## Auth

Bearer token from `POST /api/Authentication/login` (`grant_type=password`), refreshed with
`grant_type=refresh_token` (username required) on a 401. The login response is not wrapped in
`{data, errors, meta}`; every other response is, and errors may come with HTTP 200.
The account id comes from `GET /api/User/GetCurrentUser` (`data.accountId`).
A wrong password is tried again only every 15 minutes, also when the network changes, so the
station can't get the user locked out; other failures back off 2, 5, 15, 30, then every 60 seconds.

## Open with the backend owner

- Confirm a master-data table is fine for this volume (a few thousand rows a day).
- Whether `GetRowsPaged` honours `Orderby` on a value column, and a date filter would help
  (it would cut the viewers' whole-day reads to one page).
- What `keyword` searches on, and what the error for a duplicate `ScanId` looks like, so a
  re-send can be told apart without a lookup.
- A service user for the station PCs, and how long tokens live.
