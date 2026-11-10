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
using Ventisol.Station.Updates;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

public partial class MainWindow : Window
{
    // The report page goes back to the stations after this long without a touch.
    static readonly TimeSpan ReportIdle = TimeSpan.FromSeconds(60);
    // An open document goes back to the stations after this long without a touch.
    static readonly TimeSpan DocumentIdle = TimeSpan.FromMinutes(3);

    readonly StationSettings _settings = SettingsStore.Load();
    readonly MainViewModel _vm;
    readonly DemoScanner _demo;
    readonly KeyboardScanSource _keyboard = new();
    readonly ScanSources _scans;
    readonly CloudSync _cloud;
    readonly UpdateService _updates;
    readonly OrderDocuments _documents;
    readonly OrderDocumentViewModel _document;
    // The scans this screen sent in the last 36 hours, so a load from OptiCloud never drops one.
    readonly List<ScanEvent> _recorded = [];
    // Taps and number keys make up scans only while OptiCloud is not set up, so a station
    // on the shop floor never sends a made-up scan.
    readonly bool _demoInput;

    static readonly string DataFolder = AppPaths.Data;
    readonly DispatcherTimer _clock = new() { Interval = TimeSpan.FromMilliseconds(250) };
    readonly bool _kiosk;
    readonly Dictionary<string, Tile> _tiles = [];
    readonly List<Button> _dots = [];

    StationLayout _layout;
    bool _editing;
    DateTimeOffset _lastTouch = DateTimeOffset.Now;

    // A block on the stations page: a station or a widget, plus the frame, grip and (for widgets)
    // remove button shown while arranging. Station is the scanner number, for a tap to scan in the demo.
    sealed record Tile(Grid Root, Rectangle Frame, Thumb Grip, Button? Remove, TranslateTransform Shift, int? Station);

    static string StationId(int number) => $"station-{number}";

