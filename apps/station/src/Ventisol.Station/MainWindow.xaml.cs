using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Shapes;
using System.Windows.Threading;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using Ventisol.Station.Core.Documents;
using Ventisol.Station.Documents;
using Ventisol.Station.Scanning;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

public partial class MainWindow : Window
{
    // The report page goes back to the stations after this long without a touch.
    static readonly TimeSpan ReportIdle = TimeSpan.FromSeconds(60);
    // An open document goes back to the stations after this long without a touch.
    static readonly TimeSpan DocumentIdle = TimeSpan.FromMinutes(3);
    // The PIN prompt closes after this long without a touch.
    static readonly TimeSpan PinIdle = TimeSpan.FromSeconds(60);
    // An update waits for this long without a scan, and for a setup screen or layout mode nobody has touched for as long.
    static readonly TimeSpan UpdateQuiet = TimeSpan.FromMinutes(10);

    // Not readonly: the stations' names follow their machines in OptiPeople (OnStationsRenamed).
    StationSettings _settings = SettingsStore.Load();
    readonly MainViewModel _vm;
    readonly DemoScanner _demo;
    readonly KeyboardScanSource _keyboard = new();
    readonly ScanSources _scans;
    readonly CloudSync _cloud;
    readonly OrderDocuments _documents;
    readonly OrderDocumentViewModel _document;
    // The scans this screen sent in the last 36 hours, so a load from OptiCloud never drops one.
    readonly List<ScanEvent> _recorded = [];
    // Taps and number keys make up scans only while OptiCloud is not set up, so a station
    // on the shop floor never sends a made-up scan.
    readonly bool _demoInput;

    // The stop at shift end (docs/plan-shift-end.md §4.3, §6.5): checked every 30 seconds, and at once
    // after a load (the catch-up at start), a tap on "Arbejder videre" and the demo's Alt+V.
    static readonly TimeSpan ShiftEndEvery = TimeSpan.FromSeconds(30);
    static readonly string ShiftEndFile = System.IO.Path.Combine(AppPaths.Data, "shift-end.json");
    readonly ShiftEndWatch _shiftEnd;
    DateTimeOffset _shiftEndChecked = DateTimeOffset.MinValue;
    // Per station, the stop time the log last told of.
    readonly Dictionary<int, DateTimeOffset> _shiftEndLogged = [];
    // Demo (Alt+V, a dev build): a shift that ended when it was pressed, at every station, with 1 minute's grace.
    // Set only in a debug build: the "= null" keeps the release build from failing on a field never assigned (CS0649).
    ShiftSchedule? _demoShift = null;

    static readonly string DataFolder = AppPaths.Data;
    readonly DispatcherTimer _clock = new() { Interval = TimeSpan.FromMilliseconds(250) };
    readonly bool _kiosk;
    // Started with sample scans (--showcase), for a demo: a picture of a screen in use. Nothing it
    // shows is written or sent, and what this PC's journal holds is not replayed over it.
    readonly bool _showcase;
    readonly Dictionary<string, Tile> _tiles = [];
    readonly List<Button> _dots = [];

    StationLayout _layout;
    // Stations this screen leaves out. They still take scans; only their tile is gone until put back.
    readonly HashSet<string> _hidden = [];
    bool _editing;
    DateTimeOffset _lastTouch = DateTimeOffset.Now;

    // A block on the stations page: a station or a widget, plus the frame, grip and remove button
    // shown while arranging. Station is the scanner number, for a tap to scan in the demo.
    sealed record Tile(Grid Root, Rectangle Frame, Thumb Grip, Button Remove, TranslateTransform Shift, int? Station);

    static string StationId(int number) => $"station-{number}";

    public MainWindow(bool kiosk, bool showcase)
    {
        InitializeComponent();
        // No folder set, but OptiCloud is: the PDFs come from OptiCloud's list (a PC that can't reach the share).
        _documents = new OrderDocuments(new OrderDocumentLocator(_settings.DocumentsFolder))
        {
            Log = Log.Write,
            Cloud = _settings.DocumentsFolder is null && _settings.IsConnected && SettingsStore.LoadPassword() is not null ? new CloudDocumentSource(() => _cloud?.Connection) : null,
        };
        _documents.Warm();
        _vm = new MainViewModel(_settings.Stations.Select(s => s.Config))
        {
            IsViewer = _settings.Mode == StationMode.Viewer,
            OrderExists = _documents.Has,
            NewestOrder = () => _documents.NewestOrder,
            LastOrder = ReadLastOrder(),
        };
        DataContext = _vm;
        _demo = new DemoScanner(_vm);
        _kiosk = kiosk;

        var (layout, widgets, hidden) = LayoutStore.Load([.. _vm.Stations.Select(s => StationId(s.Number))]);
        _layout = layout;
        _hidden.UnionWith(hidden);
        foreach (var spec in widgets)
        {
            // A document widget for a station that has since been taken out of the setup goes with it.
            if (spec.Kind == WidgetKind.Document && !_vm.Stations.Any(s => s.Number == spec.Station)) { _layout.Remove(spec.Id); continue; }
            _vm.AddWidget(MakeWidget(spec));
        }
        _document = new OrderDocumentViewModel(_documents);
        foreach (var s in _vm.Stations)
        {
            s.DocumentsOn = _documents.IsOn;
            s.StopOn = _settings.Mode == StationMode.Scan;
            s.MarkAfter = TimeSpan.FromHours(_settings.MarkAfterHours);
        }
        Document.Attach(_document, _vm.Stations);
        Document.CloseRequested += (_, _) => CloseDocument();
        BuildTiles();
        FollowDocument();
        BuildGuides();
        BuildDots();
        _demoInput = !_settings.IsConnected;
        // Sample scans would be sent to OptiCloud like real ones, so only without it.
        _showcase = showcase && _demoInput;
        if (_showcase) _demo.Showcase(DateTimeOffset.Now);
        // After the samples, so their orders are not kept as this PC's last one.
        _vm.LastOrderChanged += (_, order) => { if (!_showcase) SaveLastOrder(order); };

        if (kiosk)
        {
            ResizeMode = ResizeMode.NoResize;
            // Without the chrome: with it Windows does not take the window for full screen, and the
            // taskbar stays in front of the logo and the page dots.
            System.Windows.Shell.WindowChrome.SetWindowChrome(this, null);
            WindowState = WindowState.Maximized;
            Topmost = true;
            // Back in front when something else has the foreground (TakeFront). It looks for as long
            // as the kiosk is up, from the first showing on, and not when the window is deactivated:
            // a start without the right to the foreground (a restart of the app's own, the updater)
            // shows the window behind what is in front, and it is not told when it loses it either.
            _front.Tick += Ui.SafeTick(TakeFront);
            ContentRendered += (_, _) => _front.Start();
        }
        else
        {
            WindowPlacement.Track(this);
            SourceInitialized += (_, _) => { Ui.RoundCorners(this); Ui.MaximizeToWorkArea(this); };
        }

        Menu.CloseRequested += (_, _) => CloseMenu();
        Menu.ArrangeRequested += (_, _) => { CloseMenu(); StartEditing(); };
        Menu.SetupRequested += (_, _) => { CloseMenu(); AskPin("Opsætning", OpenSetup); };
        Pin.Closed += (_, _) => Keyboard.Focus(this);

        // A scan always brings the stations back, so its answer is seen. An open document stays open
        // (its strip shows the answer) and follows its station to a new element.
        _vm.Scanned += (_, _) => { CloseMenu(); ShowReport(false); FollowDocument(); };
        // The document of an element scanned in is fetched now, so a tap on the station shows it at once.
        _vm.Recorded += (_, r) => { if (r.Kind == ScanKind.In) PrefetchDocument(r.Barcode); };

        _clock.Tick += Ui.SafeTick(OnTick);
        _clock.Start();
        _lower.Tick += Ui.SafeTick(Lower);

        // A viewer has no scanners; the keyboard source stays for the demo keys.
        _scans = _settings.Mode == StationMode.Scan
            ? new ScanSources(new ComPortScanSource(Log.Write), _keyboard)
            : new ScanSources(_keyboard);
        _scans.OnError = (_, ex) => Log.Write($"Scanner source failed: {ex.Message}");
        _scans.Scanned += (_, scan) => Dispatcher.BeginInvoke(() => OnRawScan(scan));
        _scans.ConnectionChanged += (_, _) => Dispatcher.BeginInvoke(OnScannersChanged);
        // Keys that turned out not to be a scan: digits for the PIN prompt while it is open, else the demo's.
        _keyboard.Typed += (_, c) =>
        {
            if (Pin.IsOpen) Pin.Type(c);
            else if (_demoInput && c is >= '1' and <= '7') _demo.Scan(c - '0');
        };
        _scans.Start();
        OnScannersChanged();

        _cloud = new CloudSync(_settings, SettingsStore.LoadPassword(), DataFolder, Log.Write) { Documents = _documents.Locator };
        _cloud.StatusChanged += (_, _) => Dispatcher.BeginInvoke(ShowCloudStatus);
        _cloud.Loaded += (_, loaded) => Dispatcher.BeginInvoke(() => ApplyLoaded(loaded));
        _vm.Recorded += (_, r) =>
        {
            if (_showcase) return;
            var machine = _settings.Stations.FirstOrDefault(s => s.Number == r.Station.Number)?.MachineId;
            if (ScanEvent.From(r, machine) is not { } e) return;
            _recorded.Add(e);
            _recorded.RemoveAll(x => x.At < CloudSync.WindowStart(e.At));
            if (!_cloud.Record(e)) Log.Write($"Scan not saved for sending: {e.Barcode.Raw} {e.Direction}");
        };
        // After every scan (a switch included) each machine follows its station's state.
        _vm.Scanned += (_, _) => SendMachineOrders();
        // Any scan at a station is activity there, also one refused or unreadable: kept on this PC, so
        // a restart in the grace period keeps it.
        _shiftEnd = new ShiftEndWatch(_settings.IsConnected, DateTimeOffset.Now, LoadShiftEndActivity());
        _vm.Activity += (_, a) => NoteActivity(a.Station, a.At);
        // And the other way: an order stopped or changed in OptiPeople ends the element at its station.
        _cloud.MachineOrderChanged += (_, c) => Dispatcher.BeginInvoke(() => OnMachineOrderChanged(c));
        // OptiPeople names the stations, so every screen calls them the same.
        _cloud.StationsRenamed += (_, r) => Dispatcher.BeginInvoke(() => OnStationsRenamed(r));
        ShowCloudStatus();
        _cloud.Start();
        Log.Write($"Started {_vm.Version}, {_settings.Mode}, OptiCloud {(_settings.IsConnected ? "set up" : "not set up")}");

        // The update service is the app's (started before this window, so it runs even when the
        // window can't be built); the menu shows what it says.
        if (App.Updates is { } updates)
        {
            updates.StatusChanged += (_, text) => _vm.UpdateText = text;
            _vm.UpdateText = updates.Status;
        }

        Closed += (_, _) => { _scans.Dispose(); _cloud.Dispose(); };
    }

