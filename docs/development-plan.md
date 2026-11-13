# Ventisol MES: development plan

All software for the Ventisol MES project lives in this monorepo. The hardware is already on site at Ventisol (Vrå): PCs, screens, and Zebra LI3678-SR scanners. Only the software remains.

**The OptiCloud platform is the single source of truth.** Every scan, order and time ends up there, through the OptiPeople API. The station app builds no backend or database of its own. The web portal adds a Supabase read model on top (see `web-portal-plan.md`); OptiCloud stays the system of record.

Updated 2026-10-23.

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
