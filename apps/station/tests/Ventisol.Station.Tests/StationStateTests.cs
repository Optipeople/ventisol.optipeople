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
}
