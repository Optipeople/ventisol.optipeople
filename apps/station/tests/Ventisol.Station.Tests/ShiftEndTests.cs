using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

// docs/plan-shift-end.md §4 and §6.2: the schedule, the rule, the derived id and the local activity.
public class ShiftEndTests
{
    static readonly TimeZoneInfo Dk = Zone();

    static TimeZoneInfo Zone()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Europe/Copenhagen"); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.FindSystemTimeZoneById("Romance Standard Time"); }
    }

    // Danish wall clock to an instant; November is +1.
    static DateTimeOffset Local(int month, int day, int hour, int minute = 0) =>
        ShiftSchedule.Instant(new DateOnly(2026, month, day), new TimeOnly(hour, minute), Dk);

    static DateTimeOffset Utc(int month, int day, int hour, int minute = 0) => new(2026, month, day, hour, minute, 0, TimeSpan.Zero);

    static readonly ShiftSchedule Day = ShiftSchedule.Standard(new(6, 0), new(14, 0));
    static readonly TimeSpan Hour = TimeSpan.FromHours(1);

    // Monday 23 November 2026, shift 06:00 to 14:00: E is 14:00 local, 13:00 UTC.
    static readonly DateTimeOffset E = Local(11, 23, 14);

    // --- Spans

    [Fact]
    public void The_standard_shift_is_monday_to_friday_on_the_wall_clock()
    {
        var spans = Day.Spans(Local(11, 23, 0), Local(11, 30, 0), Dk);

        Assert.Equal(5, spans.Count);
        Assert.Equal((Utc(11, 23, 5), Utc(11, 23, 13)), spans[0]);
        Assert.Equal((Utc(11, 27, 5), Utc(11, 27, 13)), spans[4]);
        Assert.Empty(Day.Spans(Local(11, 28, 0), Local(11, 30, 0), Dk));
    }

    [Fact]
    public void A_night_shift_over_midnight_is_one_span()
    {
        var night = ShiftSchedule.Standard(new(22, 0), new(6, 0));

        var spans = night.Spans(Local(11, 23, 12), Local(11, 24, 12), Dk);

        Assert.Equal((Utc(11, 23, 21), Utc(11, 24, 5)), Assert.Single(spans));
    }

    [Fact]
    public void Shifts_less_than_two_hours_apart_join_into_one_span()
    {
        ShiftSchedule Of(params (int H1, int M1, int H2, int M2)[] blocks) =>
            new([.. blocks.Select(b => new ShiftBlock(DayOfWeek.Monday, new(b.H1, b.M1), new(b.H2, b.M2)))], []);
        var from = Local(11, 23, 0);
        var to = Local(11, 24, 0);

        // A lunch break as two shifts.
        Assert.Equal((Utc(11, 23, 5), Utc(11, 23, 13)), Assert.Single(Of((6, 0, 10, 0), (10, 30, 14, 0)).Spans(from, to, Dk)));
        // Back to back.
        Assert.Equal((Utc(11, 23, 5), Utc(11, 23, 21)), Assert.Single(Of((6, 0, 14, 0), (14, 0, 22, 0)).Spans(from, to, Dk)));
        // Exactly two hours apart: two spans.
        Assert.Equal(2, Of((6, 0, 10, 0), (12, 0, 14, 0)).Spans(from, to, Dk).Count);
    }

    [Fact]
    public void A_night_over_the_spring_clock_change_is_wall_clock_and_a_missing_end_is_the_next_real_instant()
    {
        // Sunday 29 March 2026: 02:00 becomes 03:00.
        var night = new ShiftSchedule([new ShiftBlock(DayOfWeek.Saturday, new(22, 0), new(6, 0))], []);
        Assert.Equal((Utc(3, 28, 21), Utc(3, 29, 4)), Assert.Single(night.Spans(Utc(3, 28, 12), Utc(3, 29, 12), Dk)));

        var gap = new ShiftSchedule([new ShiftBlock(DayOfWeek.Saturday, new(22, 0), new(2, 30))], []);
        Assert.Equal(Utc(3, 29, 1), Assert.Single(gap.Spans(Utc(3, 28, 12), Utc(3, 29, 12), Dk)).End);
    }

    [Fact]
    public void A_night_over_the_autumn_clock_change_is_wall_clock_and_a_doubled_end_is_the_later_instant()
    {
        // Sunday 25 October 2026: 03:00 becomes 02:00.
        var night = new ShiftSchedule([new ShiftBlock(DayOfWeek.Saturday, new(22, 0), new(6, 0))], []);
        Assert.Equal((Utc(10, 24, 20), Utc(10, 25, 5)), Assert.Single(night.Spans(Utc(10, 24, 12), Utc(10, 25, 12), Dk)));

        var twice = new ShiftSchedule([new ShiftBlock(DayOfWeek.Saturday, new(22, 0), new(2, 30))], []);
        Assert.Equal(Utc(10, 25, 1, 30), Assert.Single(twice.Spans(Utc(10, 24, 12), Utc(10, 25, 12), Dk)).End);
    }

    [Fact]
    public void A_skipped_date_has_no_shift()
    {
        var skipped = Day with { SkipDates = [new DateOnly(2026, 11, 24)] };

        var spans = skipped.Spans(Local(11, 23, 0), Local(11, 26, 0), Dk);

        Assert.Equal([Utc(11, 23, 5), Utc(11, 25, 5)], spans.Select(s => s.Start));
    }

    [Fact]
    public void No_blocks_no_spans()
    {
        Assert.Empty(new ShiftSchedule([], []).Spans(Local(11, 23, 0), Local(11, 30, 0), Dk));
    }

    // --- The rule

    static ShiftEndDue? Evaluate(ShiftSchedule schedule, DateTimeOffset since, DateTimeOffset now, params DateTimeOffset[] activity) =>
        ShiftEndRule.Evaluate(1, schedule, [since, .. activity], since, Hour, now, Dk);

    [Fact]
    public void Nothing_after_the_shift_end_stops_at_the_end_due_after_the_grace()
    {
        var since = Local(11, 23, 13, 20);

        var grace = Evaluate(Day, since, E.AddMinutes(30));
        Assert.Equal(new ShiftEndDue(1, E, E + Hour, E), grace);
        Assert.True(grace!.DueAt > E.AddMinutes(30));

        var due = Evaluate(Day, since, E.AddMinutes(61));
        Assert.Equal(new ShiftEndDue(1, E, E + Hour, E), due);
        Assert.True(due!.DueAt <= E.AddMinutes(61));
    }

    [Fact]
    public void A_scan_in_overtime_moves_the_stop_to_it()
    {
        var since = Local(11, 23, 13, 20);

        var r = Evaluate(Day, since, E.AddMinutes(90), E.AddMinutes(25));

        Assert.Equal(new ShiftEndDue(1, E.AddMinutes(25), E.AddMinutes(85), E), r);
    }

    [Fact]
    public void Activity_keeps_rolling_the_stop_on_until_the_station_is_quiet()
    {
        var since = Local(11, 23, 13, 20);

        var r = Evaluate(Day, since, E.AddHours(5), E.AddMinutes(50), E.AddMinutes(100), E.AddMinutes(150));

        Assert.Equal(E.AddMinutes(150), r!.StopAt);
        // Activity not seen yet (after now) is not used.
        Assert.Equal(E.AddMinutes(50), Evaluate(Day, since, E.AddMinutes(60), E.AddMinutes(50), E.AddMinutes(100))!.StopAt);
    }

    [Fact]
    public void Inside_a_span_nothing_stops()
    {
        Assert.Null(Evaluate(Day, Local(11, 23, 8), Local(11, 23, 10)));
        Assert.Null(Evaluate(Day, Local(11, 23, 8), E.AddTicks(-1)));
    }

    [Fact]
    public void The_next_span_starting_before_the_stop_is_due_stops_nothing_and_its_end_is_judged_the_same_way()
    {
        // 06:00 to 14:00 and 16:00 to 20:00: two spans, two hours apart.
        var split = new ShiftSchedule([new ShiftBlock(DayOfWeek.Monday, new(6, 0), new(14, 0)), new ShiftBlock(DayOfWeek.Monday, new(16, 0), new(20, 0))], []);
        var since = Local(11, 23, 13, 20);

        // Activity at 14:40 and 15:30: due 16:30, after the next start at 16:00.
        Assert.Null(Evaluate(split, since, Local(11, 23, 17), Local(11, 23, 14, 40), Local(11, 23, 15, 30)));

        // At the next end, 20:00, it is judged again.
        var end = Local(11, 23, 20);
        Assert.Equal(new ShiftEndDue(1, end, end + Hour, end), Evaluate(split, since, Local(11, 23, 21, 30), Local(11, 23, 14, 40), Local(11, 23, 15, 30)));
    }

    [Fact]
    public void Weekend_work_with_no_shift_stops_at_the_last_activity_when_quiet()
    {
        var since = Local(11, 28, 9);

        var r = Evaluate(Day, since, Local(11, 28, 11), Local(11, 28, 9, 40), Local(11, 28, 10, 30));

        // Off shift since Friday's end.
        Assert.Equal(new ShiftEndDue(1, Local(11, 28, 10, 30), Local(11, 28, 11, 30), Local(11, 27, 14)), r);
    }

    [Fact]
    public void A_catch_up_after_the_pc_was_off_finds_the_first_shift_end_that_stops_it()
    {
        var since = Local(11, 23, 13, 20);

        // Next morning, nothing seen after the In: stopped at Monday's end, due long ago.
        Assert.Equal(new ShiftEndDue(1, E, E + Hour, E), Evaluate(Day, since, Local(11, 24, 8)));
        // Overtime until 15:40 in the rows.
        Assert.Equal(Local(11, 23, 15, 40), Evaluate(Day, since, Local(11, 24, 8), Local(11, 23, 14, 50), Local(11, 23, 15, 40))!.StopAt);
    }

    [Fact]
    public void Grace_zero_stops_nothing()
    {
        Assert.Null(ShiftEndRule.Evaluate(1, Day, [], Local(11, 23, 13), TimeSpan.Zero, Local(11, 24, 8), Dk));
    }

    [Fact]
    public void A_night_shift_ends_in_the_morning()
    {
        var night = ShiftSchedule.Standard(new(22, 0), new(6, 0));
        var end = Local(11, 24, 6);

        Assert.Null(Evaluate(night, Local(11, 24, 1), Local(11, 24, 5)));
        Assert.Equal(new ShiftEndDue(1, end, end + Hour, end), Evaluate(night, Local(11, 24, 1), Local(11, 24, 7, 30)));
    }

    [Fact]
    public void Max_i_gang_3_stops_every_element_at_one_x()
    {
        var s = new StationState(StationConfig.Defaults[2] with { MaxActive = 3 });
        s.Scan(Code("058556050101"), Local(11, 23, 10));
        s.Scan(Code("058556050102"), Local(11, 23, 12));
        s.Scan(Code("058556050103"), Local(11, 23, 13));
        var due = ShiftEndRule.Evaluate(3, Day, [.. s.Active.Select(a => a.Since)], s.Active.Min(a => a.Since), Hour, Local(11, 23, 15, 5), Dk)!;

        var outs = s.StopAll(due.StopAt, ScanEventKind.ShiftEnd);

        Assert.False(s.IsBusy);
        Assert.Equal(3, outs.Count);
        Assert.All(outs, o => Assert.Equal((ScanKind.Out, E, ScanEventKind.ShiftEnd), (o.Kind, o.At, o.Event)));
        Assert.Equal([TimeSpan.FromHours(4), TimeSpan.FromHours(2), TimeSpan.FromHours(1)], outs.Select(o => o.Duration!.Value));
    }

    // --- The derived id

    [Fact]
    public void The_stop_id_is_stable_a_version_5_uuid_and_differs_per_in()
    {
        var a = Guid.Parse("0b1f6c1e-3a52-4d0e-9a51-2b7c4e9f8a10");
        var b = Guid.Parse("0b1f6c1e-3a52-4d0e-9a51-2b7c4e9f8a11");

        Assert.Equal(ShiftEndRule.StopId(a), ShiftEndRule.StopId(a));
        Assert.NotEqual(ShiftEndRule.StopId(a), ShiftEndRule.StopId(b));
        Assert.NotEqual(a, ShiftEndRule.StopId(a));
        var text = ShiftEndRule.StopId(a).ToString("D");
        Assert.Equal('5', text[14]);
        Assert.Contains(text[19], "89ab");
        // Fixed for good: a stop written by an older build of this app has the same id.
        Assert.Equal(ShiftEndRule.StopId(a), Guid.Parse(text));
    }

    [Fact]
    public void An_element_without_its_in_id_gets_one_from_barcode_station_and_in_time()
    {
        var element = new ActiveElement(Code("058556050103"), Local(11, 23, 13, 20));

        Assert.Equal(ShiftEndRule.StopId(element, 1), ShiftEndRule.StopId(element.Barcode, 1, element.Since.ToOffset(TimeSpan.Zero)));
        Assert.NotEqual(ShiftEndRule.StopId(element, 1), ShiftEndRule.StopId(element, 2));
        var id = Guid.NewGuid();
        Assert.Equal(ShiftEndRule.StopId(id), ShiftEndRule.StopId(element with { InScanId = id }, 1));
    }

    [Fact]
    public void A_stop_rebuilt_after_a_restart_gets_the_same_row_id()
    {
        var @in = In("058556050103", 1, Local(11, 23, 13, 20));

        // Before: noted when the In was recorded. After a restart: from the replay of the rows.
        var before = new StationState(StationConfig.Defaults[0]);
        before.Scan(@in.Barcode, @in.At);
        Assert.True(before.NoteInScanId(@in.Barcode.Raw, @in.ScanId));
        var after = new StationState(StationConfig.Defaults[0]);
        after.Restore(ScanReplay.Replay([@in], StationConfig.Defaults).InProgress[1]);

        var first = ScanEvent.From(Assert.Single(before.StopAll(E, ScanEventKind.ShiftEnd)), null, "PC1")!;
        var second = ScanEvent.From(Assert.Single(after.StopAll(E, ScanEventKind.ShiftEnd)), null, "PC2")!;

        Assert.Equal(ShiftEndRule.StopId(@in.ScanId), first.ScanId);
        Assert.Equal(first.ScanId, second.ScanId);
        Assert.Equal((ScanDirection.Out, E, 40 * 60, ScanEventKind.ShiftEnd), (first.Direction, first.At, first.DurationSec, first.Event));
    }

    // --- Local activity

    [Fact]
    public void Local_activity_is_kept_per_station_for_the_window_and_round_trips()
    {
        var a = new ShiftEndActivity();
        a.Note(1, E.AddMinutes(20));
        a.Note(1, E.AddMinutes(5));
        a.Note(3, E.AddHours(-40));

        var back = ShiftEndActivity.FromJson(a.ToJson());
        Assert.Equal([E.AddMinutes(5), E.AddMinutes(20)], back.For(1));
        Assert.Single(back.For(3));
        Assert.Empty(back.For(2));

        Assert.True(back.Prune(E));
        Assert.Empty(back.For(3));
        Assert.False(back.Prune(E));
        Assert.Equal(2, back.For(1).Count);
    }

    [Fact]
    public void A_local_activity_file_that_cannot_be_read_is_empty()
    {
        Assert.Empty(ShiftEndActivity.FromJson("not json").For(1));
        Assert.Empty(ShiftEndActivity.FromJson(null).For(1));
        Assert.Empty(ShiftEndActivity.FromJson("").For(1));
    }
}
