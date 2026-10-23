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
| `ScanId` | String (0), key, unique | uuid made by the station app; sending the same scan twice is harmless |
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

Row values come back keyed by column name; match names case-insensitively (the API may
camelCase them).

## Reading

- `GET /api/MasterData/GetRowsPaged/{tableId}?page=1&pageSize=500&Orderby=ScanTime&IsAscending=false`
  returns `data: { rows: [{ id, createdDate, values: {...} }], count, totalPage, ... }`.
- There is no date filter. Read pages newest first and stop at the first row older than the period wanted.
  If the ordering is ignored, read all pages.

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
- Whether `GetRowsPaged` honours `Orderby` on a value column, and a date filter would help.
- Whether a station should also set the machine's current order (`RealtimeDashboard/SetOrderToMachine`).
- A service user for the station PCs, and how long tokens live.
