using System.Collections.ObjectModel;
using System.Reflection;
using CommunityToolkit.Mvvm.ComponentModel;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.ViewModels;

public sealed partial class MainViewModel : ObservableObject
{
    DateTimeOffset _reportRefreshed, _widgetsRefreshed;
    DateTime _day = DateTime.Today;
    // Apply has run once: what it reads after that is new to the screen.
    bool _applied;

    public MainViewModel(IEnumerable<StationConfig> stations)
    {
        Stations = [.. stations.Select(s => new StationViewModel(s))];
        Report = new ReportViewModel(this);
        Tick(DateTimeOffset.Now);
    }

    public IReadOnlyList<StationViewModel> Stations { get; }
    public ReportViewModel Report { get; }

    // Clocks, numbers and lists placed among the stations.
    public ObservableCollection<WidgetViewModel> Widgets { get; } = [];

    // What is done today, as OptiCloud has it (every station, every PC), plus this screen's own
    // scans since it was last read. The widgets and the report count from it.
    public List<WorkRecord> History { get; } = [];

    public string Version { get; } =
        Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "?";

    [ObservableProperty] public partial string ClockText { get; private set; } = "";
    [ObservableProperty] public partial string DateText { get; private set; } = "";
    [ObservableProperty] public partial bool ShowingReport { get; set; }

    // The menu's OptiCloud and update rows. Health colours the dot: Ok, Warn or Alarm.
    [ObservableProperty] public partial string CloudText { get; set; } = "Ikke sat op";
    [ObservableProperty] public partial string CloudHealth { get; set; } = "Warn";
    [ObservableProperty] public partial string UpdateText { get; set; } = "Ikke installeret";

    // The screen's role, as set up. A viewer has no scanners, so the menu leaves their rows out.
    public bool IsViewer { get; init; }
    public bool ShowsScanners => !IsViewer;
    public string RoleText => IsViewer ? "Visning" : "Scanstation";
    // What a free station says. Nobody scans at a viewer, so it doesn't ask for a scan (CloudHealth.IdleText).
    [ObservableProperty] public partial string IdleText { get; set; } = "Scan et element";

    // The line over the stations when OptiCloud can't be reached (CloudHealth), else null.
    [ObservableProperty] public partial string? BannerText { get; set; }

    // When the last scan came in anywhere, so updates wait for a quiet moment.
    public DateTimeOffset LastScanAt { get; private set; } = DateTimeOffset.MinValue;

    // Raised for each scan in and scan out a station accepted: what goes to OptiCloud.
    public event EventHandler<ScanResult>? Recorded;

    // Raised for every scan that reaches a station, read or not.
    public event EventHandler? Scanned;

    // Raised for every scan that reaches a station (read, refused, unreadable or a repeat): activity
    // there, which moves a stop at shift end on (docs/plan-shift-end.md §4.1). The station's number.
    public event EventHandler<(int Station, DateTimeOffset At)>? Activity;

    readonly RepeatScans _repeats = new();

    // Whether an order is known to exist (an order PDF), to read a label that fits both barcode layouts.
    public Func<int, bool>? OrderExists { get; init; }

    // The highest order number known to exist (the newest order PDF), or null: what keeps a retail
    // code that reads as an order far above it from passing as an element.
    public Func<int?>? NewestOrder { get; init; }

    // The order of the last element read here (kept across restarts by the window), or else of the last
    // one done today: the work going on now.
    int? _lastOrder;
    public int? LastOrder { get => _lastOrder; init => _lastOrder = value; }
    OrderHints Hints => new(OrderExists, _lastOrder ?? History.MaxBy(r => r.End)?.Barcode.Order, NewestOrder?.Invoke());

    // Raised when a scan reads an order other than the last one, so the window can keep it.
    public event EventHandler<int>? LastOrderChanged;

    // A scan from scanner n. The raw text is exactly what the scanner sent.
    public void Scan(int scannerNumber, string raw, DateTimeOffset now)
    {
        var station = Stations.FirstOrDefault(s => s.Number == scannerNumber);
        if (station is null) return;
        LastScanAt = now;
        Activity?.Invoke(this, (station.Number, now));

        // A new scan: the strict reading, so a retail code on a box is not taken for an element.
        // An element in progress at this station (any of them) is read whatever its order, so it can
        // always be scanned out; its order is not noted as the last one (the strict rules never passed it).
        var strict = Barcode.TryParseScan(raw, out var barcode, Hints);
        if (!strict) Barcode.TryParseInProgress(raw, station.State.Active.Select(a => a.Barcode), out barcode, Hints);
        if (barcode is not null)
        {
            if (strict && _lastOrder != barcode.Order)
            {
                _lastOrder = barcode.Order;
                LastOrderChanged?.Invoke(this, barcode.Order);
            }
            // The scanner read the label twice: the second read would scan it straight out again.
            if (_repeats.IsRepeat(station.Number, barcode, now)) return;
            var result = station.Scan(barcode, now);
            if (result is { Kind: ScanKind.Out, Duration: { } d })
                History.Add(new WorkRecord(result.Station, barcode, now - d, now));
            else if (result is { Kind: ScanKind.Switched, Duration: { } switchDuration, Previous: { } previous })
            {
                // Record the stopped order in history
                History.Add(new WorkRecord(result.Station, previous, now - switchDuration, now));
                // Record both Out for previous and In for new order
                Record(station, new ScanResult(ScanKind.Out, result.Station, previous, now, switchDuration));
                Record(station, new ScanResult(ScanKind.In, result.Station, barcode, now));
            }
            if (result.Kind is ScanKind.In or ScanKind.Out) Record(station, result);
        }
        else
        {
            station.Unreadable(raw.Trim(), now);
        }
        Scanned?.Invoke(this, EventArgs.Empty);
    }

