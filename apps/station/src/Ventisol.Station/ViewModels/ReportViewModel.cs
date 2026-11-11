using System.Windows;
using CommunityToolkit.Mvvm.ComponentModel;
using Ventisol.Station.Core;

namespace Ventisol.Station.ViewModels;

public sealed record OrderRow(string Order, string Elements, string Total, string Where, bool Active);

// Fill and Rest split the bar; GridLength so the view can lay it out without a converter.
public sealed record StationRow(string Name, string Done, string Average, string Utilization, GridLength Fill, GridLength Rest);

// The operators' view of the day: orders and stations, from the scans in OptiCloud (MainViewModel.History).
public sealed partial class ReportViewModel(MainViewModel main) : ObservableObject
{
    const int OrderRows = 8;

    [ObservableProperty] public partial IReadOnlyList<OrderRow> Orders { get; private set; } = [];
    [ObservableProperty] public partial IReadOnlyList<StationRow> Stations { get; private set; } = [];
    [ObservableProperty] public partial bool HasOrders { get; private set; }

    // A short line when the report may miss scans (OptiCloud not reached), else null.
    [ObservableProperty] public partial string? Note { get; set; }

    public void Refresh(DateTimeOffset now)
    {
        var states = main.Stations.Select(s => s.State).ToList();

        Orders = [.. DayReport.Orders(main.History, states, now).Take(OrderRows).Select(o => new OrderRow(
            o.Order.ToString(),
            o.Elements.ToString(),
            Format.Long(o.Total),
            DayReport.Where(o),
            o.ActiveAt.Count > 0))];
        HasOrders = Orders.Count > 0;

        Stations = [.. DayReport.Stations(main.History, states, now).Select(s => new StationRow(
            s.Station.Name,
            s.Done.ToString(),
            s.Average is { } a ? Format.Duration(a) : "-",
            $"{Math.Round(s.Utilization * 100)} %",
            new GridLength(s.Utilization, GridUnitType.Star),
            new GridLength(1 - s.Utilization, GridUnitType.Star)))];
    }
}
