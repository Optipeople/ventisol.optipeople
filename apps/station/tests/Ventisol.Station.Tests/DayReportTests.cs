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

    [Fact]
    public void The_day_starts_at_the_first_scan_today_not_at_midnight_and_not_yesterday()
    {
        var midnight = new DateTimeOffset(2026, 10, 21, 0, 0, 0, TimeSpan.FromHours(2));
        // In progress since 22:00 yesterday at Station 10; Station 20 ended one at 01:00 that began at 23:00.
        var s10 = new StationState(S10);
        s10.Restore(Code("058556050103"), midnight.AddHours(-2));
        var done = new[] { new WorkRecord(S20, Code("058556050102"), midnight.AddHours(-1), midnight.AddHours(1)) };

        var lines = DayReport.Stations(done, [s10, new StationState(S20)], midnight.AddHours(4), midnight);

        // The first scan today is Station 20's scan out at 01:00, so the day so far is 3 hours.
        // Station 10 worked all of them.
        Assert.Equal(1, lines[0].Utilization, 3);
        // Station 20's hour after midnight lies before that first scan; its average is still the
        // element's whole two hours.
        Assert.Equal(0, lines[1].Utilization, 3);
        Assert.Equal(TimeSpan.FromHours(2), lines[1].Average);
    }

    [Fact]
    public void One_element_left_in_over_night_does_not_thin_out_the_other_stations()
    {
        var midnight = new DateTimeOffset(2026, 10, 21, 0, 0, 0, TimeSpan.FromHours(2));
        var done = new[]
        {
            // In at 15:00 yesterday, out at 07:10 today.
            new WorkRecord(S10, Code("058556050103"), midnight.AddHours(-9), midnight.AddHours(7).AddMinutes(10)),
            // Station 20 worked 07:00 to 14:00.
            new WorkRecord(S20, Code("058556050102"), midnight.AddHours(7), midnight.AddHours(14)),
        };

        var lines = DayReport.Stations(done, [new StationState(S10), new StationState(S20)], midnight.AddHours(15), midnight);

        // The day so far is 07:00 to 15:00: 7 of 8 hours, not 7 of 15.
        Assert.Equal(7.0 / 8, lines[1].Utilization, 3);
        // The night is not Station 10's work: 10 minutes of the 8 hours.
        Assert.Equal(10.0 / 480, lines[0].Utilization, 3);
        Assert.Equal(TimeSpan.FromHours(16).Add(TimeSpan.FromMinutes(10)), lines[0].Average);
    }

    [Fact]
    public void An_element_in_progress_since_yesterday_and_nothing_else_today_gives_no_day_yet()
    {
        var midnight = new DateTimeOffset(2026, 10, 21, 0, 0, 0, TimeSpan.FromHours(2));
        var s10 = new StationState(S10);
        s10.Restore(Code("058556050103"), midnight.AddHours(-2));

        var lines = DayReport.Stations([], [s10, new StationState(S20)], midnight.AddHours(4), midnight);

        Assert.All(lines, l => Assert.Equal(0, l.Utilization));
    }

    [Fact]
    public void Without_today_given_the_day_is_the_local_day_of_now()
    {
        var now = new DateTimeOffset(DateTime.Today.AddHours(4));
        var midnight = Ventisol.Station.Core.Cloud.CloudSync.Midnight(now);
        // One over midnight, out at 01:00, and one from 02:00 to 03:00.
        var done = new[]
        {
            new WorkRecord(S10, Code("058556050103"), midnight.AddHours(-2), midnight.AddHours(1)),
            new WorkRecord(S10, Code("058556050102"), midnight.AddHours(2), midnight.AddHours(3)),
        };

        var lines = DayReport.Stations(done, [new StationState(S10)], now);

        // The day so far is 01:00 to 04:00, with one hour worked in it. Had today been taken for
        // another day, both elements would count whole.
        Assert.Equal(1.0 / 3, lines[0].Utilization, 3);
    }
}