    public MainWindow(bool kiosk, bool showcase)
    {
        InitializeComponent();
        _vm = new MainViewModel(_settings.Stations.Select(s => s.Config));
        DataContext = _vm;
        _demo = new DemoScanner(_vm);
        _kiosk = kiosk;

        var (layout, widgets) = LayoutStore.Load([.. _vm.Stations.Select(s => StationId(s.Number))]);
        _layout = layout;
        foreach (var spec in widgets) _vm.AddWidget(spec);
        _documents = new OrderDocuments(new OrderDocumentLocator(_settings.DocumentsFolder));
        _document = new OrderDocumentViewModel(_documents);
        foreach (var s in _vm.Stations) s.DocumentsOn = _documents.IsOn;
        Document.Attach(_document, _vm.Stations);
        Document.CloseRequested += (_, _) => CloseDocument();
        BuildTiles();
        BuildGuides();
        BuildDots();
        BuildPicker();
        _demoInput = !_settings.IsConnected;
        // Sample scans would be sent to OptiCloud like real ones, so only without it.
        if (showcase && _demoInput) _demo.Showcase(DateTimeOffset.Now);

        if (kiosk)
        {
            ResizeMode = ResizeMode.NoResize;
            WindowState = WindowState.Maximized;
            Topmost = true;
        }
        else
        {
            WindowPlacement.Track(this);
            SourceInitialized += (_, _) => Ui.RoundCorners(this);
        }

        Menu.CloseRequested += (_, _) => CloseMenu();
        Menu.ArrangeRequested += (_, _) => { CloseMenu(); StartEditing(); };
        Menu.SetupRequested += (_, _) => { CloseMenu(); OpenSetup(); };

        // A scan always brings the stations back, so its answer is seen. An open document stays open
        // (its strip shows the answer) and follows its station to a new element.
        _vm.Scanned += (_, _) => { CloseMenu(); ShowReport(false); FollowDocument(); };
        // The document of an element scanned in is fetched now, so a tap on the station shows it at once.
        _vm.Recorded += (_, r) => { if (r.Kind == ScanKind.In) PrefetchDocument(r.Barcode); };

        _clock.Tick += (_, _) => OnTick();
        _clock.Start();

        // A viewer has no scanners; the keyboard source stays for the demo keys.
        _scans = _settings.Mode == StationMode.Scan
            ? new ScanSources(new ComPortScanSource(Log.Write), _keyboard)
            : new ScanSources(_keyboard);
        _scans.OnError = (_, ex) => Log.Write($"Scanner source failed: {ex.Message}");
        _scans.Scanned += (_, scan) => Dispatcher.BeginInvoke(() => OnRawScan(scan));
        _scans.ConnectionChanged += (_, _) => Dispatcher.BeginInvoke(OnScannersChanged);
        _keyboard.Typed += (_, c) => { if (_demoInput && c is >= '1' and <= '7') _demo.Scan(c - '0'); };
        _scans.Start();
        OnScannersChanged();

        _cloud = new CloudSync(_settings, SettingsStore.LoadPassword(), DataFolder, Log.Write);
        _cloud.StatusChanged += (_, _) => Dispatcher.BeginInvoke(ShowCloudStatus);
        _cloud.Loaded += (_, loaded) => Dispatcher.BeginInvoke(() => ApplyLoaded(loaded));
        _vm.Recorded += (_, r) =>
        {
            var machine = _settings.Stations.FirstOrDefault(s => s.Number == r.Station.Number)?.MachineId;
            if (ScanEvent.From(r, machine) is not { } e) return;
            _recorded.Add(e);
            _recorded.RemoveAll(x => x.At < CloudSync.WindowStart(e.At));
            if (!_cloud.Record(e)) Log.Write($"Scan not saved for sending: {e.Barcode.Raw} {e.Direction}");
        };
        // After every scan (a switch included) each machine follows its station's state.
        _vm.Scanned += (_, _) => SendMachineOrders();
        ShowCloudStatus();
        _cloud.Start();
        Log.Write($"Started {_vm.Version}, {_settings.Mode}, OptiCloud {(_settings.IsConnected ? "set up" : "not set up")}");

        // An update restarts the app, so it waits until no scan has come in for 10 minutes (or night).
        _updates = new UpdateService(UpdateService.DefaultUrl, () => DateTimeOffset.Now - _vm.LastScanAt > TimeSpan.FromMinutes(10), Log.Write);
        _updates.StatusChanged += (_, text) => _vm.UpdateText = text;
        _updates.Start();
        _vm.UpdateText = _updates.Status;

        Closed += (_, _) => { _scans.Dispose(); _cloud.Dispose(); _updates.Dispose(); };
    }

    // What OptiCloud (or, before the network is there, this PC's journal) holds, plus every scan this
    // screen took since. Worked out here on the UI thread, so a scan that came in while the load was
    // on its way is in it, never undone by it.
    void ApplyLoaded(LoadedScans loaded)
    {
        var now = DateTimeOffset.Now;
        var events = loaded.Events.Concat(_recorded.Where(e => e.At >= loaded.Since));
        _vm.Apply(ScanReplay.Replay(events, _vm.Stations.Select(s => s.Config), CloudSync.Midnight(now)), now);
        SendMachineOrders(loaded.FromCloud);
        foreach (var s in _vm.Stations)
            if (s.Current is { } b) PrefetchDocument(b);
        FollowDocument();
    }

    // Each mapped machine in OptiPeople gets the element in progress at its station, else none.
    // CloudSync sends it in the background, only in Scan mode with OptiCloud set up, and not before
    // the screen has been rebuilt from OptiCloud (fromCloud).
    void SendMachineOrders(bool fromCloud = false)
    {
        if (_settings.Mode != StationMode.Scan) return;
        _cloud.SetMachineOrders(MachineOrders.DesiredFrom(_settings.Stations, _vm.Stations.Select(s => s.State)), fromCloud);
    }