    // For the update service, from its own thread. An update restarts the app, so it waits until no
    // scan has come in for 10 minutes (or night) ...
    public bool IsQuiet => DateTimeOffset.Now - _vm.LastScanAt > UpdateQuiet;

    // ... and never goes in under someone's hands: the setup screen, the layout mode or a PIN prompt
    // holds it back, until they have been left untouched for 10 minutes.
    public bool InUse => (_editing || Setup.IsOpen || Pin.IsOpen) && DateTimeOffset.Now - _lastTouch < UpdateQuiet;

    // What OptiCloud (or, before the network is there, this PC's journal) holds, plus every scan this
    // screen took since. Worked out here on the UI thread, so a scan that came in while the load was
    // on its way is in it, never undone by it.
    void ApplyLoaded(LoadedScans loaded)
    {
        if (_showcase) return;
        var now = DateTimeOffset.Now;
        var events = loaded.Events.Concat(_recorded.Where(e => e.At >= loaded.Since)).ToList();
        var today = ScanReplay.Replay(events, _vm.Stations.Select(s => s.Config), CloudSync.Midnight(now));
        _shiftEnd.Loaded(loaded);
        // A refresh can bring a station's last element done; a document widget on an idle station shows it.
        if (loaded.Refresh)
        {
            _vm.ApplyDone(today);
            _vm.ApplyAutoStopped(today.AutoStopped, now, flash: false);
            FollowDocument();
            return;
        }
        _vm.Apply(today, now);
        // The idle line goes with the next row at the station after the stop (a scan, here or elsewhere).
        foreach (var s in _vm.Stations)
            if (s.LastAutoStop is { } stop && events.Any(e => e.StationNo == s.Number && e.Event != ScanEventKind.ShiftEnd && e.At > stop.At))
                s.StoppedLineGone(now);
        SendMachineOrders(loaded.FromCloud);
        foreach (var a in _vm.Stations.SelectMany(s => s.State.Active)) PrefetchDocument(a.Barcode);
        FollowDocument();
        // The catch-up after the PC was off over a shift end, once the screen is as OptiCloud has it.
        CheckShiftEnd(now);
    }

    // ===== Stop at shift end =====

    // Where a station's shifts come from. The machine's shifts in OptiPeople are not read yet
    // (plan §3.1, §6.1): when MachineShifts is in, its lookup by machine id goes in as machineShifts
    // here and wins over the standard shift.
    ShiftSchedule? ScheduleFor(int station) => _demoShift ?? ShiftSchedules.For(_settings, station, machineShifts: null);

    TimeSpan ShiftEndGrace => _demoShift is not null ? TimeSpan.FromMinutes(1) : ShiftSchedules.Grace(_settings);

    // Per station: on a scan station the countdown, and the stop when it is due (plan §4.2, §4.3);
    // on any screen the idle line goes at the next shift start.
    void CheckShiftEnd(DateTimeOffset now)
    {
        if (_showcase) return;
        _shiftEndChecked = now;
        var zone = TimeZoneInfo.Local;
        var stopped = false;
        foreach (var s in _vm.Stations)
        {
            var schedule = ScheduleFor(s.Number);
            if (s.LastAutoStop is { } last && schedule is not null && schedule.Spans(last.At, now, zone).Any(p => p.Start > last.At && p.Start <= now))
                s.StoppedLineGone(now);
            // A viewer, or a scan PC without this station's scanner, cannot see its taps and refused
            // scans: no countdown, the stop comes with its rows (from the PC that has the scanner).
            if (_settings.Mode != StationMode.Scan || _demoShift is null && !ShiftSchedules.ScansHere(_settings, s.Number)) continue;

            var check = _shiftEnd.Check(s.State, schedule, _recorded, ShiftEndGrace, now, zone);
            switch (check.Verdict)
            {
                case ShiftEndVerdict.Write:
                    stopped |= WriteShiftEnd(s, check.Due!, now);
                    break;
                case ShiftEndVerdict.EndedElsewhere:
                    // Another PC ended (or started again) an element here: nothing is written, the station follows the rows.
                    Log.Write($"{s.Name}: stop ved vagtskifte ikke skrevet, OptiCloud har allerede en scanning efter elementets start");
                    var rows = ScanReplay.Replay(_shiftEnd.Rows.Concat(_recorded), _vm.Stations.Select(x => x.Config));
                    s.Restore(rows.InProgress.GetValueOrDefault(s.Number) ?? [], now);
                    s.ShiftEndComing(null, now);
                    stopped = true;
                    break;
                case ShiftEndVerdict.Counting or ShiftEndVerdict.Waiting:
                    // Said once per stop time: when the countdown starts, and each time activity moves it on.
                    if (_shiftEndLogged.GetValueOrDefault(s.Number) != check.Due!.StopAt)
                    {
                        _shiftEndLogged[s.Number] = check.Due.StopAt;
                        Log.Write($"{s.Name}: vagten sluttede {ShiftEndTexts.Clock(check.Due.ShiftEnd)}, stopper {ShiftEndTexts.Clock(check.Due.DueAt)} hvis intet sker (stop ved {ShiftEndTexts.Clock(check.Due.StopAt)})");
                    }
                    s.ShiftEndComing(check.Due, now);
                    break;
                default:
                    s.ShiftEndComing(null, now);
                    break;
            }
        }
        if (!stopped) return;
        SendMachineOrders();
        FollowDocument();
    }

