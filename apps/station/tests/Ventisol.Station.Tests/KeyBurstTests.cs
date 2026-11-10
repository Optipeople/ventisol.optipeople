using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class KeyBurstTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 23, 8, 0, 0, TimeSpan.FromHours(2));

    // Types text with the given gap between keys, then Enter after one more gap.
    static (string? Scan, string Released) Type(KeyBurst b, string text, int gapMs, out DateTimeOffset at)
    {
        at = T0;
        var released = "";
        foreach (var c in text)
        {
            released += b.Key(c, at, out _);
            at = at.AddMilliseconds(gapMs);
        }
        var scan = b.Enter(at, out var rest);
        return (scan, released + rest);
    }

    [Fact]
    public void A_fast_burst_ended_by_Enter_is_a_scan()
    {
        var b = new KeyBurst();
        var (scan, released) = Type(b, "058556050103", 8, out _);
        Assert.Equal("058556050103", scan);
        Assert.Equal("", released);
        Assert.False(b.IsCapturing);
    }

    [Fact]
    public void Slow_typing_is_released_as_keys()
    {
        var b = new KeyBurst();
        var (scan, released) = Type(b, "058556050103", 150, out _);
        Assert.Null(scan);
        Assert.Equal("058556050103", released);
    }

    [Fact]
    public void A_short_burst_is_no_scan()
    {
        var (scan, released) = Type(new KeyBurst(), "12345", 8, out _);
        Assert.Null(scan);
        Assert.Equal("12345", released);
    }

    [Fact]
    public void A_short_burst_with_no_Enter_is_released_by_the_timer()
    {
        var b = new KeyBurst();
        b.Key('0', T0, out _);
        b.Key('5', T0.AddMilliseconds(8), out _);
        Assert.Equal("", b.Expire(T0.AddMilliseconds(40), out var scan));
        Assert.Null(scan);
        Assert.True(b.IsCapturing);
        Assert.Equal("05", b.Expire(T0.AddMilliseconds(100), out scan));
        Assert.Null(scan);
        Assert.False(b.IsCapturing);
    }

    // A Zebra cradle in HID mode sent the barcode with no Enter after it.
    [Fact]
    public void A_long_burst_with_no_Enter_is_a_scan_once_the_keys_stop()
    {
        var b = new KeyBurst();
        var at = T0;
        foreach (var c in "058556050101") b.Key(c, at = at.AddMilliseconds(2), out _);
        Assert.Equal("", b.Expire(at.AddMilliseconds(30), out var scan));
        Assert.Null(scan);
        Assert.Equal("", b.Expire(at.AddMilliseconds(70), out scan));
        Assert.Equal("058556050101", scan);
        Assert.False(b.IsCapturing);
    }

    [Fact]
    public void A_key_after_a_burst_with_no_Enter_gives_the_scan_and_starts_over()
    {
        var b = new KeyBurst();
        var at = T0;
        foreach (var c in "058556050101") b.Key(c, at = at.AddMilliseconds(2), out _);
        Assert.Equal("", b.Key('7', at.AddMilliseconds(500), out var scan));
        Assert.Equal("058556050101", scan);
        Assert.True(b.IsCapturing);
    }

    [Fact]
    public void A_lone_key_is_held_and_then_released()
    {
        var b = new KeyBurst();
        Assert.Equal("", b.Key('3', T0, out _));
        Assert.True(b.IsCapturing);
        Assert.Equal("3", b.Expire(T0.AddMilliseconds(60), out _));
    }

    [Fact]
    public void A_key_after_a_pause_releases_the_ones_before_and_starts_over()
    {
        var b = new KeyBurst();
        b.Key('3', T0, out _);
        Assert.Equal("3", b.Key('0', T0.AddMilliseconds(500), out _));
        var at = T0.AddMilliseconds(500);
        foreach (var c in "58556050103") b.Key(c, at = at.AddMilliseconds(5), out _);
        Assert.Equal("058556050103", b.Enter(at.AddMilliseconds(5), out var released));
        Assert.Equal("", released);
    }

    [Fact]
    public void A_late_Enter_still_ends_the_scan()
    {
        var b = new KeyBurst();
        var at = T0;
        foreach (var c in "058556050103") b.Key(c, at = at.AddMilliseconds(5), out _);
        Assert.Equal("058556050103", b.Enter(at.AddMilliseconds(300), out var released));
        Assert.Equal("", released);
    }

    [Fact]
    public void Keeps_a_prefix_as_it_was_sent()
    {
        var (scan, _) = Type(new KeyBurst(), "S3058556050103", 5, out _);
        Assert.Equal("S3058556050103", scan);
    }
}
