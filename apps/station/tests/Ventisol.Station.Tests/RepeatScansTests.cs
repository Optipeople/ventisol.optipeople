using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class RepeatScansTests
{
    static readonly DateTimeOffset T0 = new(2026, 11, 11, 12, 3, 54, TimeSpan.FromHours(1));
    static Barcode Code(string raw) => Barcode.TryParse(raw, out var b) ? b : throw new ArgumentException(raw);

    [Fact]
    public void The_same_label_read_twice_in_a_moment_is_one_scan()
    {
        var r = new RepeatScans();
        Assert.False(r.IsRepeat(1, Code("01058842010112"), T0));
        Assert.True(r.IsRepeat(1, Code("01058842010112"), T0.AddMilliseconds(340)));
    }

    [Fact]
    public void Another_profile_of_the_same_element_is_a_repeat_too()
    {
        var r = new RepeatScans();
        Assert.False(r.IsRepeat(1, Code("05883003010114"), T0));
        Assert.True(r.IsRepeat(1, Code("03058830010105"), T0.AddSeconds(1)));
    }

    [Fact]
    public void A_scan_after_the_window_counts()
    {
        var r = new RepeatScans();
        r.IsRepeat(1, Code("058556050103"), T0);
        Assert.False(r.IsRepeat(1, Code("058556050103"), T0.AddSeconds(3)));
    }

    [Fact]
    public void Other_stations_and_other_elements_are_not_repeats()
    {
        var r = new RepeatScans();
        r.IsRepeat(1, Code("058556050103"), T0);
        Assert.False(r.IsRepeat(2, Code("058556050103"), T0.AddMilliseconds(100)));
        Assert.False(r.IsRepeat(1, Code("058556050102"), T0.AddMilliseconds(200)));
    }
}