    // Every element at the station stops at the due time, recorded like a scan (journal, outbox,
    // VentisolScans) with its back-dated time and derived ScanId.
    bool WriteShiftEnd(StationViewModel s, ShiftEndDue due, DateTimeOffset now)
    {
        var rows = _vm.ShiftEnd(s.Number, due.StopAt, now);
        var end = due.StopAt == due.ShiftEnd ? "" : $" (vagten sluttede {ShiftEndTexts.Clock(due.ShiftEnd)})";
        foreach (var r in rows)
            Log.Write($"{s.Name}: ordre {r.Barcode.Order} ({r.Barcode.Raw}) stoppet ved vagtskifte {ShiftEndTexts.Clock(due.StopAt)}{end}");
        return rows.Count > 0;
    }

    // Activity only this PC knows, noted and kept in shift-end.json.
    void NoteActivity(int station, DateTimeOffset at)
    {
        if (_settings.Mode != StationMode.Scan || _showcase) return;
        _shiftEnd.Local.Note(station, at);
        _shiftEnd.Local.Prune(at);
        AtomicFile.TryWrite(ShiftEndFile, _shiftEnd.Local.ToJson(), Log.Write);
    }

    static ShiftEndActivity LoadShiftEndActivity()
    {
        var activity = ShiftEndActivity.FromJson(AtomicFile.TryRead(ShiftEndFile, Log.Write));
        activity.Prune(DateTimeOffset.Now);
        return activity;
    }

    // "Arbejder videre" on the band: activity at the station, so the countdown starts over. No row.
    void OnTileWorkOn(object sender, RoutedEventArgs e)
    {
        if (_editing || Setup.IsOpen || _settings.Mode != StationMode.Scan) return;
        if (sender is not FrameworkElement { DataContext: StationViewModel s }) return;
        var now = DateTimeOffset.Now;
        NoteActivity(s.Number, now);
        Log.Write($"{s.Name}: arbejder videre efter vagtslut");
        CheckShiftEnd(now);
    }

    // Each mapped machine in OptiPeople gets the element in progress at its station, else none.
    // CloudSync sends it in the background, only in Scan mode with OptiCloud set up, and not before
    // the screen has been rebuilt from OptiCloud (fromCloud).
    void SendMachineOrders(bool fromCloud = false)
    {
        if (_settings.Mode != StationMode.Scan) return;
        _cloud.SetMachineOrders(MachineOrders.DesiredFrom(_settings.Stations, _vm.Stations.Select(s => s.State)), fromCloud);
    }

    // The machine's order was stopped or changed in OptiPeople: the station with that element in
    // progress ends it as an Out, recorded like a scan's (journal, outbox, VentisolScans), so a restart
    // and the viewers see it too. A station that has moved on to another element meanwhile keeps it.
    void OnMachineOrderChanged(MachineOrderChange change)
    {
        var now = DateTimeOffset.Now;
        var ended = false;
        foreach (var s in _settings.Stations.Where(s => s.MachineId == change.MachineId))
        {
            if (!_vm.Stop(s.Number, change.Stopped, StopReason.OptiPeople, now)) continue;
            ended = true;
            Log.Write($"OptiCloud: ordre {change.Stopped} stoppet i OptiPeople, afsluttet på station {s.Number}");
        }
        if (!ended)
        {
            Log.Write($"OptiCloud: ordre {change.Stopped} stoppet i OptiPeople, ingen station har den i gang");
            return;
        }
        SendMachineOrders();
        FollowDocument();
    }

    // ===== Stop by hand =====

    // The station and element the open confirm is about. Null: no confirm open.
    (StationViewModel Station, Barcode Barcode)? _stopping;

    // The stop button on a busy station tile, or on one row of a tile with several elements in
    // progress: asks first, as a slip of a thumb or mouse is easy.
    void OnTileStop(object sender, RoutedEventArgs e)
    {
        if (_editing || Setup.IsOpen || _settings.Mode != StationMode.Scan) return;
        var (s, barcode, elapsed) = sender switch
        {
            FrameworkElement { DataContext: StationViewModel t } when t.Current is { } b => (t, b, t.ElapsedText),
            FrameworkElement { DataContext: ActiveRowViewModel r } when r.Station.Has(r.Code) => (r.Station, r.Barcode, r.ElapsedText),
            _ => default((StationViewModel?, Barcode?, string?)),
        };
        if (s is null || barcode is null) return;
        CloseMenu();
        _stopping = (s, barcode);
        var others = s.State.Active.Count - 1;
        StopStation.Text = s.Name.ToUpperInvariant();
        StopTitle.Text = $"Stop ordre {barcode.Order} på {s.Name}?";
        StopDetail.Text = $"{barcode.PositionLabel} · stk. {barcode.Piece} · i gang {elapsed}\n"
            + (others > 0 ? $"Kun dette element stoppes. {others} andre er stadig i gang." : "Stationen bliver ledig, og ordren stoppes i OptiPeople.");
        StopLayer.Visibility = Visibility.Visible;
        Motion.FadeIn(StopLayer, Motion.Normal);
        Motion.Enter(StopCard, fromY: 16);
    }

    // Ends the element as a scan Out would (journal, outbox, VentisolScans), so the station is free
    // and the machine's order is cleared in OptiPeople after the settle. Only the element the confirm
    // named: if the station moved on meanwhile, nothing is stopped.
    void OnStopConfirm(object sender, RoutedEventArgs e)
    {
        if (_stopping is not { } stop) return;
        CloseStop();
        var (station, barcode) = stop;
        if (!_vm.Stop(station.Number, barcode.Raw, StopReason.Manual, DateTimeOffset.Now))
        {
            Log.Write($"{station.Name}: ordre {barcode.Order} ({barcode.Raw}) ikke stoppet, den var ikke længere i gang");
            return;
        }
        Log.Write($"{station.Name}: ordre {barcode.Order} ({barcode.Raw}) stoppet manuelt");
        SendMachineOrders();
        FollowDocument();
    }

    void OnStopCancel(object sender, RoutedEventArgs e) => CloseStop();

    void OnStopScrim(object sender, MouseButtonEventArgs e) => CloseStop();

    void CloseStop()
    {
        _stopping = null;
        StopLayer.Visibility = Visibility.Collapsed;
    }

    void ShowCloudStatus()
    {
        var status = _cloud.Status;
        var now = DateTimeOffset.Now;
        var viewer = _settings.Mode == StationMode.Viewer;
        // A viewer that can't reach OptiCloud still shows what it read last; say how old that is,
        // and after a while grey the tiles, so nobody takes them for now.
        var failing = viewer && status.State is CloudState.Offline or CloudState.Error && status.LastRead is not null;
        _vm.CloudText = failing ? $"{status.Text} · data fra {status.LastRead!.Value.ToLocalTime():HH':'mm}" : status.Text;
        _vm.CloudHealth = status.State switch { CloudState.Online => "Ok", CloudState.Error => "Alarm", _ => "Warn" };
        var stale = viewer ? CloudHealth.StaleText(status, now) : null;
        _vm.BannerText = stale ?? status.Banner;
        _vm.IdleText = CloudHealth.IdleText(_settings.Mode, status.LastRead is not null);
        _vm.Report.Note = CloudHealth.ReportNote(_settings.Mode, status, now);
        StationsGrid.Opacity = stale is null ? 1 : 0.45;
    }

