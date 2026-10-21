using CommunityToolkit.Mvvm.ComponentModel;
using Ventisol.Station.Core;

namespace Ventisol.Station.ViewModels;

public enum WidgetKind { Clock, Kpi, RecentOrders }

public enum KpiMetric { Elements, AverageTime, StationsBusy, OrdersPacked }

// What a widget is, as saved with the layout.
public sealed record WidgetSpec(string Id, WidgetKind Kind, KpiMetric? Metric = null);

// A block that is not a station. Updated once a second from the same numbers as the report page.
public abstract class WidgetViewModel(WidgetSpec spec) : ObservableObject
{
    public WidgetSpec Spec => spec;
    public string Id => spec.Id;

    public abstract void Update(DateTimeOffset now, Kpis kpis, IReadOnlyList<OrderLine> orders);

    // The widgets one can add, in the order the picker lists them.
    public static IReadOnlyList<(string Label, WidgetKind Kind, KpiMetric? Metric, int Columns, int Rows)> Catalog { get; } =
    [
        ("Ur", WidgetKind.Clock, null, 3, 2),
        ("Seneste ordrer", WidgetKind.RecentOrders, null, 4, 4),
        ("Tal: elementer i dag", WidgetKind.Kpi, KpiMetric.Elements, 3, 2),
        ("Tal: gns. tid pr. station", WidgetKind.Kpi, KpiMetric.AverageTime, 3, 2),
        ("Tal: stationer i gang", WidgetKind.Kpi, KpiMetric.StationsBusy, 3, 2),
        ("Tal: ordrer pakket i dag", WidgetKind.Kpi, KpiMetric.OrdersPacked, 3, 2),
    ];

    public static WidgetViewModel Create(WidgetSpec spec) => spec.Kind switch
    {
        WidgetKind.Clock => new ClockWidget(spec),
        WidgetKind.RecentOrders => new RecentOrdersWidget(spec),
        _ => new KpiWidget(spec),
    };
}

// The clock face keeps its own time; there is nothing to feed it.
public sealed class ClockWidget(WidgetSpec spec) : WidgetViewModel(spec)
{
    public override void Update(DateTimeOffset now, Kpis kpis, IReadOnlyList<OrderLine> orders) { }
}

// One number, large, with what it is above it and how it is counted below.
public sealed partial class KpiWidget(WidgetSpec spec) : WidgetViewModel(spec)
{
    [ObservableProperty] public partial string Label { get; private set; } = "";
    [ObservableProperty] public partial string Value { get; private set; } = "";
    [ObservableProperty] public partial string Note { get; private set; } = "";

    public override void Update(DateTimeOffset now, Kpis k, IReadOnlyList<OrderLine> orders)
    {
        (Label, Value, Note) = Spec.Metric switch
        {
            KpiMetric.AverageTime => ("Gns. tid pr. station", k.AverageTime is { } a ? Format.Duration(a) : "-", "Fra scan ind til scan ud"),
            KpiMetric.StationsBusy => ("Stationer i gang", $"{k.StationsBusy}/{k.Stations}", "Lige nu"),
            KpiMetric.OrdersPacked => ("Ordrer pakket", k.OrdersPacked.ToString(), "I dag"),
            _ => ("Elementer", k.Elements.ToString(), "Scannet i dag"),
        };
    }
}

public sealed record RecentOrderRow(string Order, string Where, string Total, bool Active, bool Packed);

public sealed partial class RecentOrdersWidget(WidgetSpec spec) : WidgetViewModel(spec)
{
    const int Count = 10;

    [ObservableProperty] public partial IReadOnlyList<RecentOrderRow> Rows { get; private set; } = [];

    public override void Update(DateTimeOffset now, Kpis kpis, IReadOnlyList<OrderLine> orders)
    {
        var rows = orders.Take(Count).Select(o => new RecentOrderRow(
            o.Order.ToString(),
            o.Packed ? "Pakket" : o.ActiveAt.Count > 0 ? string.Join(", ", o.ActiveAt) : "Venter",
            Format.Long(o.Total),
            o.ActiveAt.Count > 0,
            o.Packed)).ToList();
        // Only swap the list when something changed, so the rows don't rebuild every second for nothing.
        if (!rows.SequenceEqual(Rows)) Rows = rows;
    }
}
