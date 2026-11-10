# Station app (MES-skærm)

Native Windows app for the central PC at Ventisol. WPF on .NET 10, in the Optipeople product language
(Hanken Grotesk, midnight green, status colours mean state).

```
src/Ventisol.Station        WPF app: window, theme, view models
src/Ventisol.Station.Core   logic without UI: barcode parsing, station state
tests/Ventisol.Station.Tests
```

Develop: `./dev.ps1` (or `./dev.ps1 -Empty`). It rebuilds and restarts the app on every saved
`.cs`, `.xaml` or `.csproj`, about 2 seconds. A failed build keeps the old window and prints the errors.

Run once: `dotnet run --project src/Ventisol.Station`. Options after `--`: `--kiosk` for full screen,
`--showcase` to start with sample scans on the screen.

Right now it is UI only. Scans come from `DemoScanner`: tap a tile, or press 1 to 7.
Shift+number scans a different element (rejected), Ctrl+number unplugs that scanner.
Nothing is sent to OptiCloud yet.

In the app: the logo opens the menu (version, connection, scanners, "Tilpas layout").
The dots at the bottom switch to the report page. In "Tilpas layout", blocks move, swap and resize
on a 12 x 6 grid, and widgets (clock, a KPI number, the last ten orders) can be added. The layout is
saved in %LOCALAPPDATA%\Ventisol\Station\layout.json.

Next, working down: COM port scanner reader (`IScanSource`), setup screen, then the OptiPeople API.

## Scanner at your desk

A Zebra cradle ships in USB keyboard mode, and that works out of the box: plug it in and scan.
The app tells a scanner from a person by speed (a fast burst ended by Enter). It is one scanner,
known as `keyboard`, so it scans for whichever station is set to scanner `keyboard`.

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

Push a tag `station-v1.2.0` and `station-release.yml` builds, tests and publishes version 1.2.0:
self-contained win-x64, packaged with [Velopack](https://velopack.io), uploaded as a GitHub Release to
the public repo `Optipeople/ventisol-station-updates` (repo variable `UPDATE_REPO`). Public, because
this repo is private and we don't want a token on every PC. A tag with a suffix, like
`station-v1.3.0-beta1`, is a pre-release the stations skip. `station-ci.yml` builds and tests every
push to main and every pull request that touches `apps/station`.

Secrets: `RELEASE_TOKEN` (Contents read and write on the updates repo). Code signing with Azure
Trusted Signing runs when `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_CLIENT_SECRET` are set, with
the variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT` and `AZURE_SIGNING_PROFILE`.
Without it the installer is unsigned and Defender may flag it.

Install a station once with `VentisolStation-win-Setup.exe` from the latest release. It installs for
the Windows user in `%LOCALAPPDATA%\VentisolStation` and adds the app to that user's startup
(`HKCU\...\Run`, `--kiosk`). Uninstalling removes it again. Let the station PC log in a local
Windows user automatically (netplwiz, or Sysinternals Autologon), so a power cut ends with the app
on the screen, not at a login prompt. That is set up by hand per PC, not by the installer.

After that the app updates itself (`Updates/UpdateService.cs`): it checks every hour, downloads in
the background, and installs and restarts only when no scan has come in for 10 minutes, or between
22:00 and 05:00. A dev run is "Ikke installeret" and never updates. If a new version fails to start
three times in a row, the app goes back to the version before and skips the bad one until a newer
release is out (`Updates/StartupGuard.cs`). Logs in `%LOCALAPPDATA%\Ventisol\Station\logs`.

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

`http://localhost:5099/fake/state` shows everything it holds, without a login. `--forbid-writes`
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
