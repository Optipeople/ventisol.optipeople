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
    public void Another_element_while_busy_is_rejected_and_keeps_the_current_one()
    {
        var s = new StationState(StationConfig.Defaults[0]);
        s.Scan(Code("058556050103"), T0);

        var r = s.Scan(Code("058556050102"), T0.AddMinutes(1));

        Assert.Equal(ScanKind.Rejected, r.Kind);
        Assert.Equal("058556050103", s.Current?.Raw);
    }
}