    // The element barcode at station was stopped in OptiPeople or by hand on its tile: it ends there as
    // an Out, recorded like a scan's. Not a scan: no Scanned, and updates don't wait for it. False when
    // the station no longer has that element in progress (it was scanned out or switched meanwhile).
    // At a station with several in progress only that one ends.
    public bool Stop(int station, string barcode, StopReason reason, DateTimeOffset now)
    {
        var s = Stations.FirstOrDefault(x => x.Number == station);
        if (s?.Stop(barcode, reason, now) is not { } result) return false;
        if (result.Duration is { } d) History.Add(new WorkRecord(result.Station, result.Barcode, now - d, now));
        Record(s, result);
        return true;
    }

    // Every element in progress at station stops at at, the stop at shift end (docs/plan-shift-end.md
    // §4.2): an Out each with Event ShiftEnd and its derived ScanId, raised as Recorded in In order,
    // then kept as done. Not a scan: no Scanned, LastScanAt unchanged. The rows, none when nothing was
    // in progress (the window logs them, with the shift end they follow).
    public IReadOnlyList<ScanResult> ShiftEnd(int station, DateTimeOffset at, DateTimeOffset now)
    {
        if (Stations.FirstOrDefault(x => x.Number == station) is not { } s) return [];
        var results = s.ShiftEnd(at, now);
        foreach (var r in results) Recorded?.Invoke(this, r);
        foreach (var r in results) History.Add(new WorkRecord(r.Station, r.Barcode, at - (r.Duration ?? TimeSpan.Zero), at, ScanEventKind.ShiftEnd));
        _widgetsRefreshed = _reportRefreshed = DateTimeOffset.MinValue;
        return results;
    }

    // An In gets its ScanId here, so the station knows it (StationState.NoteInScanId): a stop at
    // shift end derives its own from it.
    void Record(StationViewModel station, ScanResult r)
    {
        if (r is { Kind: ScanKind.In, ScanId: null })
        {
            r = r with { ScanId = Guid.NewGuid() };
            station.State.NoteInScanId(r.Barcode.Raw, r.ScanId!.Value);
        }
        Recorded?.Invoke(this, r);
    }

    // The latest stop at shift end per station, as the rows have it. flash: new stops flash (a viewer).
    public void ApplyAutoStopped(IReadOnlyDictionary<int, AutoStop> stops, DateTimeOffset now, bool flash)
    {
        foreach (var s in Stations) s.ApplyAutoStop(stops.GetValueOrDefault(s.Number), now, flash);
    }

    // The last element finished at a station today, if any.
    public WorkRecord? LastDoneAt(int station) =>
        History.Where(r => r.Station.Number == station).MaxBy(r => r.End);

    // Today as OptiCloud has it: on start, so a restart loses nothing, and on a viewer every few seconds.
    public void Apply(ReplayResult today, DateTimeOffset now)
    {
        History.Clear();
        History.AddRange(today.Done);
        foreach (var s in Stations)
        {
            s.Restore(today.InProgress.GetValueOrDefault(s.Number) ?? [], now);
        }
        // A viewer sees a stop at shift end when its row arrives; the first read only shows the idle line.
        ApplyAutoStopped(today.AutoStopped, now, flash: IsViewer && _applied);
        _applied = true;
        _widgetsRefreshed = _reportRefreshed = DateTimeOffset.MinValue;
    }

    // OptiCloud read again on a scan station: what is done today follows it, so the widgets and the
    // report count other PCs' scans too. The stations here keep their own state: they take the scans.
    public void ApplyDone(ReplayResult today)
    {
        History.Clear();
        History.AddRange(today.Done);
        _widgetsRefreshed = _reportRefreshed = DateTimeOffset.MinValue;
    }

    public void Tick(DateTimeOffset now)
    {
        // The report is about today: at midnight what finished yesterday drops off.
        if (now.Date != _day)
        {
            _day = now.Date;
            History.RemoveAll(r => r.End.Date < _day);
        }

        ClockText = now.ToString("HH':'mm");
        DateText = now.ToString("dddd d. MMMM");
        foreach (var s in Stations) s.Tick(now);

        if (Widgets.Count > 0 && now - _widgetsRefreshed >= TimeSpan.FromSeconds(1)) RefreshWidgets(now);

        if (ShowingReport && now - _reportRefreshed >= TimeSpan.FromSeconds(1))
        {
            Report.Refresh(now);
            _reportRefreshed = now;
        }
    }

    public WidgetViewModel AddWidget(WidgetViewModel w)
    {
        Widgets.Add(w);
        RefreshWidgets(DateTimeOffset.Now);
        return w;
    }

    public void RemoveWidget(string id)
    {
        if (Widgets.FirstOrDefault(w => w.Id == id) is not { } w) return;
        Widgets.Remove(w);
        if (w is DocumentWidget d) d.Document.Close();
    }

    void RefreshWidgets(DateTimeOffset now)
    {
        var states = Stations.Select(s => s.State).ToList();
        var orders = DayReport.Orders(History, states, now);
        var kpis = DayReport.Totals(History, states, now);
        foreach (var w in Widgets) w.Update(now, kpis, orders);
        _widgetsRefreshed = now;
    }

    partial void OnShowingReportChanged(bool value)
    {
        if (value) { Report.Refresh(DateTimeOffset.Now); _reportRefreshed = DateTimeOffset.Now; }
    }
}