    void ShowCloudStatus()
    {
        var status = _cloud.Status;
        _vm.CloudText = status.Text;
        _vm.CloudHealth = status.State switch { CloudState.Online => "Ok", CloudState.Error => "Alarm", _ => "Warn" };
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
        // Only a station waiting in "Identificér" takes a scan from the setup; any other scan is work
        // at a station and counts, also while someone has the setup open.
        if (Setup.ViewModel is { } setup && setup.Stations.Any(s => s.IsIdentifying)) { setup.OnRawScan(scan); return; }
        if (StationFor(scan.ScannerId) is { } n) _vm.Scan(n, scan.Raw, scan.At);
        else Log.Write($"Scan from scanner {scan.ScannerId}, which no station has: {scan.Raw}");
    }

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

    // ===== Setup =====

    void OpenSetup()
    {
        if (_editing || Setup.IsOpen) return;
        var vm = new SetupViewModel(SettingsStore.Load(), SettingsStore.LoadPassword(),
            testConnection: (s, pw, ct) => CloudSync.TestConnectionAsync(s, pw, ct),
            loadMachines: (s, pw, ct) => CloudSync.LoadMachinesAsync(s, pw, ct),
            connectedScanners: () => _scans.Connected,
            scannerPort: id => _scans.Sources.OfType<ComPortScanSource>().FirstOrDefault()?.PortOf(id));
        vm.Saved += (settings, newPassword) =>
        {
            SettingsStore.Save(settings);
            if (newPassword is not null) SettingsStore.SavePassword(newPassword);
            // Stations, mode and the OptiCloud login are read at start, so start again with the new ones.
            Restart();
        };
        Setup.Open(vm);
    }

    void Restart()
    {
        // The new one uses the same outbox folder, so this one lets go of it first.
        _cloud.Dispose();
        _scans.Dispose();
        App.Restart();
    }

