using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class StationStateTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 8, 0, 0, TimeSpan.FromHours(2));
    static Barcode Code(string raw) => Barcode.TryParse(raw, out var b) ? b : throw new ArgumentException(raw);

    [Fact]
    public void First_scan_starts_second_scan_ends_with_duration()
    {
        var s = new StationState(StationConfig.Defaults[0]);

        var start = s.Scan(Code("058556050103"), T0);
        Assert.Equal(ScanKind.In, start.Kind);
        Assert.True(s.IsBusy);

        var end = s.Scan(Code("058556050103"), T0.AddMinutes(12));
        Assert.Equal(ScanKind.Out, end.Kind);
        Assert.Equal(TimeSpan.FromMinutes(12), end.Duration);
        Assert.False(s.IsBusy);
    }

    [Fact]
    public void Another_element_while_busy_switches_to_new_and_reports_duration_of_old()
    {
        var s = new StationState(StationConfig.Defaults[0]);
        s.Scan(Code("058556050103"), T0);

        var r = s.Scan(Code("058556050102"), T0.AddMinutes(5));

        Assert.Equal(ScanKind.Switched, r.Kind);
        Assert.Equal("058556050102", s.Current?.Raw);
        Assert.Equal("058556050103", r.Previous?.Raw);
        Assert.Equal(TimeSpan.FromMinutes(5), r.Duration);
        Assert.True(s.IsBusy);
    }

    [Fact]
    public void Switch_then_scan_same_ends_new_order()
    {
        var s = new StationState(StationConfig.Defaults[0]);
        s.Scan(Code("058556050103"), T0);
        s.Scan(Code("058556050102"), T0.AddMinutes(5)); // switch

        var end = s.Scan(Code("058556050102"), T0.AddMinutes(8));

        Assert.Equal(ScanKind.Out, end.Kind);
        Assert.Equal(TimeSpan.FromMinutes(3), end.Duration);
        Assert.False(s.IsBusy);
    }

    // "Max i gang" above 1: several elements in progress at once, each ended by its own scan.
    static StationState Multi(int max) => new(StationConfig.Defaults[2] with { MaxActive = max });

    [Fact]
    public void At_a_station_with_several_a_new_element_starts_beside_the_others()
    {
        var s = Multi(4);
        Assert.Equal(ScanKind.In, s.Scan(Code("058556050101"), T0).Kind);

        var second = s.Scan(Code("058557010101"), T0.AddMinutes(5));

        Assert.Equal(ScanKind.In, second.Kind);
        Assert.Equal(2, second.ActiveCount);
        Assert.Equal(["058556050101", "058557010101"], s.Active.Select(a => a.Barcode.Raw));
        // The one scanned in last is Current, as at a station with 1.
        Assert.Equal("058557010101", s.Current?.Raw);
        Assert.Equal(T0.AddMinutes(5), s.StartedAt);
    }

    [Fact]
    public void At_a_station_with_several_a_scan_of_one_in_progress_stops_only_that_one()
    {
        var s = Multi(4);
        s.Scan(Code("058556050101"), T0);
        s.Scan(Code("058557010101"), T0.AddMinutes(5));
        s.Scan(Code("058558020101"), T0.AddMinutes(10));

        var end = s.Scan(Code("058557010101"), T0.AddMinutes(30));

        Assert.Equal(ScanKind.Out, end.Kind);
        Assert.Equal(TimeSpan.FromMinutes(25), end.Duration);
        Assert.Equal(["058556050101", "058558020101"], s.Active.Select(a => a.Barcode.Raw));
        Assert.True(s.IsBusy);
    }

    [Fact]
    public void One_beyond_the_max_is_rejected_and_nothing_changes()
    {
        var s = Multi(2);
        s.Scan(Code("058556050101"), T0);
        s.Scan(Code("058557010101"), T0.AddMinutes(1));
        Assert.True(s.IsFull);

        var r = s.Scan(Code("058558020101"), T0.AddMinutes(2));

        Assert.Equal(ScanKind.Rejected, r.Kind);
        Assert.Equal(StationState.FullReason, r.Reason);
        Assert.Null(r.Duration);
        Assert.Equal(["058556050101", "058557010101"], s.Active.Select(a => a.Barcode.Raw));

        // Scanning one out makes room again.
        s.Scan(Code("058556050101"), T0.AddMinutes(3));
        Assert.Equal(ScanKind.In, s.Scan(Code("058558020101"), T0.AddMinutes(4)).Kind);
    }

    [Fact]
    public void A_restore_keeps_the_latest_up_to_the_max_oldest_first()
    {
        var s = Multi(2);
        s.Restore([
            new ActiveElement(Code("058558020101"), T0.AddMinutes(10)),
            new ActiveElement(Code("058556050101"), T0),
            new ActiveElement(Code("058557010101"), T0.AddMinutes(5)),
        ]);

        Assert.Equal(["058557010101", "058558020101"], s.Active.Select(a => a.Barcode.Raw));
        Assert.Equal("058558020101", s.Current?.Raw);

        s.Reset();
        Assert.False(s.IsBusy);
        Assert.Empty(s.Active);
    }

    [Fact]
    public void A_station_with_one_still_switches_and_never_rejects()
    {
        var s = new StationState(StationConfig.Defaults[0]);
        Assert.Equal(1, s.MaxActive);
        s.Scan(Code("058556050103"), T0);

        Assert.Equal(ScanKind.Switched, s.Scan(Code("058556050102"), T0.AddMinutes(1)).Kind);
        Assert.Equal(ScanKind.Switched, s.Scan(Code("058556050101"), T0.AddMinutes(2)).Kind);
        Assert.Single(s.Active);
    }
}
