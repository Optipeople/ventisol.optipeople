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

    // Event is a column, but an ordinary scan leaves it out (plan-scan-commands.md §6.1).
    [Fact]
    public void Values_have_exactly_the_columns_of_the_doc()
    {
        var e = Scan("058556050103", 7, ScanDirection.Out, T0, duration: 754) with { MachineId = Guid.NewGuid() };

        var v = e.ToValues();

        Assert.Equal(ScanEvent.Columns.Select(c => c.Name).Where(n => n != "Event").Order(), v.Keys.Order());
        Assert.Equal(ScanEvent.Columns.Select(c => c.Name).Order(), (e with { Event = ScanEventKind.Pause }).ToValues().Keys.Order());
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

    // Rows already in OptiCloud are read as they always were, whatever rule new scans must pass.
    [Theory]
    [InlineData("057999050103", 57999)]
    [InlineData("042117030201", 42117)]
    public void A_stored_row_for_an_older_order_is_still_read(string barcode, int order)
    {
        var e = Out(barcode, 3, T0);

        Assert.True(ScanEvent.TryFromValues(AsRead(e), out var back));
        Assert.Equal(e, back);
        Assert.Equal(order, back.Barcode.Order);
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

    // A switch is stored as an Out and an In by MainViewModel, so the Switched result itself is not.
    [Fact]
    public void From_a_station_result_switched_is_not_stored()
    {
        var s = new StationState(StationConfig.Defaults[0]);
        var start = ScanEvent.From(s.Scan(Code("058556050103"), T0), null, "PC1");
        var switched = ScanEvent.From(s.Scan(Code("058556050102"), T0.AddMinutes(1)), null, "PC1");
        var end = ScanEvent.From(s.Scan(Code("058556050102"), T0.AddMinutes(3)), null, "PC1");

        Assert.Equal(ScanDirection.In, start!.Direction);
        Assert.Null(switched);
        Assert.Equal(ScanDirection.Out, end!.Direction);
        Assert.Equal(120, end.DurationSec);
        Assert.Equal("Station 10", end.Station);
    }

    // Rows and events (plan-scan-commands.md §6, plan-shift-end.md, plan-packing-checklist.md).

    [Fact]
    public void The_event_column_is_a_string_named_haendelse_and_comes_last()
    {
        var c = ScanEvent.Columns[^1];

        Assert.Equal(("Event", "Hændelse", ColumnType.String, false, false), (c.Name, c.FriendlyName, c.Type, c.IsUnique, c.IsKey));
    }

    // An Enkel station writes exactly what it wrote before the column: these keys and values.
    [Fact]
    public void An_enkel_station_writes_the_rows_of_today()
    {
        var id = Guid.NewGuid();
        var s = new StationState(StationConfig.Defaults[0]);
        var @in = ScanEvent.From(s.Scan(Code("058556050103"), T0), id, "PC1")!;
        var @out = ScanEvent.From(s.Scan(Code("058556050103"), T0.AddMinutes(2)), id, "PC1")!;

        string[] keys = ["ScanId", "Barcode", "OrderNo", "Position", "SubPosition", "Piece", "Station", "StationNo", "StationKind", "MachineId", "Direction", "ScanTime", "Device"];
        Assert.Equal(ScanEventKind.Scan, @in.Event);
        Assert.Equal(ScanEventKind.Scan, @out.Event);
        Assert.Equal(keys.Order(), @in.ToValues().Keys.Order());
        Assert.Equal(keys.Append("DurationSec").Order(), @out.ToValues().Keys.Order());
        var v = @out.ToValues();
        Assert.Equal("Out", v["Direction"]);
        Assert.Equal(120, v["DurationSec"]);
        Assert.Equal(id.ToString(), v["MachineId"]);
        Assert.Equal("2026-10-21T06:02:00.0000000Z", v["ScanTime"]);
        Assert.Equal("In", @in.ToValues()["Direction"]);
    }

    public static TheoryData<ScanDirection, ScanEventKind> EveryRow => new()
    {
        { ScanDirection.In, ScanEventKind.Scan },
        { ScanDirection.Out, ScanEventKind.Scan },
        { ScanDirection.Out, ScanEventKind.Pause },
        { ScanDirection.In, ScanEventKind.Resume },
        { ScanDirection.Out, ScanEventKind.Hold },
        { ScanDirection.Mark, ScanEventKind.Hold },
        { ScanDirection.Out, ScanEventKind.CheckedOut },
        { ScanDirection.Mark, ScanEventKind.Undo },
        { ScanDirection.Out, ScanEventKind.ShiftEnd },
        { ScanDirection.Mark, ScanEventKind.ShiftEnd },
    };

    [Theory]
    [MemberData(nameof(EveryRow))]
    public void Every_row_of_the_plan_survives_a_round_trip_through_the_table(ScanDirection direction, ScanEventKind kind)
    {
        var e = Scan("058556050103", 7, direction, T0, duration: direction == ScanDirection.Out ? 754 : null) with { MachineId = Guid.NewGuid(), Event = kind };

        var v = AsRead(e);
        Assert.True(ScanEvent.TryFromValues(v, out var back));

        Assert.Equal(e, back);
        Assert.Equal(direction.ToString(), v["direction"]);
        Assert.Equal(kind == ScanEventKind.Scan ? null : kind.ToString(), v.GetValueOrDefault("event"));
    }

    [Fact]
    public void Every_event_value_is_in_the_rows_of_the_plan()
    {
        Assert.Equal(Enum.GetValues<ScanEventKind>().Order(), EveryRow.Select(r => (ScanEventKind)r[1]).Distinct().Order());
    }

    [Fact]
    public void A_row_without_an_event_reads_as_a_scan()
    {
        var v = AsRead(Out("058556050103", 1, T0));

        Assert.False(v.ContainsKey("event"));
        Assert.True(ScanEvent.TryFromValues(v, out var e));
        Assert.Equal(ScanEventKind.Scan, e.Event);
        Assert.Null(ScanEvent.UnknownEvent(v));
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData(null)]
    [InlineData("Scan")]
    public void An_empty_event_reads_as_a_scan(string? text)
    {
        var v = AsRead(Out("058556050103", 1, T0));
        v["event"] = text;

        Assert.True(ScanEvent.TryFromValues(v, out var e));
        Assert.Equal(ScanEventKind.Scan, e.Event);
        Assert.Null(ScanEvent.UnknownEvent(v));
    }

    // A newer app may add values; this one reads them as an ordinary scan and says so once (ScanTable).
    [Theory]
    [InlineData("Lunch")]
    [InlineData("3")]
    [InlineData("-1")]
    public void An_unknown_event_reads_as_a_scan(string text)
    {
        var v = AsRead(Out("058556050103", 1, T0));
        v["event"] = text;

        Assert.True(ScanEvent.TryFromValues(v, out var e));
        Assert.Equal(ScanEventKind.Scan, e.Event);
        Assert.Equal(ScanDirection.Out, e.Direction);
        Assert.Equal(text, ScanEvent.UnknownEvent(v));
    }

    [Theory]
    [InlineData("pause", ScanEventKind.Pause)]
    [InlineData(" SHIFTEND ", ScanEventKind.ShiftEnd)]
    [InlineData("checkedout", ScanEventKind.CheckedOut)]
    public void The_event_is_read_in_any_case(string text, ScanEventKind kind)
    {
        var v = AsRead(Out("058556050103", 1, T0));
        v["Event"] = text;

        Assert.True(ScanEvent.TryFromValues(v, out var e));
        Assert.Equal(kind, e.Event);
    }

    [Theory]
    [InlineData("mark")]
    [InlineData("MARK")]
    public void A_mark_row_is_read_in_any_case(string text)
    {
        var v = AsRead(Scan("058556050103", 1, ScanDirection.Mark, T0) with { Event = ScanEventKind.Hold });
        v["direction"] = text;

        Assert.True(ScanEvent.TryFromValues(v, out var e));
        Assert.Equal(ScanDirection.Mark, e.Direction);
        Assert.Equal(ScanEventKind.Hold, e.Event);
    }

    // A direction by number is not a name: "2" would otherwise read as Mark.
    [Theory]
    [InlineData("0")]
    [InlineData("2")]
    public void A_direction_by_number_is_refused(string text)
    {
        var v = AsRead(In("058556050103", 1, T0));
        v["direction"] = text;

        Assert.False(ScanEvent.TryFromValues(v, out _));
    }

    [Fact]
    public void From_a_mark_result_is_a_mark_row_with_no_time()
    {
        var r = new ScanResult(ScanKind.Mark, StationConfig.Defaults[0], Code("058556050103"), T0, TimeSpan.FromMinutes(5)) { Event = ScanEventKind.ShiftEnd };

        var e = ScanEvent.From(r, null, "PC1")!;
        var v = e.ToValues();

        Assert.Equal(ScanDirection.Mark, e.Direction);
        Assert.Equal(ScanEventKind.ShiftEnd, e.Event);
        Assert.Null(e.DurationSec);
        Assert.Equal("Mark", v["Direction"]);
        Assert.Equal("ShiftEnd", v["Event"]);
        Assert.False(v.ContainsKey("DurationSec"));
    }

    [Theory]
    [InlineData(ScanKind.In, ScanEventKind.Resume)]
    [InlineData(ScanKind.Out, ScanEventKind.Pause)]
    [InlineData(ScanKind.Out, ScanEventKind.CheckedOut)]
    [InlineData(ScanKind.Out, ScanEventKind.ShiftEnd)]
    public void From_a_result_copies_its_event(ScanKind kind, ScanEventKind @event)
    {
        var r = new ScanResult(kind, StationConfig.Defaults[0], Code("058556050103"), T0, kind == ScanKind.Out ? TimeSpan.FromSeconds(90) : null) { Event = @event };

        var e = ScanEvent.From(r, null, "PC1")!;

        Assert.Equal(kind == ScanKind.In ? ScanDirection.In : ScanDirection.Out, e.Direction);
        Assert.Equal(@event, e.Event);
        Assert.Equal(kind == ScanKind.Out ? 90 : null, e.DurationSec);
    }
}