    // ===== Scanners =====

    // Which station a scanner belongs to, as set up. Before any scanner is set up, a scanner in
    // keyboard mode scans at the first station, so one can be tried at a desk without setup.
    int? StationFor(string scannerId)
    {
        if (_settings.Stations.FirstOrDefault(s => s.ScannerSerial == scannerId) is { } set) return set.Number;
        var anySetUp = _settings.Stations.Any(s => s.ScannerSerial is not null);
        return !anySetUp && scannerId == KeyboardScanSource.Id ? _settings.Stations.FirstOrDefault()?.Number : null;
    }

    void OnRawScan(RawScan scan)
    {
        // Exactly what the scanner sent, control characters made visible, so a misread can be traced.
        Log.Write($"Scan from {scan.ScannerId}: \"{Visible(scan.Raw)}\"");
        // Only a station waiting in "Identificér" takes a scan from the setup; any other scan is work
        // at a station and counts, also while someone has the setup open.
        if (Setup.ViewModel is { } setup && setup.Stations.Any(s => s.IsIdentifying)) { setup.OnRawScan(scan); return; }
        // A viewer only shows what OptiCloud has. A scan here would show on this screen alone and never be sent.
        if (_settings.Mode == StationMode.Viewer) { Log.Write($"Scan on a viewer, ignored: {scan.Raw}"); return; }
        if (StationFor(scan.ScannerId) is { } n) _vm.Scan(n, scan.Raw, scan.At);
        else Log.Write($"Scan from scanner {scan.ScannerId}, which no station has: {scan.Raw}");
    }

    // The order of the last element scanned, kept so a label that fits both barcode layouts is read
    // right from the first scan after a restart too.
    static readonly string LastOrderFile = System.IO.Path.Combine(AppPaths.Data, "last-order.txt");

    // An order noted long ago (the PC was off, or scanned nothing) says nothing about the work going
    // on now: it is dropped, so new labels are never held to an old order number (Barcode.NewestOrderMargin).
    static readonly TimeSpan LastOrderKeptFor = TimeSpan.FromDays(30);

    static int? ReadLastOrder()
    {
        try
        {
            if (DateTime.Now - System.IO.File.GetLastWriteTime(LastOrderFile) > LastOrderKeptFor) return null;
        }
        catch { return null; }
        return AtomicFile.TryRead(LastOrderFile, Log.Write) is { } text && int.TryParse(text.Trim(), out var o) ? o : null;
    }

    static void SaveLastOrder(int order) =>
        AtomicFile.TryWrite(LastOrderFile, order.ToString(System.Globalization.CultureInfo.InvariantCulture), Log.Write);

    static string Visible(string raw) =>
        string.Concat(raw.Select(c => char.IsControl(c) || c > '~' ? $"<{(int)c:X2}>" : c.ToString()));

    // A station shows its scanner as missing when the scanner set up for it is not plugged in.
    // Until scanners are set up, the tiles are left as they are, so the demo works as before.
    void OnScannersChanged()
    {
        if (Setup.IsOpen) Setup.ViewModel!.RefreshScanners();
        if (_settings.Mode == StationMode.Viewer || !_settings.Stations.Any(s => s.ScannerSerial is not null)) return;
        var connected = _scans.Connected;
        foreach (var station in _vm.Stations)
        {
            var serial = _settings.Stations.First(s => s.Number == station.Number).ScannerSerial;
            // A keyboard-mode scanner can't be seen until it scans, so it counts as there.
            station.ScannerConnected = serial == KeyboardScanSource.Id || serial is not null && connected.Contains(serial);
        }
    }

    // The names are shown at once and kept on this PC, which shows them until OptiPeople is read
    // again. Only the names: anything else in the settings file is read from it as it is now, so a
    // setup saved meanwhile is not undone.
    void OnStationsRenamed(IReadOnlyDictionary<int, string> renamed)
    {
        _settings = StationNames.Apply(_settings, renamed);
        foreach (var s in _vm.Stations)
            if (renamed.TryGetValue(s.Number, out var name)) s.Rename(name);
        // A station given another machine in a setup saved since keeps the name that came with it.
        var saved = SettingsStore.Load();
        // A viewer's station without a machine has its name from the machine its scans go to.
        var same = renamed.Where(r => saved.Stations.FirstOrDefault(s => s.Number == r.Key) is { } was
                && was.MachineId == _settings.Stations.First(s => s.Number == r.Key).MachineId)
            .ToDictionary(r => r.Key, r => r.Value);
        if (same.Count > 0 && !SettingsStore.Save(StationNames.Apply(saved, same))) Log.Write("Station names from OptiPeople not saved on this PC");
    }

    // ===== Setup =====

    // Runs then at once when no setup PIN is set; otherwise asks for the PIN first, and runs it when
    // the PIN is right. For the setup screen, and for the tray's ways out of a kiosk.
    public void AskPin(string title, Action then)
    {
        if (!App.Pin.IsSet) { then(); return; }
        CloseMenu();
        CloseStop();
        _lastTouch = DateTimeOffset.Now;
        // Out of any field, so the keys reach the prompt and not a text box behind it.
        Keyboard.Focus(this);
        Pin.Ask(title, App.Pin, then);
    }

    void OpenSetup()
    {
        if (_editing || Setup.IsOpen) return;
        var vm = new SetupViewModel(SettingsStore.Load(), SettingsStore.LoadPassword(),
            testConnection: (s, pw, ct) => CloudSync.TestConnectionAsync(s, pw, ct),
            loadMachines: (s, pw, ct) => CloudSync.LoadMachinesAsync(s, pw, ct),
            connectedScanners: () => _scans.Connected,
            scannerPort: id => _scans.Sources.OfType<ComPortScanSource>().FirstOrDefault()?.PortOf(id))
        {
            HasPin = App.Pin.IsSet,
            Persist = SaveSetup,
            KioskAvailable = Updates.Autostart.OwnsEntry(),
            KioskAtOpen = _kiosk,
            PersistKiosk = Updates.Autostart.SetKiosk,
        };
        // Stations, mode and the OptiCloud login are read at start, so start again with the new ones.
        // Only once they are on the disk: a save that failed leaves the setup open, and says so.
        // Kiosk mode too: a window can't become a kiosk, or a kiosk a window, while it is up.
        vm.Saved += (_, _) => Restart(vm.KioskChanged);
        Setup.Open(vm);
    }

    // The password first: if the settings then can't be written, the old address is left with the
    // new password, never a new address with the old one.
    static bool SaveSetup(StationSettings settings, string? newPassword, string? newPin)
    {
        if (newPassword is not null && !SettingsStore.SavePassword(newPassword)) return false;
        if (!SettingsStore.Save(settings)) return false;
        return newPin switch
        {
            null => true,
            "" => App.Pin.Clear(),
            _ => App.Pin.Set(newPin),
        };
    }

    void Restart(bool kioskChanged = false)
    {
        // The new one uses the same outbox folder, so this one lets go of it first.
        _cloud.Dispose();
        _scans.Dispose();
        App.Restart(kioskChanged);
    }

