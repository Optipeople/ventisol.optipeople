# Station app (MES-skærm)

Native Windows app for the central PC at Ventisol. WPF on .NET 10, in the Optipeople product language
(Hanken Grotesk, midnight green, status colours mean state).

**[Download the latest installer](https://github.com/Optipeople/ventisol.station.updates/releases/latest/download/VentisolStation-win-Setup.exe)** (always the newest version). For a PC with 32-bit Windows: [the 32-bit installer](https://github.com/Optipeople/ventisol.station.updates/releases/latest/download/VentisolStation-win-x86-Setup.exe). See [Release and updates](#release-and-updates).

```
src/Ventisol.Station        WPF app: window, theme, view models
src/Ventisol.Station.Core   logic without UI: barcode parsing, station state
tests/Ventisol.Station.Tests
```

Develop: `./dev.ps1` (or `./dev.ps1 -Empty`). It rebuilds and restarts the app on every saved
`.cs`, `.xaml` or `.csproj`, about 2 seconds. A failed build keeps the old window and prints the errors.

Run once: `dotnet run --project src/Ventisol.Station`. Options after `--`: `--kiosk` for full screen,
`--showcase` to start with sample scans on the screen (a picture for a demo, only without OptiCloud
set up: nothing it shows is written to the journal or the outbox). The installed app is a kiosk on every start
while its Run key says `--kiosk` (see Release and updates); `--window` opens it as a window anyway.
A dev build is always a window unless given `--kiosk`.

A kiosk fills the whole screen, over the taskbar, and closes only from its tray icon ("Luk", which
asks first in the app's own dialog). When another program comes in front, the kiosk takes the
foreground back after a moment, so a scanner in keyboard mode is heard again. The taskbar and the
Start menu (press the Windows key) are left in front for 20 seconds: that is the way to the tray icon.

Scans come from the cradles (and, for a demo, from `DemoScanner`: tap a tile, or press 1 to 7;
Shift+number scans a different element, Ctrl+number unplugs that scanner; at a station with "Max i gang"
above 1 a tap starts another element until it is full, then scans the oldest out). With OptiCloud set up,
every scan goes to the `VentisolScans` table and the station's machine gets the element in progress as its order
(see `docs/opticloud-scans.md`).

In the app: the logo opens the menu (version, connection, scanners, "Tilpas layout").
The dots at the bottom switch to the report page. In "Tilpas layout", blocks move, swap and resize
on a 12 x 6 grid, and widgets (clock, a KPI number, the last ten orders) can be added. The layout is
saved in %LOCALAPPDATA%\Ventisol\Station\layout.json.

Next, working down: COM port scanner reader (`IScanSource`), setup screen, then the OptiPeople API.

## Setup (Opsætning)

- PIN: optional, 4 to 8 digits, set under "PIN-KODE" in Opsætning. With one, it must be typed to
  open Opsætning (and, in a kiosk, "Åbn log" and "Luk" in the tray). Only a hash is kept, in
  `setup-pin.json` in the data folder (`%LOCALAPPDATA%\Ventisol\Station`). Forgotten: delete that
  file and there is no PIN. Wrong tries make the next one wait, longer each time. A file that can't
  be read keeps Opsætning shut and says "PIN-filen kan ikke læses"; delete it then too.
- The saved password only goes to the address and user it was saved for. Change the API address
  or the username and it must be typed again ("Skriv adgangskoden igen").
- "Max i gang" per station (1 to 20, default 1): how many elements may be in progress there at once
  (`StationConfig.MaxActive`, rules in `docs/opticloud-scans.md`). At 1 the station works as it always
  has: a different barcode stops the element and starts the new one. Above 1 a new barcode starts
  beside the others ("Startet – 3 i gang"), a scan of one in progress stops only that one, and one
  beyond the max is refused and not stored ("Maks 4 i gang – scan en ud først"). The tile then shows
  a row per element, each with its own timer and stop button; a tap on a row opens that element's
  document. The machine in OptiPeople gets the element scanned in last. A viewer shows the stations
  with its own settings, so give it the same "Max i gang" as the scan PC (with 1 it shows only the
  latest element of each station).
- "Marker efter (timer)" (default 4): on a station with "Max i gang" above 1, an element in progress
  longer than that gets an amber timer and "i gang over 4 t" on its row. A forgotten element would
  otherwise take a share of the station's time in the reports. Settings saved before either existed
  read as 1 and 4.
- The API address must begin with `https://`. Plain `http://` is taken only for this PC itself
  (`localhost`, `127.0.0.1`), for FakeOptiCloud. A PC with an older `http://` address saved does
  not connect: the menu says `Fejl: API-adressen skal begynde med https://`, and its scans wait
  on the PC until the address is put right.
- "VAGTSLUT" (`docs/plan-shift-end.md`): "Stop ved vagtslut" (Til by default), "Vent efter vagtslut"
  (15 to 90 minutes, default 60) and "Standardvagt", one start and end time for Monday to Friday
  (end before start is a night shift; empty is none). Each station row says where its shifts come
  from. For now every station uses the standard shift: the machines' shifts in OptiPeople are not
  read yet. A station with no shifts is never stopped.

### The tile at shift end

On a scan PC, when the shift has ended and an element is still in progress, the tile gets an amber
band over it: `Vagten sluttede 14:00` (or `Overarbejde` once anything has happened at the station
since) and `Stopper om 42 min, hvis intet sker`, with a big `Arbejder videre` button. Any scan at the
station (also a refused or unreadable one), a stop on the tile and a tap on `Arbejder videre` start the
countdown over; the taps and refused scans are kept in `shift-end.json` in the data folder, so a restart
keeps them. When the countdown runs out, every element at the station gets an Out back-dated to the
shift end, or to the last activity in overtime, with `Event = ShiftEnd` and an id derived from its In
(a second write, from a restart or another PC, is refused as a duplicate). The tile flashes `Stoppet
ved vagtskifte 14:00`, then shows that line under the idle text until the next scan or shift start,
and the machine's order in OptiPeople is cleared as after any Out. Scanning the element again starts it
anew (`Startet igen`). After the PC was off over a shift end, the stops are written at the start, once
the screen has been rebuilt from OptiCloud (from the journal alone after 5 minutes without it), and
never when OptiCloud already holds a scan of the element after its In. A viewer shows no countdown, only
the stop and the line once the rows come. Demo in a dev build: Alt+V ends every station's shift now,
with 1 minute to wait.

## Which barcodes count as an element

A new scan is an element when it has the 12 digits of a label (or 11 with the leading 0 lost, or
the 14 of a profile label), begins with 0, and its order is 58000 or later (`Barcode.OldestOrder`).
That keeps the retail codes on boxes out (EAN-13 and UPC-A are 13 and 12 digits too). An older
order is still read when its PDF is in the documents folder, so a remake can be scanned.
There is an upper limit too: an order more than 1000 (`Barcode.NewestOrderMargin`) above the newest
order the station knows of is refused, unless its PDF is in the documents folder. The newest order
known is the highest one with a PDF in the documents folder, or the last element scanned here
(`last-order.txt`, dropped when it is over 30 days old). A station that knows no order at all has no
upper limit. A retail code that happens to read as an order inside the limit still passes.
The rule is only for new scans (`Barcode.TryParseScan`). Scans already stored (the outbox, the
journal, rows in OptiCloud) are read whatever their order (`Barcode.TryParse`).

## Scanner at your desk

A Zebra cradle ships in USB keyboard mode, and that works out of the box: plug it in and scan.
The app tells a scanner from a person by speed (a fast burst ended by Enter). It is one scanner,
known as `keyboard`, so it scans for whichever station is set to scanner `keyboard`.

In COM port mode the app opens Zebra cradles (USB vendor id 05E0) and nothing else, when it finds
at least one. With no Zebra cradle plugged in it reads every USB serial device as a scanner, so
another scanner works on a dev PC. The log then says which, once per device:
`No Zebra cradle found: reading <name> (<id>) as a scanner.`

Adding a scanner on site is meant to be plug and play, with no other scanner settings:
1. Plug the cradle into a free port on the USB hub.
2. Scan the "USB CDC Host" barcode in the LI3678 manual.
3. In the app's setup, press "Identificér" on the station and scan any barcode.

The cradle sends no line end after a barcode, so the app takes a pause of 100 ms as the end of a
scan (`ComPortScanSource`, `LineFramer.Flush`). Don't rely on a suffix being set up.

In detail: switching each cradle to a COM port: scan the "USB CDC Host" programming barcode
in the LI3678 Product Reference Guide. The app then knows it by the USB port it is plugged into
(`usb:` plus the Windows location path, e.g. `usb:PCIROOT(0)#PCI(1400)#USBROOT(0)#USB(7)#USB(4)`),
not by its serial number: in CDC mode every cradle reports the same one, `USB_CDC_SYMBOL_SCANNER`.
The setup screen shows it as "USB-port 7.4 (COM3)": root port 7, port 4 on the hub. So keep each
cradle in its own hub port; a spare cradle plugged into the same port takes over that station.
Moving a cradle to another port means identifying it again in the setup screen. The same goes for
the hub: plugged into another PC port, every station needs identifying again. Swapping two cables
at the hub swaps their stations without any warning. Settings saved
before this hold a serial number and show as "ikke tilsluttet" until the station is identified again.

## Release and updates

Every push to main that touches what goes into the app (`apps/station/src`, `Directory.Build.props`,
`Ventisol.Station.slnx` or the workflow itself) makes `station-release.yml` build, test and publish
version `1.0.<run number>`. A change to the tests, the tools or this README alone ships nothing.
It can also be started by hand from the Actions tab, from main only. What it does:
self-contained win-x64 and win-x86, packaged with [Velopack](https://velopack.io) in two channels (`win` for
64-bit, `win-x86` for 32-bit Windows), uploaded together as one GitHub Release to
the public repo `Optipeople/ventisol.station.updates` (repo variable `UPDATE_REPO`). Public, because
this repo is private and we don't want a token on every PC. `station-ci.yml` builds and tests every
push to main and every pull request that touches `apps/station`.

Packages are pinned in `packages.lock.json` beside each project, and both workflows restore in
locked mode: a restore that does not match the lock files fails. After adding or updating a
package, run a normal `dotnet restore Ventisol.Station.slnx` and commit the lock files.

Secrets: `RELEASE_TOKEN` (Contents read and write on the updates repo). Code signing with Azure
Trusted Signing runs when `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_CLIENT_SECRET` are set, with
the variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE`.
Without it the installer is unsigned and Defender may flag it.

Install a station once with [`VentisolStation-win-Setup.exe`](https://github.com/Optipeople/ventisol.station.updates/releases/latest/download/VentisolStation-win-Setup.exe) from the latest release, or [`VentisolStation-win-x86-Setup.exe`](https://github.com/Optipeople/ventisol.station.updates/releases/latest/download/VentisolStation-win-x86-Setup.exe)
on a PC with 32-bit Windows (Settings > System > About says "32-bit operating system"; the 64-bit
installer says "This app can't run on your PC" there). Each updates only from its own channel. It installs for
the Windows user in `%LOCALAPPDATA%\VentisolStation` and adds the app to that user's startup
(`HKCU\...\Run`, `--kiosk`). While that entry says `--kiosk`, every start of the installed app is
a kiosk: the first after the install, a restart, the start after an update. `--window` opens it as
a window for once. Opsætning's "Kiosk-tilstand" (Kiosk / Vindue) switches it for good: Gem writes
the entry with or without `--kiosk` and restarts the app in the new mode. Only the installed app
that owns the entry can switch it; in a dev build the choice is greyed out.
Uninstalling removes it again. Let the station PC log in a local
Windows user automatically (netplwiz, or Sysinternals Autologon), so a power cut ends with the app
on the screen, not at a login prompt. That is set up by hand per PC, not by the installer.

After that the app updates itself (`Updates/UpdateService.cs`): it looks for a new release every
minute (the latest release's `releases.win.json` from its download link, so no GitHub API limit),
downloads in the background, and installs and restarts only when no scan has come in for 10 minutes, or between
22:00 and 05:00. The looking starts before the window is built, so a version whose window can't be
built still gets the next one. A dev run is "Ikke installeret" and never updates. If a new version fails to start
three times in a row, the app goes back to the version before and skips the bad one until a newer
release is out (`Updates/StartupGuard.cs`). Closing to install an update, a restart someone asked
for and Windows shutting down are not failed starts. Logs in `%LOCALAPPDATA%\Ventisol\Station\logs`.

When the app restarts itself after an error (a window that can't be built, three errors in a
minute, a fatal error), it notes it in `restarts.json` in the data folder. The more restarts in the
last hour, the longer the next start waits before it builds its window: 10 s, 30 s, 2 min, 5 min,
then 10 min. While it waits it looks for a newer version and installs it at once, and a small window
says "Starter igen om N s": its "Start nu", or starting the app by hand, ends the wait. From the third
restart the saved layout is set aside and the default one used. If the new app can't be started,
the old one stays up.

## Try it without OptiCloud

`tools/FakeOptiCloud` is a stand-in for the OptiPeople API on your own PC: the calls the station app
and the reports site make, shaped like the real ones (see `docs/opticloud-scans.md`). One user
`demo@ventisol.dk` / `demo`, account "Ventisol" (`7e3c2a10-5b4d-4f6e-9a21-0c8d7b6e5f40`), and seven
machines named like the stations. Tables and rows are kept in `fakeopticloud-data.json` next to the
exe, so a restart keeps them; `--reset` starts empty. Each request is logged as one line.

```
dotnet run --project tools/FakeOptiCloud                 # http://localhost:5099
dotnet run --project tools/FakeOptiCloud -- 5100         # another port (or FAKE_OPTICLOUD_URL)
```

`http://localhost:5099/fake/state` shows everything it holds, without a login. It also takes the machine order calls
(`SetOrderToMachine`, `GetCurrentOrderActiveByMachineId`, `Machine/Get`, `ExternalSetPartOrder`, held in
memory only), so a scan at a station with a machine shows as that machine's order in `/fake/state` after
about 3 seconds, and its fields under `orderFields`. `--forbid-writes`
(or `FAKE_FORBID_WRITES=1`) makes every `CreateRow` a 403, as for a user who may read but not write.

Start the app with its own data folder, so your real settings are left alone:

```
$env:VENTISOL_STATION_DATA = "$env:TEMP\ventisol-fake"; dotnet run --project src/Ventisol.Station
```

Open the menu (the logo), then Opsætning: API-adresse `http://localhost:5099`, brugernavn
`demo@ventisol.dk`, adgangskode `demo`, konto-id the account id above. "Test forbindelse", then
"Hent maskiner" and pick one per station, "Tastatur-scanner (USB HID)" on a station, and Gem. The app restarts connected and makes the `VentisolScans`
table. A second app with another `VENTISOL_STATION_DATA` set to Visning shows the same scans.

The reports site runs against it too: in `apps/web`, `OPTIPEOPLE_API_URL=http://localhost:5099` and
`VENTISOL_ACCOUNT_ID=7e3c2a10-5b4d-4f6e-9a21-0c8d7b6e5f40`, then log in as `demo@ventisol.dk` / `demo`.
