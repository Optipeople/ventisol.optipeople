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

    readonly RepeatScans _repeats = new();

    // Whether an order is known to exist (an order PDF), to read a label that fits both barcode layouts.
    public Func<int, bool>? OrderExists { get; init; }

    // The order of the last element read here (kept across restarts by the window), or else of the last
    // one done today: the work going on now.
    int? _lastOrder;
    public int? LastOrder { get => _lastOrder; init => _lastOrder = value; }
    OrderHints Hints => new(OrderExists, _lastOrder ?? History.MaxBy(r => r.End)?.Barcode.Order);

    // Raised when a scan reads an order other than the last one, so the window can keep it.
    public event EventHandler<int>? LastOrderChanged;

    // A scan from scanner n. The raw text is exactly what the scanner sent.
    public void Scan(int scannerNumber, string raw, DateTimeOffset now)
    {
        var station = Stations.FirstOrDefault(s => s.Number == scannerNumber);
        if (station is null) return;
        LastScanAt = now;

        if (Barcode.TryParse(raw, out var barcode, Hints))
        {
            if (_lastOrder != barcode.Order)
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
                Recorded?.Invoke(this, new ScanResult(ScanKind.Out, result.Station, previous, now, switchDuration));
                Recorded?.Invoke(this, new ScanResult(ScanKind.In, result.Station, barcode, now));
            }
            if (result.Kind is ScanKind.In or ScanKind.Out) Recorded?.Invoke(this, result);
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
    public bool Stop(int station, string barcode, StopReason reason, DateTimeOffset now)
    {
        var s = Stations.FirstOrDefault(x => x.Number == station);
        if (s?.Current?.Raw != barcode || s.Stop(reason, now) is not { } result) return false;
        if (result.Duration is { } d) History.Add(new WorkRecord(result.Station, result.Barcode, now - d, now));
        Recorded?.Invoke(this, result);
        return true;
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
            if (today.InProgress.TryGetValue(s.Number, out var p)) s.Restore(p.Barcode, p.Since, now);
            else s.Restore(null, default, now);
        }
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