    void OnTick()
    {
        var now = DateTimeOffset.Now;
        _vm.Tick(now);
        // Also when the PC's clock was put back.
        if (now - _shiftEndChecked >= ShiftEndEvery || now < _shiftEndChecked) CheckShiftEnd(now);
        // A viewer's data grows stale with time alone.
        if (_settings.Mode == StationMode.Viewer) ShowCloudStatus();
        if (_stopping is { } stop && !stop.Station.Has(stop.Barcode.Raw)) CloseStop();
        if (Pin.IsOpen && now - _lastTouch > PinIdle) Pin.Cancel();
        if (_confirmedClose is not null && now - _lastTouch > PinIdle) HideClose();
        if (_vm.ShowingReport && now - _lastTouch > ReportIdle) ShowReport(false);
        if (Document.IsOpen)
        {
            if (now - _lastTouch > DocumentIdle) CloseDocument();
            else _document.UpdateStatus(now);
        }
        foreach (var w in _vm.Widgets.OfType<DocumentWidget>()) w.Document.UpdateStatus(now);
    }

    protected override void OnPreviewMouseDown(MouseButtonEventArgs e)
    {
        base.OnPreviewMouseDown(e);
        _lastTouch = DateTimeOffset.Now;
    }

    // Reading a document is touching and scrolling it, not only tapping.
    protected override void OnPreviewTouchDown(TouchEventArgs e)
    {
        base.OnPreviewTouchDown(e);
        _lastTouch = DateTimeOffset.Now;
    }

    protected override void OnPreviewMouseWheel(MouseWheelEventArgs e)
    {
        base.OnPreviewMouseWheel(e);
        _lastTouch = DateTimeOffset.Now;
    }

    // ===== Order documents =====

    // The element whose row was tapped on a tile with several in progress, for the open document:
    // it shows that one for as long as it is in progress. Null: the station's latest.
    (int Station, string Barcode)? _documentPick;

    // What a station's document shows: the element in progress there (the one scanned in last, or the
    // one picked), else the last one done there today.
    DocumentTarget TargetFor(int station, string? pick = null)
    {
        var s = _vm.Stations.First(x => x.Number == station);
        if (pick is not null && s.State.Find(pick) is { } picked) return new(s.Name, picked.Barcode, true, picked.Since);
        if (s.State.Current is { } current) return new(s.Name, current, true, s.State.StartedAt);
        if (_vm.LastDoneAt(station) is { } last) return new(s.Name, last.Barcode, false, last.End);
        return new(s.Name, null, false, null);
    }

    // A station's document; with pick, that element of the ones in progress there.
    void OpenDocument(int station, string? pick = null)
    {
        if (_editing || Setup.IsOpen) return;
        CloseMenu();
        _lastTouch = DateTimeOffset.Now;
        var other = Document.Station != station;
        if (pick is not null || other) _documentPick = pick is null ? null : (station, pick);
        if (other) _document.Show(TargetFor(station, PickFor(station)));
        else if (pick is not null) _document.Follow(TargetFor(station, pick));
        Document.Open(station);
    }

    string? PickFor(int station) => _documentPick is { } p && p.Station == station ? p.Barcode : null;

    void CloseDocument()
    {
        if (!Document.IsOpen) return;
        _documentPick = null;
        Document.Close();
        // Back on the window, so a keyboard-mode scanner is heard (as after the setup).
        Keyboard.Focus(this);
    }

    // The open document and every document widget follow their station to its element now.
    void FollowDocument()
    {
        if (Document.Station is { } n) _document.Follow(TargetFor(n, PickFor(n)));
        foreach (var w in _vm.Widgets.OfType<DocumentWidget>()) w.Document.Follow(TargetFor(w.Station));
    }

    WidgetViewModel MakeWidget(WidgetSpec spec) =>
        WidgetViewModel.Create(spec, () => new OrderDocumentViewModel(_documents) { ShowsPages = false });

    // Finds and reads the element's document and renders its drawing, in the background. A scan never waits on it.
    void PrefetchDocument(Barcode barcode)
    {
        if (!_documents.IsOn) return;
        var (ground, ink) = OrderDocumentViewModel.DrawingColours();
        _ = Task.Run(async () =>
        {
            try
            {
                var load = await _documents.LoadAsync(barcode);
                if (load is { Status: OrderDocumentLoadStatus.Ready, Position: { Drawing: not null } p, Pdf: not null })
                    await PdfRender.DrawingAsync(load, p, ground, ink);
                else if (load.Status is OrderDocumentLoadStatus.FolderUnavailable or OrderDocumentLoadStatus.Unreadable)
                    Log.Write($"Order document for {barcode.Raw}: {load.Status}, {load.Error}");
            }
            catch (Exception ex) { Log.Write($"Order document for {barcode.Raw} failed: {ex.Message}"); }
        });
    }

