# Ventisol MES: development plan

All software for the Ventisol MES project lives in this monorepo. The hardware is already on site at Ventisol (Vrå): PCs, screens, and Zebra LI3678-SR scanners. Only the software remains.

**The OptiCloud platform is the single source of truth.** Every scan, order and time ends up there, through the OptiPeople API. The station app builds no backend or database of its own. Whether the web portal adds its own Supabase read model on top is undecided (see `web-portal-plan.md` §3.1); OptiCloud stays the system of record either way.

Updated 2026-11-25.

## What we build

| # | Part | Where it lives | Status |
|---|---|---|---|
| 1 | Station app | Native Windows app (this repo) | Built, tested against a fake OptiCloud |
| 2 | Scanner handling | Inside the station app | Built (COM port + keyboard mode); untested on real cradles |
| 3 | Backend | OptiPeople API and DB | Exists |
| 4 | Admin setup | Inside the station app | Built |
| 5 | Reports site | Next.js app, ventisol.optipeople.dk (this repo) | Built, not deployed; full portal planned in `web-portal-plan.md` |
| 6 | Schirmer start/stop | OptiPeople Dashboards | Exists |
| 7 | KMW connector | With Mads Wested (IoT) | Blocked on KMW |
| 8 | 3E connector | Inside the station app | Build last |
| 9 | Chat interface | In the portal (see `web-portal-plan.md`) | Planned |
| 10 | SchirmerFix | Done, signed off by Bente | Done |
| 11 | CI/CD and auto-update | GitHub Actions | Built; needs the update repo and secrets |
| 12 | Technical docs | OptiCore | Ongoing |
| 13 | Command cards Start, Pause, Hold | Station app + portal, [`plan-scan-commands.md`](plan-scan-commands.md) | Planned (2026-11-25) |
| 14 | Packing checklist | Station app + portal, [`plan-packing-checklist.md`](plan-packing-checklist.md) | Planned (2026-11-25) |
| 15 | Pallet labels | Station app + portal, [`plan-pallet-labels.md`](plan-pallet-labels.md) | Planned (2026-11-25) |
| 16 | Stop at shift end | Station app + portal, [`plan-shift-end.md`](plan-shift-end.md) | Planned (2026-11-25) |

### 1. Station app (native Windows)

One full-screen app on the central PC, where all 7 scanners connect.

- takes scan-in and scan-out from all 7 scanners
- shows a big "scan registered" confirmation
- starts by itself on boot, runs as a kiosk, updates itself (see 11)

Offline buffering is in: every scan goes to an outbox on the PC first and is sent when OptiCloud can be reached, with the scan's own time. A journal on the PC restores the screen at once after a restart.

The same app runs on the other PCs in **viewer mode** (see "Other screens" below).

### 2. Scanner handling (in the station app)

- 7 × Zebra LI3678-SR, all on the central PC.
- Each scanner must be identifiable, so the app knows which station a scan came from. See "Scanners on one PC" below.
- Scanner settings (symbologies, suffix, prefix) are kept as a 123Scan config file in this repo, so a replacement scanner can be set up the same way.

### 3. Backend: OptiPeople API

- Swagger saved in [`docs/api/optipeople.swagger.json`](api/optipeople.swagger.json) (fetched 2026-10-21 from `https://api.optipeople.dk/swagger/web/swagger.json?access=optipeople-1`, 749 paths).
- Auth: JWT bearer, from `POST /api/Authentication/login`.
- **Scans are rows in a master-data table, `VentisolScans`, in the Ventisol account.** `ItemScan` was looked at and doesn't fit (no scan time, no in/out, items are products). See [`opticloud-scans.md`](opticloud-scans.md) for the table, the rules and the open questions for the backend owner.
- Each station is mapped to an OptiCloud machine in the setup screen; the machine id is stored on every scan.

### 4. Admin setup (in the station app)

A setup button in the app, no login. It sets:

- the OptiPeople account and API credentials
- stations, and which scanner belongs to which station
- the mode of this PC: scan station or viewer

### 5. Reports site (Next.js)

- Separate Next.js app on `ventisol.optipeople.dk`, built like the vola.optipeople.dk project.
- Uses the OptiPeople API, with login through OptiPeople Auth.
- Customized to Ventisol: time per order and per batch, as a timeline.

### 6. Schirmer start/stop

Uses the existing OptiPeople Dashboards on Ventisol's tablet. Nothing to build here, only to configure.

### 7. KMW connector

Blocked until the KMW meeting defines the tags KMW exposes. Mads Wested (IoT engineer) most likely builds it. Until then: a fixed time per batch.

### 8. 3E connector (in the station app, built last)

Searches Ventisol's folder of 3E PDFs and shows the work order or drawing for a scanned order on the station screen.

### 9. Chat interface

OptiPeople already has an MCP server. Ventisol needs a chat on top of it. Two options:

- extend Opti Assist with what Ventisol needs
- build the chat into the reports site (5)

### 10. SchirmerFix

