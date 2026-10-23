using System.Globalization;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public class ScanEventTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 8, 0, 0, TimeSpan.FromHours(2));

    // As the server hands values back: text, keys camelCased.
    static Dictionary<string, string?> AsRead(ScanEvent e) =>
        e.ToValues().ToDictionary(p => char.ToLowerInvariant(p.Key[0]) + p.Key[1..], p => Convert.ToString(p.Value, CultureInfo.InvariantCulture));

    [Fact]
    public void Values_have_exactly_the_columns_of_the_doc()
    {
        var e = Scan("058556050103", 7, ScanDirection.Out, T0, duration: 754) with { MachineId = Guid.NewGuid() };

        var v = e.ToValues();

        Assert.Equal(ScanEvent.Columns.Select(c => c.Name).Order(), v.Keys.Order());
        Assert.Equal("058556050103", v["Barcode"]);
        Assert.Equal(58556, v["OrderNo"]);
        Assert.Equal(5, v["Position"]);
        Assert.Equal(1, v["SubPosition"]);
        Assert.Equal(3, v["Piece"]);
        Assert.Equal("Pakning", v["Station"]);
        Assert.Equal("Packing", v["StationKind"]);
        Assert.Equal("Out", v["Direction"]);
        Assert.Equal("2026-10-21T06:00:00.0000000Z", v["ScanTime"]);
        Assert.Equal(754, v["DurationSec"]);
    }

    [Fact]
    public void An_in_has_no_duration_and_an_empty_machine()
    {
        var v = In("058556050103", 1, T0).ToValues();

        Assert.False(v.ContainsKey("DurationSec"));
        Assert.Equal("", v["MachineId"]);
    }

    [Fact]
    public void Survives_a_round_trip_through_the_table()
    {
        var e = Scan("058556050103", 7, ScanDirection.Out, T0, duration: 754) with { MachineId = Guid.NewGuid() };

        Assert.True(ScanEvent.TryFromValues(AsRead(e), out var back));
        Assert.Equal(e, back);
    }

    [Theory]
    [InlineData("2026-10-21T08:00:00+02:00")]
    [InlineData("2026-10-21T06:00:00Z")]
    [InlineData("2026-10-21T06:00:00")]
    [InlineData("2026-10-21T06:00:00.000")]
    public void Scan_time_takes_offsets_and_reads_none_as_utc(string text)
    {
        var v = AsRead(In("058556050103", 1, T0));
        v["scanTime"] = text;

        Assert.True(ScanEvent.TryFromValues(v, out var e));
        Assert.Equal(T0, e.At);
        Assert.Equal(TimeSpan.Zero, e.At.Offset);
    }

    [Theory]
    [InlineData("scanId", "")]
    [InlineData("barcode", "12345")]
    [InlineData("direction", "Sideways")]
    [InlineData("scanTime", "i går")]
    [InlineData("stationNo", null)]
    public void A_row_that_is_not_a_scan_is_refused(string key, string? value)
    {
        var v = AsRead(In("058556050103", 1, T0));
        v[key] = value;

        Assert.False(ScanEvent.TryFromValues(v, out _));
    }

    [Fact]
    public void From_a_station_result_rejected_is_not_stored()
    {
        var s = new StationState(StationConfig.Defaults[0]);
        var start = ScanEvent.From(s.Scan(Code("058556050103"), T0), null, "PC1");
        var rejected = ScanEvent.From(s.Scan(Code("058556050102"), T0.AddMinutes(1)), null, "PC1");
        var end = ScanEvent.From(s.Scan(Code("058556050103"), T0.AddMinutes(2)), null, "PC1");

        Assert.Equal(ScanDirection.In, start!.Direction);
        Assert.Null(rejected);
        Assert.Equal(ScanDirection.Out, end!.Direction);
        Assert.Equal(120, end.DurationSec);
        Assert.Equal("Station 10", end.Station);
    }
}
