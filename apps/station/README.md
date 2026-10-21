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