Done and signed off by Bente. Move the source into the monorepo so everything is in one place.

### 11. CI/CD and auto-update

See "Advice: CI/CD and auto-update" below.

### 12. Technical docs

Short technical descriptions in OptiCore, written as we build.

### 13 to 16. Feedback from the floor, 2026-11-25

Four features from a visit at Ventisol. Each has a plan of its own, ready to build. Nothing is built yet.

| # | Feature | What Ventisol asked for | Plan |
|---|---|---|---|
| 13 | Command cards | Scan **Start**, **Pause** and **Hold** cards, so breaks and broken glass don't count as work, and so an operator can scan Start, then every window he works on, then Hold | [`plan-scan-commands.md`](plan-scan-commands.md) |
| 14 | Packing checklist | Scan an order at packing and see every piece in it. Each piece scanned lights up and is checked out of production. The order's time ends at the last one | [`plan-packing-checklist.md`](plan-packing-checklist.md) (owns the whole floor flow at packing, pallets included) |
| 15 | Pallet labels | Pallets are built at packing. Each piece checked out also goes on the open pallet; a **Print** card prints a sheet with a pallet id and every window on it, so you can tell which part of an order is on which pallet | [`plan-pallet-labels.md`](plan-pallet-labels.md) (pallet data, ids, printing, portal views) |
| 16 | Stop at shift end | An operator forgot to scan out and the order ran into the next day. An element still running at shift end keeps running if there is activity; if nothing happens, its stop time is set to the shift end. Every station, every Arbejdsform | [`plan-shift-end.md`](plan-shift-end.md) |

**Shared ground, owned by #13:**