    void OnTick()
    {
        var now = DateTimeOffset.Now;
        _vm.Tick(now);
        if (_vm.ShowingReport && now - _lastTouch > ReportIdle) ShowReport(false);
        if (Document.IsOpen)
        {
            if (now - _lastTouch > DocumentIdle) CloseDocument();
            else _document.UpdateStatus(now);
        }
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

    // What a station's document shows: the element in progress there, else the last one done there today.
    DocumentTarget TargetFor(int station)
    {
        var s = _vm.Stations.First(x => x.Number == station);
        if (s.State.Current is { } current) return new(s.Name, current, true, s.State.StartedAt);
        if (_vm.LastDoneAt(station) is { } last) return new(s.Name, last.Barcode, false, last.End);
        return new(s.Name, null, false, null);
    }

    void OpenDocument(int station)
    {
        if (_editing || Setup.IsOpen) return;
        CloseMenu();
        _lastTouch = DateTimeOffset.Now;
        if (Document.Station != station) _document.Show(TargetFor(station));
        Document.Open(station);
    }

    void CloseDocument()
    {
        if (!Document.IsOpen) return;
        Document.Close();
        // Back on the window, so a keyboard-mode scanner is heard (as after the setup).
        Keyboard.Focus(this);
    }

    void FollowDocument()
    {
        if (Document.Station is { } n) _document.Follow(TargetFor(n));
    }

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

        foreach (var station in _vm.Stations) CreateTile(StationId(station.Number), station, station.Number);
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

        Button? remove = null;
        if (station is null)
        {
            remove = new Button
            {
                Style = (Style)FindResource("RemoveButton"), Margin = new Thickness(0, 4, 4, 0),
                HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top,
                Visibility = grip.Visibility, ToolTip = "Fjern",
            };
            remove.Click += (_, _) => RemoveWidget(id);
            root.Children.Add(remove);
        }

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

    void SaveLayout() => LayoutStore.Save(_layout, _vm.Widgets.Select(w => w.Spec));

    void BuildGuides()
    {
        for (var i = 0; i < StationLayout.Columns * StationLayout.Rows; i++)
            Guides.Children.Add(new Border { Margin = new Thickness(6), CornerRadius = new CornerRadius(6), Background = (Brush)FindResource("Panel"), Opacity = 0.45 });
    }

    double CellWidth => StationsGrid.ActualWidth / StationLayout.Columns;
    double CellHeight => StationsGrid.ActualHeight / StationLayout.Rows;

    (int Column, int Row) CellAt(Point p) =>
        (Math.Clamp((int)(p.X / CellWidth), 0, StationLayout.Columns - 1), Math.Clamp((int)(p.Y / CellHeight), 0, StationLayout.Rows - 1));

    // ===== Widgets =====

    void BuildPicker()
    {
        foreach (var (label, kind, metric, columns, rows) in WidgetViewModel.Catalog)
        {
            var item = new Button { Style = (Style)FindResource("PickerItem"), Content = label };
            item.Click += (_, _) => AddWidget(new WidgetSpec($"widget-{Guid.NewGuid():N}"[..15], kind, metric), columns, rows);
            PickerItems.Children.Add(item);
        }
    }

    void OnAddWidget(object sender, RoutedEventArgs e) => Picker.IsOpen = !Picker.IsOpen;

    void AddWidget(WidgetSpec spec, int columns, int rows)
    {
        Picker.IsOpen = false;
        if (!_layout.TryAdd(spec.Id, columns, rows))
        {
            EditHint.Text = "Der er ikke plads. Gør en blok mindre først, så der er mindst 2 x 2 felter fri.";
            EditHint.Foreground = (Brush)FindResource("Warn");
            return;
        }
        CreateTile(spec.Id, _vm.AddWidget(spec), null);
        PlaceTiles(animate: false);
        Motion.Enter(_tiles[spec.Id].Root, fromY: 16);
        SaveLayout();
        ResetHint();
    }

    void RemoveWidget(string id)
    {
        var root = _tiles[id].Root;
        root.IsHitTestVisible = false;
        Motion.Leave(root, toY: 12, done: () => StationsGrid.Children.Remove(root));
        _tiles.Remove(id);
        _layout.Remove(id);
        _vm.RemoveWidget(id);
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

    void StartEditing()
    {
        CloseDocument();
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
            if (t.Remove is { } r) r.Visibility = v;
            t.Root.Cursor = on ? Cursors.SizeAll : null;
            if (!on) continue;
            Motion.FadeIn(t.Frame);
            Motion.Pop(t.Grip, 0.4);
            if (t.Remove is { } x) Motion.Pop(x, 0.4);
        }
    }

    void OnEditDone(object sender, RoutedEventArgs e) => StopEditing();

    // Back to the stations only, four to a row.
    void OnEditReset(object sender, RoutedEventArgs e)
    {
        foreach (var id in _vm.Widgets.Select(w => w.Id).ToList()) RemoveWidget(id);
        _layout = StationLayout.Default(_vm.Stations.Select(s => StationId(s.Number)));
        PlaceTiles();
        SaveLayout();
        ResetHint();
    }

    void OnTileDown(string id, MouseButtonEventArgs e)
    {
        if (!_editing || e.OriginalSource is DependencyObject d && (IsInside<Thumb>(d) || IsInside<Button>(d))) return;
        _dragFrom = e.GetPosition(StationsGrid);
        _dragged = false;
        _tiles[id].Root.CaptureMouse();
        Panel.SetZIndex(_tiles[id].Root, 1);
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
            if (tile.Station is { } n)
            {
                if (_demoInput) _demo.Scan(n);
                else OpenDocument(n);
            }
            return;
        }
        if (_dragFrom is not { } from) return;

        tile.Root.ReleaseMouseCapture();
        Panel.SetZIndex(tile.Root, 0);
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

    void OnScrim(object sender, MouseButtonEventArgs e) => CloseMenu();

    // ===== Window =====

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
    // away and back. Left and Right change page. Esc closes the menu or layout mode first;
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
            if (Setup.IsOpen) { Setup.Cancel(); return; }
            if (Document.IsOpen) { CloseDocument(); return; }
            if (MenuLayer.Visibility == Visibility.Visible) CloseMenu();
            else if (_editing) StopEditing();
            else if (!_kiosk) Close();
            return;
        }
        if (Setup.IsOpen) return;
        if (!_kiosk && e.Key == Key.F11) { ToggleMaximized(); return; }
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
