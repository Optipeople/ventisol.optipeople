using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public class ScanReplayTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 6, 0, 0, TimeSpan.Zero);
    const string A = "058556050103", B = "058556050102", C = "058556050101";

    static ReplayResult Replay(params ScanEvent[] events) => ScanReplay.Replay(events, StationConfig.Defaults);

    [Fact]
    public void An_in_without_an_out_is_in_progress_since_the_in()
    {
        var r = Replay(In(A, 1, T0));

        Assert.Equal(new ActiveElement(Code(A), T0), Assert.Single(r.InProgress[1]));
        Assert.Empty(r.Done);
    }

    [Fact]
    public void An_in_and_its_out_make_one_record_in_any_order()
    {
        var r = Replay(Out(A, 1, T0.AddMinutes(12)), In(B, 2, T0.AddMinutes(1)), In(A, 1, T0), Out(B, 2, T0.AddMinutes(3)));

        Assert.Empty(r.InProgress);
        Assert.Equal(2, r.Done.Count);
        Assert.Equal(new WorkRecord(StationConfig.Defaults[1], Code(B), T0.AddMinutes(1), T0.AddMinutes(3)), r.Done[0]);
        Assert.Equal(new WorkRecord(StationConfig.Defaults[0], Code(A), T0, T0.AddMinutes(12)), r.Done[1]);
    }

    [Fact]
    public void A_rework_scan_adds_a_second_record()
    {
        var r = Replay(In(A, 1, T0), Out(A, 1, T0.AddMinutes(10)), In(A, 1, T0.AddMinutes(30)), Out(A, 1, T0.AddMinutes(35)));

        Assert.Equal([TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(5)], r.Done.Select(d => d.Duration));
    }

    [Fact]
    public void A_rework_scan_in_again_is_in_progress()
    {
        var r = Replay(In(A, 1, T0), Out(A, 1, T0.AddMinutes(10)), In(A, 1, T0.AddMinutes(30)));

        Assert.Single(r.Done);
        Assert.Equal(T0.AddMinutes(30), Assert.Single(r.InProgress[1]).Since);
    }

    [Fact]
    public void An_out_without_an_in_is_skipped()
    {
        var r = Replay(Out(A, 1, T0), In(B, 1, T0.AddMinutes(1)));

        Assert.Empty(r.Done);
        Assert.Equal(Code(B), Assert.Single(r.InProgress[1]).Barcode);
    }

    [Fact]
    public void An_out_without_an_in_gets_its_start_back_from_its_duration()
    {
        var r = Replay(Scan(A, 1, ScanDirection.Out, T0.AddMinutes(10), duration: 600));

        Assert.Equal(new WorkRecord(StationConfig.Defaults[0], Code(A), T0, T0.AddMinutes(10)), Assert.Single(r.Done));
    }

    [Fact]
    public void A_second_in_while_one_is_open_wins()
    {
        var r = Replay(In(A, 1, T0), In(A, 1, T0.AddMinutes(30)), Out(A, 1, T0.AddMinutes(40)));

        Assert.Equal(T0.AddMinutes(30), Assert.Single(r.Done).Start);
        Assert.Empty(r.InProgress);
    }

    [Fact]
    public void Pairs_by_station_number_not_by_name()
    {
        var renamed = Out(A, 1, T0.AddMinutes(5)) with { Station = "Station 11" };

        var r = Replay(In(A, 1, T0), renamed);

        Assert.Equal(TimeSpan.FromMinutes(5), Assert.Single(r.Done).Duration);
    }

    [Fact]
    public void With_today_done_is_what_ends_today_and_in_progress_spans_midnight()
    {
        var midnight = T0.AddHours(-6);
        var r = ScanReplay.Replay(
        [
            In(A, 1, midnight.AddHours(-2)),
            In(B, 2, midnight.AddHours(-3)), Out(B, 2, T0),
            In(C, 3, midnight.AddHours(-5)), Out(C, 3, midnight.AddHours(-4)),
        ], StationConfig.Defaults, midnight);

        Assert.Equal(midnight.AddHours(-2), Assert.Single(r.InProgress[1]).Since);
        var done = Assert.Single(r.Done);
        Assert.Equal((Code(B), midnight.AddHours(-3), T0), (done.Barcode, done.Start, done.End));
    }

    [Fact]
    public void The_same_scan_twice_counts_once()
    {
        var a = In(A, 1, T0);

        var r = Replay(a, a, Out(A, 1, T0.AddMinutes(1)));

        Assert.Single(r.Done);
    }

    [Fact]
    public void The_same_element_at_two_stations_is_two_records()
    {
        var r = Replay(In(A, 1, T0), Out(A, 1, T0.AddMinutes(5)), In(A, 7, T0.AddMinutes(6)), Out(A, 7, T0.AddMinutes(8)));

        Assert.Equal([1, 7], r.Done.Select(d => d.Station.Number));
        Assert.Equal(StationKind.Packing, r.Done[1].Station.Kind);
    }

    [Fact]
    public void A_station_the_settings_do_not_know_is_taken_from_the_scan()
    {
        var r = ScanReplay.Replay([In(A, 9, T0), Out(A, 9, T0.AddMinutes(1))], StationConfig.Defaults);

        Assert.Equal(new StationConfig(9, "Station 9"), r.Done[0].Station);
    }

    [Fact]
    public void State_restored_from_a_replay_carries_on_like_before()
    {
        var r = Replay(In(A, 1, T0));
        var s = new StationState(StationConfig.Defaults[0]);
        s.Restore(r.InProgress[1]);

        var end = s.Scan(Code(A), T0.AddMinutes(4));

        Assert.Equal(ScanKind.Out, end.Kind);
        Assert.Equal(TimeSpan.FromMinutes(4), end.Duration);
    }

    [Fact]
    public void Reset_clears_a_station()
    {
        var s = new StationState(StationConfig.Defaults[0]);
        s.Restore(Code(A), T0);

        s.Reset();

        Assert.False(s.IsBusy);
        Assert.Null(s.StartedAt);
    }

    [Fact]
    public void A_station_set_up_for_several_keeps_its_latest_open_ins_up_to_its_max()
    {
        StationConfig[] stations = [.. StationConfig.Defaults.Select(s => s.Number == 3 ? s with { MaxActive = 2 } : s)];

        var r = ScanReplay.Replay([In(A, 3, T0), In(B, 3, T0.AddMinutes(5)), In(C, 3, T0.AddMinutes(10)), In(A, 1, T0), In(B, 1, T0.AddMinutes(1))], stations);

        Assert.Equal([new ActiveElement(Code(B), T0.AddMinutes(5)), new ActiveElement(Code(C), T0.AddMinutes(10))], r.InProgress[3]);
        Assert.Equal([new ActiveElement(Code(B), T0.AddMinutes(1))], r.InProgress[1]);

        // maxOpen, when given for a station, is its max.
        var given = ScanReplay.Replay([In(A, 3, T0), In(B, 3, T0.AddMinutes(5)), In(C, 3, T0.AddMinutes(10))], stations, maxOpen: new Dictionary<int, int> { [3] = 6 });
        Assert.Equal(3, given.InProgress[3].Count);
    }

    // A Mark carries no time and never pairs. Until the Session rules read them (plan step 6), they
    // change nothing: not an Out, not an In, not a record.
    [Fact]
    public void A_mark_row_is_left_out_of_the_pairing()
    {
        var mark = Scan(A, 1, ScanDirection.Mark, T0.AddMinutes(5)) with { Event = ScanEventKind.Hold };
        var orphan = Scan(B, 1, ScanDirection.Mark, T0.AddMinutes(6), duration: 60) with { Event = ScanEventKind.ShiftEnd };

        var open = Replay(In(A, 1, T0), mark, orphan);
        var closed = Replay(In(A, 1, T0), mark, Out(A, 1, T0.AddMinutes(10)));

        Assert.Equal(new ActiveElement(Code(A), T0), Assert.Single(open.InProgress[1]));
        Assert.Empty(open.Done);
        Assert.Empty(closed.InProgress);
        Assert.Equal(new WorkRecord(StationConfig.Defaults[0], Code(A), T0, T0.AddMinutes(10)), Assert.Single(closed.Done));
    }

    // Pause-Out and Resume-In pair as ordinary passes for now (plan §6.1); chains come with step 6.
    [Fact]
    public void Rows_with_an_event_pair_as_ordinary_passes()
    {
        var r = Replay(
            In(A, 1, T0),
            Out(A, 1, T0.AddMinutes(10)) with { Event = ScanEventKind.Pause },
            In(A, 1, T0.AddMinutes(30)) with { Event = ScanEventKind.Resume },
            Out(A, 1, T0.AddMinutes(35)) with { Event = ScanEventKind.ShiftEnd });

        Assert.Empty(r.InProgress);
        Assert.Equal([TimeSpan.FromMinutes(10), TimeSpan.FromMinutes(5)], r.Done.Select(d => d.Duration));
    }

    // --- Stop at shift end (docs/plan-shift-end.md §4.5, §4.6, §6.4)

    static ScanEvent ShiftEndOut(string barcode, int station, DateTimeOffset at, int seconds) =>
        Scan(barcode, station, ScanDirection.Out, at, seconds) with { Event = ScanEventKind.ShiftEnd };

    [Fact]
    public void A_shift_end_out_ends_the_record_auto_stopped_and_the_station_shows_its_stop()
    {
        var r = Replay(In(A, 3, T0), In(B, 3, T0.AddMinutes(20)), ShiftEndOut(A, 3, T0.AddHours(2), 7200), ShiftEndOut(B, 3, T0.AddHours(2), 6000),
            In(C, 1, T0), Out(C, 1, T0.AddMinutes(30)));

        Assert.Empty(r.InProgress);
        Assert.Equal([false, true, true], r.Done.Select(d => d.AutoStopped));
        Assert.Equal(ScanEventKind.ShiftEnd, r.Done[1].EndEvent);
        var stop = Assert.Single(r.AutoStopped);
        Assert.Equal(3, stop.Key);
        Assert.Equal(T0.AddHours(2), stop.Value.At);
        Assert.Equal([B, A], stop.Value.Elements.Select(b => b.Raw).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void After_a_restart_a_stopped_element_is_not_in_progress_and_an_open_one_keeps_its_in_id()
    {
        var a = In(A, 1, T0);
        var b = In(B, 2, T0.AddMinutes(5));

        var r = Replay(a, ShiftEndOut(A, 1, T0.AddHours(2), 7200), b);

        Assert.False(r.InProgress.ContainsKey(1));
        Assert.Equal(b.ScanId, Assert.Single(r.InProgress[2]).InScanId);
        Assert.True(Assert.Single(r.Done).AutoStopped);
    }

    [Fact]
    public void A_late_out_within_12_hours_of_the_stop_ends_the_record_instead()
    {
        var r = Replay(In(A, 1, T0), ShiftEndOut(A, 1, T0.AddHours(2), 7200), Out(A, 1, T0.AddHours(3)) with { DurationSec = 10800 });

        var record = Assert.Single(r.Done);
        Assert.Equal((T0, T0.AddHours(3), ScanEventKind.Scan), (record.Start, record.End, record.EndEvent));
        Assert.Empty(r.AutoStopped);

        // Exactly 12 hours still wins.
        Assert.Equal(T0.AddHours(14), Assert.Single(Replay(In(A, 1, T0), ShiftEndOut(A, 1, T0.AddHours(2), 7200), Out(A, 1, T0.AddHours(14))).Done).End);
    }

    [Fact]
    public void A_late_out_more_than_12_hours_after_the_stop_is_skipped()
    {
        var late = Scan(A, 1, ScanDirection.Out, T0.AddHours(15), 54000);

        var r = Replay(In(A, 1, T0), ShiftEndOut(A, 1, T0.AddHours(2), 7200), late);

        var record = Assert.Single(r.Done);
        Assert.Equal((T0.AddHours(2), ScanEventKind.ShiftEnd), (record.End, record.EndEvent));

        // With today after the stop: the stop is not today's, and the late Out makes nothing.
        Assert.Empty(ScanReplay.Replay([In(A, 1, T0), ShiftEndOut(A, 1, T0.AddHours(2), 7200), late], StationConfig.Defaults, T0.AddHours(10)).Done);
    }

    [Fact]
    public void A_late_out_moves_a_stop_from_before_today_into_today()
    {
        var r = ScanReplay.Replay([In(A, 1, T0), ShiftEndOut(A, 1, T0.AddHours(2), 7200), Out(A, 1, T0.AddHours(5))], StationConfig.Defaults, T0.AddHours(4));

        var record = Assert.Single(r.Done);
        Assert.Equal((T0, T0.AddHours(5)), (record.Start, record.End));
    }

    [Fact]
    public void After_a_stop_the_next_morning_scan_is_an_in_and_starts_a_new_pass()
    {
        var morning = T0.AddHours(24);
        var r = Replay(In(A, 1, T0), ShiftEndOut(A, 1, T0.AddHours(2), 7200), In(A, 1, morning));

        Assert.Equal(new ActiveElement(Code(A), morning), Assert.Single(r.InProgress[1]));
        Assert.True(Assert.Single(r.Done).AutoStopped);
        // Yesterday's stop is still known within the window, for the "Startet igen" text.
        Assert.Equal(T0.AddHours(2), r.AutoStopped[1].At);

        // And its Out pairs with that In, not with the stop.
        var done = Replay(In(A, 1, T0), ShiftEndOut(A, 1, T0.AddHours(2), 7200), In(A, 1, morning), Out(A, 1, morning.AddMinutes(30)));
        Assert.Equal([(T0, T0.AddHours(2)), (morning, morning.AddMinutes(30))], done.Done.Select(d => (d.Start, d.End)));
    }

    [Fact]
    public void A_shift_end_mark_closes_a_pause_and_marks_its_record()
    {
        var mark = Scan(A, 3, ScanDirection.Mark, T0.AddHours(6)) with { Event = ScanEventKind.ShiftEnd };

        var r = Replay(In(A, 3, T0), Out(A, 3, T0.AddMinutes(30)) with { Event = ScanEventKind.Pause }, mark);

        var record = Assert.Single(r.Done);
        Assert.Equal((T0.AddMinutes(30), ScanEventKind.ShiftEnd), (record.End, record.EndEvent));
        Assert.Equal(T0.AddHours(6), r.AutoStopped[3].At);
        // A late Out does not follow a closed pause: it is timed from its own DurationSec as before.
        Assert.Equal(2, Replay(In(A, 3, T0), Out(A, 3, T0.AddMinutes(30)) with { Event = ScanEventKind.Pause }, mark,
            Scan(A, 3, ScanDirection.Out, T0.AddHours(7), 60)).Done.Count);
    }
}