- **Command barcodes** are Code 128 with letters, `VS-<WORD>`. Element labels are digits only, so they can't be mistaken for each other. One classifier, `ScanCodes.Classify`, sorts every scan into element, command, pallet or unknown. The command words and their owners are listed in `plan-scan-commands.md` §3.
- **Arbejdsform**, a setting per station: `Enkel` (today: scan in, scan out), `Session` (#13), `Pakning` (#14, with #15's pallets). A station that keeps `Enkel` works exactly as today.
- **Rows** stay in `VentisolScans`, with one new column, `Event`, and one new `Direction`, `Mark`, for a row that carries no time. Old rows and old app versions keep working. Pallets get a table of their own, `VentisolPalletEvents` (#15).

**Build order:**

1. #13 steps 2 to 4: barcode classification, the Arbejdsform setting, the `Event` column. The others build on these.
2. #16 (stop at shift end) right after: it fixes a problem Ventisol has today, on today's simple stations.
3. Then #13 (Session) and #14/#15 (packing with pallets). They touch the same view model (`MainViewModel.Scan` routes by Arbejdsform), so not by several sessions at once.
4. #15 needs a printer on site. Choose and order it early.

**Answered by Morten, 2026-11-25:**

- Which stations use `Session` is a setting, not a build question. Decide on the day which stations get cards.
- Hold needs no reason for now (`VS-HOLD-<WORD>` stays reserved).
- At shift end a running element stops: see #16.
- An order can't leave short. The operator can leave a half-done checklist; the order stays open until every piece is checked out.
- Pallets are built at the packing station. No 8th scanner.

**Still open with Ventisol** (each plan has its full list):

- Which printer. The sheet waits on it (A4 from Windows first, a label printer later).
- Does our pallet sheet replace the pallet label 3E prints? Probably yes.
- Packing: does the first scan of an order also check that window out?

**To ask the OptiCloud backend owner:** adding a column and a `Direction` value to a large `VentisolScans`; whether `GetRowsPaged` can filter on `OrderNo` (packing needs an order's whole history); whether a second table for pallets is fine; whether a machine stop with a reason can be registered for Pause and Hold.

## Barcodes

From the physical sample (`context/IMG_4723.jpg`, `context/IMG_4724.jpg`), a pallet label for order 58556:

```
0 58556 05 01 03
| |     |  |  └ piece number within the position (01, 02, 03 ...)
| |     |  └── sub-position (Pos. 5.1 → 01, Pos. 4 → 01)
| |     └───── position (Pos. 5 → 05)
| └─────────── order number (5 digits)
└───────────── leading 0
```

- 12 digits, numbers only. 1D barcode (Code 128 or Interleaved 2 of 5, to be confirmed with a scan). The LI3678-SR reads both.
- The batch number (Serienr., e.g. 260708) is not in the barcode, only printed as text. **We don't need it.** The goal is order time, and the order number is in the barcode. Batch time can be added later by looking up order → batch (3E or the Schirmer files).
- The label also shows the element size (e.g. 1183 × 1539) and the shipping week (Afsendelse 2026/43).
- The Schirmer XML `Barcode` field is 14 digits (e.g. `05866002010301`), not 12. Profile labels from the saw come in two 14-digit layouts, both seen in production scans on 2026-11-11:
  - `0 58830 03 01 01 14`: 0, order, position, sub-position, piece, profile number.
  - `03 0 58830 01 01 05`: position, 0, order, sub-position, piece, profile number.
  The station reads both as the 12-digit element (`058830030101`). Many labels fit only one layout. Some fit both: a position below 10 in the second layout (`03058830…` also reads as order 30588), and from order 60000 on, every first-layout label for orders X0xxx. Then, in turn (`Barcode.Element`): a reading with an order below 58000 loses (orders only grow); an order with a PDF in the 3E folder beats one without; the order nearer the last order scanned wins (kept in `last-order.txt` across restarts); else the lower order wins. A scanner can read one label twice within 0.3 s, so a repeat of the same element at the same station within 2 s is ignored.

## Advice: scanners on one PC

**Recommendation: put each cradle in USB CDC mode (virtual COM port), not keyboard mode.**

- In keyboard mode, all 7 scanners type into whatever window has focus. One stray click, and scans are lost or mixed.
- In CDC mode, each cradle gets its own COM port. The app reads all of them in the background, with or without focus, and knows exactly which scanner sent what.
- Map each cradle by its USB serial number, not by its COM port number. Windows can renumber COM ports.
- As a safety net, also give each scanner a prefix with its station ID.
- 7 cradles need 7 USB ports. Use a powered USB hub.

## Advice: other screens

**Recommendation: the same native app in viewer mode, reading from the OptiPeople API.**

- One app to build, install and update. The setup button decides the mode.
- Viewers read from OptiCloud, not from the central PC. So they keep working if the central PC restarts, and the platform stays the single source of truth.
- Alternative: the central app serves a local web page that the other PCs open in a kiosk browser. Simpler on the other PCs, but everything depends on the central PC, so I don't recommend it.

## Advice: CI/CD and auto-update

- **Stack:** C# / .NET 10 (LTS, supported to November 2028), WPF. Same language as SchirmerFix and good serial-port and Windows support. .NET 8 support ends November 2026, so it is not an option.
- **Packaging and updates:** [Velopack](https://velopack.io). It builds the installer and handles silent updates with delta packages.
- **Pipeline:** GitHub Actions in the monorepo. A tag like `station-v1.2.0` builds, tests, packages and publishes a release. Path filters so each app only builds when its own folder changes.
- **Update source:** a private GitHub repo needs a token on every PC. Better to publish update packages to a public storage location (Azure Blob or a public releases repo).
- **When to update:** the app looks for a new release every minute but installs only when no scan has come in for 10 minutes, or at night. Never in the middle of a shift.
- **Rollback:** keep the previous version. If the new one crashes on startup, roll back automatically.
- **Code signing:** strongly recommended. SchirmerFix got a Defender false positive (Wacatac) without it. Azure Trusted Signing is cheap.
- **Monitoring:** each PC sends a heartbeat and its app version. An alert fires if the central PC goes silent. Logs go to a file on the PC (Serilog) and errors are shipped out.
- **Reports site:** deployed via Vercel's GitHub integration, preview per pull request.

## Proposed repo layout

```
apps/
  station/        native Windows app (scan + viewer modes, setup, 3E)
  web/            Next.js reports site, ventisol.optipeople.dk
  schirmerfix/    SchirmerFix (moved in)
packages/
  api-client/     typed OptiPeople API client generated from the swagger
config/
  scanners/       123Scan config files
docs/
  api/            OptiPeople swagger
.github/workflows/
```

## Reference

**Production flow:** 3E, Schirmer (saw), KMW line (welding, corner cleaning, buffer), manual assembly stations, packing.

**Stations in the proposal mock:** Station 10, 20, 30, 40, Montagebord 1, Montagebord 2, Pakning.

**Time rules:**
- time per order (batch time later)
- an order closes at the last packing scan
- a re-scan for rework adds time to the order
- one order can span several batches, and one batch several orders (batches hold at most 12 items)

**Network (Omron PLCs, reached over Complea's FortiClient VPN):**

| Device | IP | PLC |
|---|---|---|
| Federhenn | 192.168.10.125 | OM01332 |
| KMW | 192.168.10.126 | OM01333, OM01456 |
| Schirmer | 192.168.10.127 | OM01320 |
| Scanner (Omron V430F) | 192.168.10.129 | |
| Teltonika RUT241 router | 192.168.10.130 | |

**People:**
- Kim Jørgensen (kij@ventisol.dk): decision maker at Ventisol
- Bente Sørensen (bks@ventisol.dk): 3E, planning, Schirmer files
- Rasmus Hangaard Hansen (rhh@optipeople.dk): project lead, Kim's single point of contact
- Morten Pradsgaard (mpg@optipeople.dk): technical delivery
- Mads Wested (OptiPeople): IoT engineer, KMW connector
- Complea (skh@complea.dk, CMN@complea.dk): Ventisol's IT and network
- Michael Grehl (michael.grehl@kmw-engineering.de): KMW contact from Vindunor

**Proposal document:** `context/Ventisol_MES_kunde_med_priser.html`
