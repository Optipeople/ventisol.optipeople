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

`MasterDataColumnType` in the swagger has nine values (0 to 8); only 0 to 6 are known here
(String, Decimal, Int, DateTime, Bool, Long, Lookup). `GetColumns` may return `dataType` as the
number or as the name; the app accepts both. `GetTables` takes `includeHidden` (default false);
the app does not set it, so a table hidden in OptiCloud would not be found and a second one made.

Row values come back keyed by column name; match names case-insensitively (the API may
camelCase them).

## Writing

- Scans go to an outbox on the station PC first (one file per scan) and are sent oldest first,
  with backoff when OptiCloud can't be reached. A restart or a network outage loses nothing.
- A re-send of a scan that already got in (the app stopped between sending and crossing it off)
  is refused by the unique `ScanId`. Before giving up on a refused scan, the app looks for a row
  with that `ScanId`: `GetRowsPaged` with `keyword=<ScanId>`, matched exactly on the value, and
  if that finds nothing, the rows from a minute before the scan's time on. Found means sent.
- A scan refused for another reason (any 4xx except 401, 404, 408, 429, or errors with a 200)
  is moved aside to `outbox\failed` on the PC and logged, not retried.
- A 404 on `CreateRow` means the table is gone: the app makes it again (with its columns) and
  sends once more. If it is still 404, it is treated like no network: wait and try again.

## Reading

- `GET /api/MasterData/GetRowsPaged/{tableId}?page=1&pageSize=500&Orderby=ScanTime&IsAscending=false`
  returns `data: { rows: [{ id, createdDate, values: {...} }], count, totalPage, ... }`.
- There is no date filter. Read pages newest first and stop at the first row older than the period wanted.
  If the ordering is ignored, read all pages (the app stops at 50).
- What that costs: a few thousand rows a day is about 6 pages of 500 for the whole day. A viewer
  polls every 5 seconds; most polls read only from 10 minutes before the newest scan (one page),
  and every 12th poll (about once a minute) reads the whole day, to catch scans a station sent late
  with their own, older scan time. A late scan shows on viewers within about a minute.

## Rules (time per order)

- An element is worked on at a station from its `In` to its `Out` at that station.
- Time per order = the sum over its elements and stations. A re-scan for rework adds time.
- An order is packed at the last `Out` at a `Packing` station, when nothing on it is in progress.

## Auth

Bearer token from `POST /api/Authentication/login` (`grant_type=password`), refreshed with
`grant_type=refresh_token` (username required) on a 401. The login response is not wrapped in
`{data, errors, meta}`; every other response is, and errors may come with HTTP 200.
The account id comes from `GET /api/User/GetCurrentUser` (`data.accountId`).

## Open with the backend owner

- Confirm a master-data table is fine for this volume (a few thousand rows a day).
- Whether `GetRowsPaged` honours `Orderby` on a value column, and a date filter would help
  (it would cut the viewers' whole-day reads to one page).
- What `keyword` searches on, and what the error for a duplicate `ScanId` looks like, so a
  re-send can be told apart without a lookup.
- Whether a station should also set the machine's current order (`RealtimeDashboard/SetOrderToMachine`).
- A service user for the station PCs, and how long tokens live.