    // The document button on a station tile (in the demo, where a tap on the tile scans).
    void OnTileDocument(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { DataContext: StationViewModel s }) OpenDocument(s.Number);
    }

    // ===== Stations page =====

    void BuildTiles()
    {
        for (var c = 0; c < StationLayout.Columns; c++) StationsGrid.ColumnDefinitions.Add(new ColumnDefinition());
        for (var r = 0; r < StationLayout.Rows; r++) StationsGrid.RowDefinitions.Add(new RowDefinition());

        foreach (var station in _vm.Stations.Where(s => !_hidden.Contains(StationId(s.Number))))
            CreateTile(StationId(station.Number), station, station.Number);
        foreach (var widget in _vm.Widgets) CreateTile(widget.Id, widget, null);
        PlaceTiles(animate: false);
    }

    void CreateTile(string id, object content, int? station)
    {
        var shift = new TranslateTransform();
        var frame = new Rectangle
        {
            Margin = new Thickness(6), RadiusX = 10, RadiusY = 10, StrokeThickness = 2, StrokeDashArray = [4, 3],
            Stroke = (Brush)FindResource("Ink3"), IsHitTestVisible = false, Visibility = Visibility.Collapsed,
        };
        var grip = new Thumb
        {
            Style = (Style)FindResource("ResizeGrip"), Margin = new Thickness(0, 0, 4, 4),
            HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom,
            Visibility = _editing ? Visibility.Visible : Visibility.Collapsed,
        };
        var root = new Grid { RenderTransform = shift, Background = Brushes.Transparent, Cursor = _editing ? Cursors.SizeAll : null };
        root.Children.Add(new ContentControl { Content = content, Focusable = false });
        root.Children.Add(frame);
        root.Children.Add(grip);
        frame.Visibility = grip.Visibility;

        var remove = new Button
        {
            Style = (Style)FindResource("RemoveButton"), Margin = new Thickness(0, 4, 4, 0),
            HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top,
            Visibility = grip.Visibility, ToolTip = station is null ? "Fjern" : "Skjul på denne skærm",
        };
        remove.Click += (_, _) => RemoveTile(id);
        root.Children.Add(remove);

        _tiles[id] = new Tile(root, frame, grip, remove, shift, station);
        StationsGrid.Children.Add(root);

        root.MouseLeftButtonDown += (_, e) => OnTileDown(id, e);
        root.MouseMove += (_, e) => OnTileMove(id, e);
        root.MouseLeftButtonUp += (_, e) => OnTileUp(id, e);
        grip.DragStarted += (_, _) => OnGripStarted(id);
        grip.DragDelta += (_, _) => OnGripDelta(id);
        grip.DragCompleted += (_, _) => OnGripCompleted();
    }

    // With animate, blocks that change place glide there from where they were (a dropped block
    // from where it was let go) instead of jumping: measure, re-place, then play the difference back.
    void PlaceTiles(bool animate = true)
    {
        var before = _tiles.ToDictionary(t => t.Key, t => t.Value.Root.TranslatePoint(new Point(), StationsGrid));
        foreach (var p in _layout.Tiles)
        {
            var root = _tiles[p.Id].Root;
            Grid.SetColumn(root, p.Column);
            Grid.SetRow(root, p.Row);
            Grid.SetColumnSpan(root, p.ColumnSpan);
            Grid.SetRowSpan(root, p.RowSpan);
        }
        if (!animate) return;

        foreach (var t in _tiles.Values) Motion.Glide(t.Shift, new Vector());
        StationsGrid.UpdateLayout();
        foreach (var (id, t) in _tiles)
            if (before.TryGetValue(id, out var was)) Motion.Glide(t.Shift, was - t.Root.TranslatePoint(new Point(), StationsGrid));
    }

    void SaveLayout() => LayoutStore.Save(_layout, _vm.Widgets.Select(w => w.Spec), _hidden);

    void BuildGuides()
    {
        for (var i = 0; i < StationLayout.Columns * StationLayout.Rows; i++)
            Guides.Children.Add(new Border { Margin = new Thickness(6), CornerRadius = new CornerRadius(6), Background = (Brush)FindResource("Panel"), Opacity = 0.45 });
    }

    double CellWidth => StationsGrid.ActualWidth / StationLayout.Columns;
    double CellHeight => StationsGrid.ActualHeight / StationLayout.Rows;

    (int Column, int Row) CellAt(Point p) =>
        (Math.Clamp((int)(p.X / CellWidth), 0, StationLayout.Columns - 1), Math.Clamp((int)(p.Y / CellHeight), 0, StationLayout.Rows - 1));

    // ===== Adding and removing blocks =====

    // Built each time it opens: the hidden stations first, to put back, then the widgets.
    void BuildPicker()
    {
        PickerItems.Children.Clear();
        var hidden = _vm.Stations.Where(s => _hidden.Contains(StationId(s.Number))).ToList();
        if (hidden.Count > 0)
        {
            PickerItems.Children.Add(PickerHeader("Skjulte stationer"));
            foreach (var s in hidden) PickerItems.Children.Add(PickerItem(s.Name, () => ShowStation(s)));
            PickerItems.Children.Add(PickerHeader("Widgets"));
        }
        foreach (var (label, kind, metric, columns, rows) in WidgetViewModel.Catalog)
            PickerItems.Children.Add(PickerItem(label, () => AddWidget(new WidgetSpec(NewWidgetId(), kind, metric), columns, rows)));
        // A station's element document, one entry per station: a screen can show one next to its tile.
        PickerItems.Children.Add(PickerHeader("Dokument for station"));
        foreach (var s in _vm.Stations)
            PickerItems.Children.Add(PickerItem(s.Name, () => AddWidget(new WidgetSpec(NewWidgetId(), WidgetKind.Document, Station: s.Number), 4, 3)));
    }

    static string NewWidgetId() => $"widget-{Guid.NewGuid():N}"[..15];

    Button PickerItem(string label, Action click)
    {
        var item = new Button { Style = (Style)FindResource("PickerItem"), Content = label };
        item.Click += (_, _) => click();
        return item;
    }

    TextBlock PickerHeader(string text) => new()
    {
        Style = (Style)FindResource("TextBase"), Text = text.ToUpperInvariant(), FontSize = 12, FontWeight = FontWeights.Bold,
        Foreground = (Brush)FindResource("Ink3"), Margin = new Thickness(14, PickerItems.Children.Count == 0 ? 6 : 14, 14, 4),
    };

    void OnAddWidget(object sender, RoutedEventArgs e)
    {
        if (!Picker.IsOpen) BuildPicker();
        Picker.IsOpen = !Picker.IsOpen;
    }

    void AddWidget(WidgetSpec spec, int columns, int rows)
    {
        if (!TryPlaceNew(spec.Id, columns, rows)) return;
        var widget = _vm.AddWidget(MakeWidget(spec));
        if (widget is DocumentWidget d) d.Document.Follow(TargetFor(d.Station));
        Enter(spec.Id, widget, null);
    }

    // A hidden station comes back at its default size, or smaller if that is all there is room for.
    void ShowStation(StationViewModel station)
    {
        var id = StationId(station.Number);
        if (!TryPlaceNew(id, StationLayout.Columns / 4, StationLayout.Rows / 2)) return;
        _hidden.Remove(id);
        Enter(id, station, station.Number);
    }

    bool TryPlaceNew(string id, int columns, int rows)
    {
        Picker.IsOpen = false;
        if (_layout.TryAdd(id, columns, rows)) return true;
        EditHint.Text = "Der er ikke plads. Gør en blok mindre først, så der er mindst 2 x 2 felter fri.";
        EditHint.Foreground = (Brush)FindResource("Warn");
        return false;
    }

    void Enter(string id, object content, int? station)
    {
        CreateTile(id, content, station);
        PlaceTiles(animate: false);
        Motion.Enter(_tiles[id].Root, fromY: 16);
        SaveLayout();
        ResetHint();
    }

    // A widget is gone for good; a station is only hidden on this screen and can be put back from the picker.
    void RemoveTile(string id)
    {
        var tile = _tiles[id];
        tile.Root.IsHitTestVisible = false;
        Motion.Leave(tile.Root, toY: 12, done: () => StationsGrid.Children.Remove(tile.Root));
        _tiles.Remove(id);
        _layout.Remove(id);
        if (tile.Station is null) _vm.RemoveWidget(id);
        else _hidden.Add(id);
        SaveLayout();
    }

    void ResetHint()
    {
        EditHint.Text = "Træk en blok for at flytte den, slip den på en anden for at bytte. Træk i hjørnet for at ændre størrelsen.";
        EditHint.Foreground = (Brush)FindResource("Ink3");
    }

    // ===== Arranging =====

    Point? _dragFrom;
    bool _dragged;

    // The block on top: the one being dragged, and after its drop until the glides have ended. Put
    // down at once, the block it traded places with would glide away over it, and a press right
    // after the drop would grab that one instead of the block now lying there.
    Grid? _raised;
    readonly DispatcherTimer _lower = new() { Interval = Motion.Normal + TimeSpan.FromMilliseconds(40) };

    void Raise(Grid root)
    {
        Lower();
        _raised = root;
        Panel.SetZIndex(root, 1);
    }

    void Lower()
    {
        _lower.Stop();
        if (_raised is null) return;
        Panel.SetZIndex(_raised, 0);
        _raised = null;
    }

    void StartEditing()
    {
        CloseDocument();
        CloseStop();
        _editing = true;
        ShowReport(false);
        ResetHint();
        Caption.Visibility = Visibility.Collapsed;
        EditBar.Visibility = Visibility.Visible;
        Guides.Visibility = Visibility.Visible;
        Dots.Visibility = Visibility.Hidden;
        Motion.Enter(EditBar, fromY: -8);
        Motion.FadeIn(Guides, Motion.Normal);
        SetEditChrome(true);
    }

    void StopEditing()
    {
        _editing = false;
        Picker.IsOpen = false;
        Caption.Visibility = Visibility.Visible;
        EditBar.Visibility = Visibility.Collapsed;
        Guides.Visibility = Visibility.Collapsed;
        Dots.Visibility = Visibility.Visible;
        Motion.Enter(Caption, fromY: -8);
        Motion.FadeIn(Dots);
        SetEditChrome(false);
        SaveLayout();
    }

    void SetEditChrome(bool on)
    {
        var v = on ? Visibility.Visible : Visibility.Collapsed;
        foreach (var t in _tiles.Values)
        {
            t.Frame.Visibility = t.Grip.Visibility = v;
            t.Remove.Visibility = v;
            t.Root.Cursor = on ? Cursors.SizeAll : null;
            if (!on) continue;
            Motion.FadeIn(t.Frame);
            Motion.Pop(t.Grip, 0.4);
            Motion.Pop(t.Remove, 0.4);
        }
    }

    void OnEditDone(object sender, RoutedEventArgs e) => StopEditing();

    // Back to every station and nothing else, four to a row.
    void OnEditReset(object sender, RoutedEventArgs e)
    {
        foreach (var id in _vm.Widgets.Select(w => w.Id).ToList()) RemoveTile(id);
        var back = _vm.Stations.Where(st => _hidden.Contains(StationId(st.Number))).ToList();
        _hidden.Clear();
        foreach (var st in back) CreateTile(StationId(st.Number), st, st.Number);
        _layout = StationLayout.Default(_vm.Stations.Select(s => StationId(s.Number)));
        PlaceTiles();
        // The stations put back fade in where they land, instead of gliding in from a corner.
        foreach (var st in back)
        {
            var tile = _tiles[StationId(st.Number)];
            Motion.Glide(tile.Shift, new Vector());
            Motion.Enter(tile.Root);
        }
        SaveLayout();
        ResetHint();
    }

    void OnTileDown(string id, MouseButtonEventArgs e)
    {
        if (!_editing || e.OriginalSource is DependencyObject d && (IsInside<Thumb>(d) || IsInside<Button>(d))) return;
        _dragFrom = e.GetPosition(StationsGrid);
        _dragged = false;
        _tiles[id].Root.CaptureMouse();
        Raise(_tiles[id].Root);
        e.Handled = true;
    }

    void OnTileMove(string id, MouseEventArgs e)
    {
        if (_dragFrom is not { } from) return;
        var p = e.GetPosition(StationsGrid);
        var shift = _tiles[id].Shift;
        (shift.X, shift.Y) = (p.X - from.X, p.Y - from.Y);
        _dragged |= Math.Abs(shift.X) + Math.Abs(shift.Y) > 6;
    }

    void OnTileUp(string id, MouseButtonEventArgs e)
    {
        var tile = _tiles[id];
        if (!_editing)
        {
            // Demo: a tap on a station scans (its document button opens the document).
            // Otherwise a tap opens the station's document.
            // A tap on a row of a tile with several elements opens that element's document.
            if (tile.Station is { } n)
            {
                if (RowAt(e.OriginalSource) is { } tapped) OpenDocument(n, tapped.Code);
                else if (_demoInput) _demo.Scan(n);
                else OpenDocument(n);
            }
            // A document widget opens its station's full document, with the drawing big and every table.
            else if (_vm.Widgets.FirstOrDefault(w => w.Id == id) is DocumentWidget d) OpenDocument(d.Station);
            return;
        }
        if (_dragFrom is not { } from) return;

        tile.Root.ReleaseMouseCapture();
        // On top until the glide has ended (or at once, with animations off).
        if (Motion.On) _lower.Start();
        else Lower();
        var drop = e.GetPosition(StationsGrid);
        _dragFrom = null;
        if (!_dragged) { Motion.Glide(tile.Shift, new Vector(tile.Shift.X, tile.Shift.Y)); return; }

        // On another block: trade places. On free cells: move there, keeping where it was grabbed.
        var (col, row) = CellAt(drop);
        if (_layout.IdAt(col, row) is { } other && other != id)
        {
            _layout.Swap(id, other);
        }
        else
        {
            var p = _layout[id];
            var (grabCol, grabRow) = CellAt(from);
            _layout.TryMove(id, p.Column + col - grabCol, p.Row + row - grabRow);
        }
        PlaceTiles();
        SaveLayout();
    }

    // The size comes from where the pointer is on the grid, never from summed drag deltas:
    // the grip moves every time the block snaps, so deltas measured from it would drift and jump.
    void OnGripStarted(string id)
    {
        Ghost.Visibility = Visibility.Visible;
        OnGripDelta(id);
    }

    void OnGripDelta(string id)
    {
        var p = _layout[id];
        var at = Mouse.GetPosition(StationsGrid);
        var (left, top) = (p.Column * CellWidth, p.Row * CellHeight);

        Canvas.SetLeft(Ghost, left + 6);
        Canvas.SetTop(Ghost, top + 6);
        Ghost.Width = Math.Max(at.X - left - 6, CellWidth * StationLayout.MinSpan - 12);
        Ghost.Height = Math.Max(at.Y - top - 6, CellHeight * StationLayout.MinSpan - 12);

        // Snap the edge to the nearest cell line, then try the full size and each direction alone,
        // so the block slides along a neighbour instead of stopping dead.
        var columns = (int)Math.Round((at.X - left) / CellWidth);
        var rows = (int)Math.Round((at.Y - top) / CellHeight);
        if (columns == p.ColumnSpan && rows == p.RowSpan) return;
        if (_layout.TryResize(id, columns, rows) || _layout.TryResize(id, columns, p.RowSpan) || _layout.TryResize(id, p.ColumnSpan, rows))
            PlaceTiles();
    }

    void OnGripCompleted()
    {
        Ghost.Visibility = Visibility.Collapsed;
        SaveLayout();
    }

    // The row of a tile with several elements that a tap landed on, if any.
    static ActiveRowViewModel? RowAt(object source)
    {
        for (var d = source as DependencyObject; d is not null; d = d is Visual ? VisualTreeHelper.GetParent(d) : LogicalTreeHelper.GetParent(d))
            if (d is FrameworkElement { DataContext: ActiveRowViewModel row }) return row;
        return null;
    }

    static bool IsInside<T>(DependencyObject d) where T : DependencyObject
    {
        for (var x = d; x is not null; x = VisualTreeHelper.GetParent(x))
            if (x is T) return true;
        return false;
    }

    // ===== Pages =====

    void BuildDots()
    {
        foreach (var report in new[] { false, true })
        {
            var dot = new Button { Style = (Style)FindResource("DotButton"), ToolTip = report ? "Rapporter" : "Stationer" };
            dot.Click += (_, _) => ShowReport(report);
            _dots.Add(dot);
            Dots.Children.Add(dot);
        }
        DrawDots();
    }

    // Like the dashboards: the current page is a white dot in a ring, the others small and grey.
    void DrawDots(bool animate = false)
    {
        for (var i = 0; i < _dots.Count; i++)
        {
            var on = (i == 1) == _vm.ShowingReport;
            var g = new Grid { Width = 24, Height = 24 };
            if (on) g.Children.Add(new Ellipse { Stroke = Brushes.White, StrokeThickness = 2 });
            g.Children.Add(new Ellipse
            {
                Width = on ? 14 : 12, Height = on ? 14 : 12,
                Fill = on ? Brushes.White : (Brush)FindResource("Quiet"),
            });
            _dots[i].Content = g;
            if (on && animate) Motion.Pop(g);
        }
    }

    void ShowReport(bool report)
    {
        if (report && _editing) return;
        if (_vm.ShowingReport == report) return;
        _vm.ShowingReport = report;
        _lastTouch = DateTimeOffset.Now;

        var show = report ? (FrameworkElement)Reports : StationsGrid;
        var hide = report ? (FrameworkElement)StationsGrid : Reports;
        var way = report ? 1 : -1;
        Motion.Leave(hide, toX: -40 * way, done: () =>
        {
            // Only if no other switch came in the meantime.
            if (_vm.ShowingReport == report) hide.Visibility = Visibility.Collapsed;
        });
        show.Visibility = Visibility.Visible;
        Motion.Enter(show, fromX: 56 * way);
        if (report) Reports.PlayIn();
        DrawDots(animate: true);
    }

    // ===== Menu =====

    void OnLogo(object sender, RoutedEventArgs e)
    {
        if (MenuLayer.Visibility == Visibility.Visible) CloseMenu();
        else OpenMenu();
    }

    void OpenMenu()
    {
        if (_editing) return;
        MenuLayer.Visibility = Visibility.Visible;
        var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
        MenuShift.BeginAnimation(TranslateTransform.XProperty, new DoubleAnimation(500, 0, TimeSpan.FromMilliseconds(260)) { EasingFunction = ease });
        Scrim.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200)));
    }

    void CloseMenu()
    {
        if (MenuLayer.Visibility != Visibility.Visible) return;
        var slide = new DoubleAnimation(0, 500, TimeSpan.FromMilliseconds(200)) { EasingFunction = new CubicEase { EasingMode = EasingMode.EaseIn } };
        slide.Completed += (_, _) => MenuLayer.Visibility = Visibility.Collapsed;
        MenuShift.BeginAnimation(TranslateTransform.XProperty, slide);
        Scrim.BeginAnimation(OpacityProperty, new DoubleAnimation(0, TimeSpan.FromMilliseconds(200)));
    }

    // A tap beside the menu closes it on the release, so the release is not a tap on the tile below.
    bool _scrimPressed;

    void OnScrimDown(object sender, MouseButtonEventArgs e)
    {
        _scrimPressed = true;
        e.Handled = true;
    }

    void OnScrimUp(object sender, MouseButtonEventArgs e)
    {
        e.Handled = true;
        if (!_scrimPressed) return;
        _scrimPressed = false;
        CloseMenu();
    }

    // ===== Window =====

    // Up from minimized, behind something or off screen. A kiosk comes back full screen.
    public void BringUp()
    {
        if (WindowState == WindowState.Minimized) WindowState = _kiosk ? WindowState.Maximized : WindowState.Normal;
        Show();
        Activate();
    }

    // A kiosk that is not the window in front hears no scanner in keyboard mode, until someone
    // touches the screen. So when another program has the foreground, the kiosk takes it back a
    // moment later, and keeps trying until it has it. Not while the app is closing or Windows is
    // shutting down, and not from the app's own tray menu or another window of the app. The PIN
    // prompt and the "Luk" confirm are part of this window, so they are never in its way.
    // Windows' own taskbar and Start menu are left in front for longer: that is the way to the tray
    // icon and its "Luk", the one way to close a kiosk, and it takes a person more than a moment.
    static readonly TimeSpan ShellGrace = TimeSpan.FromSeconds(20);
    readonly DispatcherTimer _front = new() { Interval = TimeSpan.FromMilliseconds(1500) };
    DateTimeOffset _lostFront;
    bool _inFront;

    void TakeFront()
    {
        if (App.Exiting) { _front.Stop(); return; }
        // In front as Windows sees it: IsActive alone is also true for a window that was shown
        // without getting the foreground.
        if (Ui.IsInFront(this)) { _inFront = true; return; }
        if (_inFront) { _inFront = false; _lostFront = DateTimeOffset.Now; }
        if (App.TrayMenuOpen || Application.Current.Windows.OfType<Window>().Any(w => w != this && w.IsVisible)) return;
        if (DateTimeOffset.Now - _lostFront < ShellGrace && Ui.ShellIsInFront()) return;
        Ui.TakeForeground(this);
        if (!Ui.IsInFront(this)) return;
        _inFront = true;
        // On the window itself, so the scanner's keys are heard.
        if (Keyboard.FocusedElement is null) Keyboard.Focus(this);
        Log.Write("Kiosk: another program was in front, took the foreground back");
    }

    // ===== Close from the tray =====

    // What the open "Luk" confirm runs when it is said yes to. Null: no confirm open.
    Action? _confirmedClose;

    // The tray's "Luk": asks first, as a slip of the mouse would stop the scans.
    public void ConfirmClose(Action close)
    {
        CloseMenu();
        CloseStop();
        _lastTouch = DateTimeOffset.Now;
        // Out of any field, so Esc reaches the confirm.
        Keyboard.Focus(this);
        _confirmedClose = close;
        CloseLayer.Visibility = Visibility.Visible;
        Motion.FadeIn(CloseLayer, Motion.Normal);
        Motion.Enter(CloseCard, fromY: 16);
    }

    void OnCloseConfirm(object sender, RoutedEventArgs e)
    {
        var close = _confirmedClose;
        HideClose();
        close?.Invoke();
    }

    void OnCloseCancel(object sender, RoutedEventArgs e) => HideClose();

    void OnCloseScrim(object sender, MouseButtonEventArgs e) => HideClose();

    void HideClose()
    {
        _confirmedClose = null;
        CloseLayer.Visibility = Visibility.Collapsed;
    }

    // A kiosk closes only through the app (the tray's "Luk", a restart, an update): Alt+F4 and the
    // like are turned down. Outside kiosk mode, closing the window is someone closing the app.
    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        base.OnClosing(e);
        if (e.Cancel || App.Exiting) return;
        if (_kiosk) { e.Cancel = true; Log.Write("Close turned down: a kiosk closes from the tray"); }
        else App.NoteClosedByUser();
    }

    // No title bar: outside kiosk mode the empty space moves the window, a double click maximizes.
    void OnPageMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (_kiosk || _editing || e.OriginalSource != Root && e.OriginalSource != StationsGrid) return;
        if (e.ClickCount == 2) ToggleMaximized();
        else DragMove();
    }

    void ToggleMaximized() =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    // Demo: 1 to 7 scans with that scanner, Shift scans a different element, Ctrl takes the scanner
    // away and back; in a dev build Alt+V ends every station's shift now. Left and Right change page. Esc closes the menu or layout mode first;
    // outside kiosk mode it then closes the app, and F11 fills the screen.
    protected override void OnPreviewKeyDown(KeyEventArgs e)
    {
        base.OnPreviewKeyDown(e);
        _lastTouch = DateTimeOffset.Now;

        // A scanner in keyboard mode types its barcode; those keys are a scan, not shortcuts.
        if (_keyboard.OnKeyDown(e)) { e.Handled = true; return; }

        if (e.Key == Key.Escape)
        {
            // Esc on an open dropdown closes just the dropdown, not the setup with everything typed in it.
            if (Ui.IsDropDownOpen()) return;
            if (Pin.IsOpen) { Pin.Cancel(); return; }
            if (_confirmedClose is not null) { HideClose(); return; }
            if (Setup.IsOpen) { Setup.Cancel(); return; }
            if (_stopping is not null) { CloseStop(); return; }
            if (Document.IsOpen) { CloseDocument(); return; }
            if (MenuLayer.Visibility == Visibility.Visible) CloseMenu();
            else if (_editing) StopEditing();
            else if (!_kiosk) Close();
            return;
        }
        // The PIN prompt takes the keyboard: its digits come through _keyboard.Typed, once it is
        // clear they were typed and not scanned.
        if (Pin.IsOpen)
        {
            if (e.Key == Key.Enter) Pin.Submit();
            else if (e.Key == Key.Back) Pin.Back();
            e.Handled = true;
            return;
        }
        if (Setup.IsOpen) return;
        if (!_kiosk && e.Key == Key.F11) { ToggleMaximized(); return; }
#if DEBUG
        // Demo of the stop at shift end: every station's shift ends now, with 1 minute's grace.
        if (e.Key == Key.System && e.SystemKey == Key.V)
        {
            _demoShift = DemoScanner.ShiftEndingNow(DateTimeOffset.Now);
            Log.Write("Demo: vagtslut nu på alle stationer, 1 min. ventetid");
            CheckShiftEnd(DateTimeOffset.Now);
            e.Handled = true;
            return;
        }
#endif
        if (e.Key is Key.Left or Key.Right) { ShowReport(e.Key == Key.Right); return; }

        var n = e.Key switch
        {
            >= Key.D1 and <= Key.D7 => e.Key - Key.D0,
            >= Key.NumPad1 and <= Key.NumPad7 => e.Key - Key.NumPad0,
            _ => 0,
        };
        if (n == 0) return;

        // Plain 1 to 7 come back through _keyboard.Typed, once it is clear they were not a scan.
        if (!_demoInput) return;
        if (Keyboard.Modifiers.HasFlag(ModifierKeys.Control)) _demo.ToggleScanner(n);
        else if (Keyboard.Modifiers.HasFlag(ModifierKeys.Shift)) _demo.Scan(n, otherElement: true);
        else return;
        e.Handled = true;
    }
}
