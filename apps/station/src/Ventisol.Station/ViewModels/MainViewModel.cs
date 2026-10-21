using System.Collections.ObjectModel;
using System.Reflection;
using CommunityToolkit.Mvvm.ComponentModel;
using Ventisol.Station.Core;

namespace Ventisol.Station.ViewModels;

public sealed partial class MainViewModel : ObservableObject
{
    DateTimeOffset _reportRefreshed, _widgetsRefreshed;

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

    // Raised for every scan that reaches a station, read or not.
    public event EventHandler? Scanned;

    // A scan from scanner n. The raw text is exactly what the scanner sent.
    public void Scan(int scannerNumber, string raw, DateTimeOffset now)
    {
        var station = Stations.FirstOrDefault(s => s.Number == scannerNumber);
        if (station is null) return;

        if (Barcode.TryParse(raw, out var barcode))
        {
            var result = station.Scan(barcode, now);
            if (result is { Kind: ScanKind.Out, Duration: { } d })
                History.Add(new WorkRecord(result.Station, barcode, now - d, now));
        }
        else
        {
            station.Unreadable(raw.Trim(), now);
        }
        Scanned?.Invoke(this, EventArgs.Empty);
    }

    public void Tick(DateTimeOffset now)
    {
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
