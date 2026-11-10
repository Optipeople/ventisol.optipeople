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

    // Everything done on this screen since it started. Moves to OptiCloud with the API.
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

    // When the last scan came in anywhere, so updates wait for a quiet moment.
    public DateTimeOffset LastScanAt { get; private set; } = DateTimeOffset.MinValue;

    // Raised for each scan in and scan out a station accepted: what goes to OptiCloud.
    public event EventHandler<ScanResult>? Recorded;

    // Raised for every scan that reaches a station, read or not.
    public event EventHandler? Scanned;

    // A scan from scanner n. The raw text is exactly what the scanner sent.
    public void Scan(int scannerNumber, string raw, DateTimeOffset now)
    {
        var station = Stations.FirstOrDefault(s => s.Number == scannerNumber);
        if (station is null) return;
        LastScanAt = now;

        if (Barcode.TryParse(raw, out var barcode))
        {
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

    public WidgetViewModel AddWidget(WidgetSpec spec)
    {
        var w = WidgetViewModel.Create(spec);
        Widgets.Add(w);
        RefreshWidgets(DateTimeOffset.Now);
        return w;
    }

    public void RemoveWidget(string id)
    {
        if (Widgets.FirstOrDefault(w => w.Id == id) is { } w) Widgets.Remove(w);
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
