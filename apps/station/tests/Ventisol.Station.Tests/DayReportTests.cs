using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class DayReportTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 8, 0, 0, TimeSpan.FromHours(2));
    static readonly StationConfig S10 = StationConfig.Defaults[0], S20 = StationConfig.Defaults[1];
    static Barcode Code(string raw) => Barcode.TryParse(raw, out var b) ? b : throw new ArgumentException(raw);
    static WorkRecord Done(StationConfig s, string raw, int fromMin, int toMin) => new(s, Code(raw), T0.AddMinutes(fromMin), T0.AddMinutes(toMin));

    [Fact]
    public void Order_adds_up_time_across_stations_and_counts_each_element_once()
    {
        var done = new[] { Done(S10, "058556050103", 0, 10), Done(S20, "058556050103", 12, 20), Done(S10, "058556050102", 20, 25) };

        var line = Assert.Single(DayReport.Orders(done, [], T0.AddMinutes(30)));

        Assert.Equal(58556, line.Order);
        Assert.Equal(2, line.Elements);
        Assert.Equal(TimeSpan.FromMinutes(23), line.Total);
        Assert.Empty(line.ActiveAt);
    }

    [Fact]
    public void Work_in_progress_counts_up_to_now_and_shows_where_it_is()
    {
        var s20 = new StationState(S20);
        s20.Scan(Code("058557020102"), T0.AddMinutes(5));

        var line = Assert.Single(DayReport.Orders([], [s20], T0.AddMinutes(12)));

        Assert.Equal(TimeSpan.FromMinutes(7), line.Total);
        Assert.Equal(["Station 20"], line.ActiveAt);
    }

    [Fact]
    public void An_order_shows_where_it_is_worked_on_else_where_it_was_last_never_packed()
    {
        var pack = StationConfig.Defaults[6];
        var done = new[] { Done(S10, "058556050103", 0, 10), Done(pack, "058556050103", 12, 15) };

        // Through packing and nothing in progress: still only where it was last, not "Pakket".
        var line = Assert.Single(DayReport.Orders(done, [], T0.AddMinutes(20)));
        Assert.Equal(pack.Name, line.LastStation);
        Assert.Equal($"Sidst ved {pack.Name}", DayReport.Where(line));

        var s10 = new StationState(S10);
        s10.Scan(Code("058556050102"), T0.AddMinutes(16));
        Assert.Equal("Station 10", DayReport.Where(Assert.Single(DayReport.Orders(done, [s10], T0.AddMinutes(20)))));
    }

    [Fact]
    public void Totals_count_elements_once_and_average_per_station_visit()
    {
        var pack = StationConfig.Defaults[6];
        var done = new[] { Done(S10, "058556050103", 0, 10), Done(pack, "058556050103", 12, 16) };
        var s20 = new StationState(S20);
        s20.Scan(Code("058557020102"), T0.AddMinutes(18));

        var k = DayReport.Totals(done, [new StationState(S10), s20], T0.AddMinutes(20));

        Assert.Equal(2, k.Elements);
        Assert.Equal(TimeSpan.FromMinutes(7), k.AverageTime);
        Assert.Equal((1, 2), (k.StationsBusy, k.Stations));
        Assert.Equal(1, k.OrdersAtPacking);
    }

    [Fact]
    public void Station_utilization_is_busy_time_over_the_day_so_far()
    {
        var done = new[] { Done(S10, "058556050103", 0, 10), Done(S10, "058556050102", 20, 40) };

        var lines = DayReport.Stations(done, [new StationState(S10), new StationState(S20)], T0.AddMinutes(60));

        Assert.Equal(2, lines[0].Done);
        Assert.Equal(TimeSpan.FromMinutes(15), lines[0].Average);
        Assert.Equal(0.5, lines[0].Utilization, 3);
        Assert.Null(lines[1].Average);
        Assert.Equal(0, lines[1].Utilization);
    }
}
