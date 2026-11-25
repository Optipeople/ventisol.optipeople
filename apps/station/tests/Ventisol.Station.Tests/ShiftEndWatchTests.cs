using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

// docs/plan-shift-end.md §4.3, §4.4 and §6.5: the schedule a station follows, the tile's words, and the
// check the window runs before it writes a stop (plan step 7).
public class ShiftEndWatchTests
{
    static readonly TimeZoneInfo Dk = Zone();

    static TimeZoneInfo Zone()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("Europe/Copenhagen"); }
        catch (TimeZoneNotFoundException) { return TimeZoneInfo.FindSystemTimeZoneById("Romance Standard Time"); }
    }

    // Danish wall clock, Monday 23 November 2026 unless said.
    static DateTimeOffset Local(int hour, int minute = 0, int day = 23) =>
        ShiftSchedule.Instant(new DateOnly(2026, 11, day), new TimeOnly(hour, minute), Dk);

    static readonly ShiftSchedule Day = ShiftSchedule.Standard(new(6, 0), new(14, 0));
    static readonly TimeSpan Grace = TimeSpan.FromMinutes(60);
    static readonly DateTimeOffset E = Local(14);

    const string A = "058556050103", B = "058556050104";

    static readonly StationConfig Station = new(1, "Station 10", MaxActive: 3);

    // The station as the window has it after a replay of rows.
    static StationState Restored(IEnumerable<ScanEvent> rows)
    {
        var state = new StationState(Station);
        state.Restore(ScanReplay.Replay(rows, [Station]).InProgress.GetValueOrDefault(Station.Number) ?? []);
        return state;
    }

    // --- Where the shifts come from

    [Fact]
    public void A_station_follows_the_standard_shift_and_its_machine_s_shifts_win_once_known()
    {
        var machine = Guid.NewGuid();
        var settings = StationSettings.Default with
        {
            Stations = [new StationSetup(1, "Station 10", StationKind.Assembly, machine), new StationSetup(2, "Station 20", StationKind.Assembly)],
            StandardShift = new StandardShift(new(6, 0), new(14, 0)),
        };
        var night = ShiftSchedule.Standard(new(22, 0), new(6, 0));

        Assert.Equal(Day.Blocks, ShiftSchedules.For(settings, 1)!.Blocks);
        Assert.Same(night, ShiftSchedules.For(settings, 1, m => m == machine ? night : null));
        // A station without a machine, or a machine without shifts: the standard shift.
        Assert.Equal(Day.Blocks, ShiftSchedules.For(settings, 2, _ => night)!.Blocks);
        Assert.Equal(Day.Blocks, ShiftSchedules.For(settings, 1, _ => null)!.Blocks);
        Assert.Null(ShiftSchedules.For(settings with { StandardShift = null }, 1));
        Assert.Null(ShiftSchedules.For(settings with { ShiftEndOn = false }, 1, _ => night));
        Assert.Equal(TimeSpan.FromMinutes(15), ShiftSchedules.Grace(settings with { ShiftEndGraceMinutes = 1 }));
    }

    [Fact]
    public void Only_a_station_whose_scanner_is_on_this_pc_is_judged_here()
    {
        var settings = StationSettings.Default with
        {
            Mode = StationMode.Scan,
            Stations =
            [
                new StationSetup(1, "Station 10", StationKind.Assembly, ScannerSerial: "usb:PCIROOT(0)#USB(1)"),
                new StationSetup(2, "Station 20", StationKind.Assembly, ScannerSerial: "keyboard"),
                new StationSetup(3, "Station 30", StationKind.Assembly),
            ],
        };

        Assert.True(ShiftSchedules.ScansHere(settings, 1));
        Assert.True(ShiftSchedules.ScansHere(settings, 2));
        // Its scanner is on another PC (or not set up): this PC never sees its taps and refused scans.
        Assert.False(ShiftSchedules.ScansHere(settings, 3));
        Assert.False(ShiftSchedules.ScansHere(settings, 9));
        Assert.False(ShiftSchedules.ScansHere(settings with { Mode = StationMode.Viewer }, 1));

        // No scanner set up anywhere: a keyboard scanner scans at the first station, so that one is.
        var none = settings with { Stations = [.. settings.Stations.Select(s => s with { ScannerSerial = null })] };
        Assert.True(ShiftSchedules.ScansHere(none, 1));
        Assert.False(ShiftSchedules.ScansHere(none, 2));
    }

    // --- The tile's words

    [Fact]
    public void The_tile_says_grace_overtime_and_stopped_with_a_countdown_in_whole_minutes()
    {
        var grace = new ShiftEndDue(1, E, E + Grace, E);
        var overtime = new ShiftEndDue(1, Local(14, 25), Local(15, 25), E);

        Assert.Equal(ShiftEndState.None, ShiftEndTexts.StateOf(null, E));
        Assert.Equal(ShiftEndState.Grace, ShiftEndTexts.StateOf(grace, Local(14, 18)));
        Assert.Equal(ShiftEndState.Overtime, ShiftEndTexts.StateOf(overtime, Local(14, 30)));

        Assert.Equal("Vagten sluttede 14:00", ShiftEndTexts.Title(ShiftEndState.Grace, grace, Dk));
        Assert.Equal("Overarbejde", ShiftEndTexts.Title(ShiftEndState.Overtime, overtime, Dk));
        Assert.Equal("Stoppet ved vagtskifte 14:00", ShiftEndTexts.Title(ShiftEndState.Stopped, grace, Dk));
        Assert.Equal("Stopper om 42 min, hvis intet sker", ShiftEndTexts.Countdown(E + Grace, Local(14, 18)));
        Assert.Equal("Stopper om 42 min, hvis intet sker", ShiftEndTexts.Countdown(E + Grace, Local(14, 18).AddSeconds(30)));
        Assert.Equal("Stopper om 1 min, hvis intet sker", ShiftEndTexts.Countdown(E + Grace, E + Grace));
        Assert.Equal("Stoppet ved vagtskifte 15:10", ShiftEndTexts.Stopped(Local(15, 10), Dk));
    }

    [Fact]
    public void Startet_igen_says_when_the_element_was_stopped()
    {
        Assert.Equal("Startet igen", ShiftEndTexts.Restarted);
        Assert.Equal("Blev stoppet ved vagtskifte i går 14:00 – scan igen for at stoppe",
            ShiftEndTexts.RestartedDetail(E, Local(6, 30, day: 24), Dk));
        Assert.Equal("Blev stoppet ved vagtskifte i dag 14:00 – scan igen for at stoppe",
            ShiftEndTexts.RestartedDetail(E, Local(16), Dk));
        // Friday's stop, scanned again on Monday morning (inside the window only on a long weekend's tail).
        Assert.Equal("Blev stoppet ved vagtskifte fredag 14:00 – scan igen for at stoppe",
            ShiftEndTexts.RestartedDetail(Local(14, day: 27), Local(6, day: 29), Dk));
    }

    // --- The check before writing

    [Fact]
    public void During_the_grace_it_counts_down_and_writes_nothing()
    {
        var rows = new[] { In(A, 1, Local(13, 20)) };
        var watch = new ShiftEndWatch(cloudSetUp: true, started: Local(6));
        watch.Loaded(new LoadedScans(rows, Local(6), FromCloud: true));

        var check = watch.Check(Restored(rows), Day, [], Grace, Local(14, 18), Dk);

        Assert.Equal(ShiftEndVerdict.Counting, check.Verdict);
        Assert.Equal(new ShiftEndDue(1, E, E + Grace, E), check.Due);
        Assert.Equal(ShiftEndVerdict.Nothing, watch.Check(Restored(rows), Day, [], Grace, Local(13, 50), Dk).Verdict);
        Assert.Equal(ShiftEndVerdict.Nothing, watch.Check(Restored(rows), null, [], Grace, Local(18), Dk).Verdict);
    }

    [Fact]
    public void Activity_noted_on_this_pc_and_rows_recorded_since_the_load_move_the_stop()
    {
        var rows = new[] { In(A, 1, Local(13, 20)) };
        var watch = new ShiftEndWatch(cloudSetUp: true, started: Local(6));
        watch.Loaded(new LoadedScans(rows, Local(6), FromCloud: true));
        var state = Restored(rows);

        // A refused scan at 14:25 (only this PC knows it), then a scan at another station.
        watch.Local.Note(1, Local(14, 25));
        var check = watch.Check(state, Day, [In(B, 2, Local(14, 50))], Grace, Local(15, 10), Dk);
        Assert.Equal(new ShiftEndDue(1, Local(14, 25), Local(15, 25), E), check.Due);
        Assert.Equal(ShiftEndState.Overtime, ShiftEndTexts.StateOf(check.Due, Local(15, 10)));

        // A row recorded here at 15:00 at this station.
        check = watch.Check(state, Day, [In(B, 1, Local(15))], Grace, Local(15, 30), Dk);
        Assert.Equal(Local(15), check.Due!.StopAt);

        // A ShiftEnd row is no activity.
        var stop = Out(B, 1, Local(15)) with { Event = ScanEventKind.ShiftEnd };
        Assert.Equal(Local(14, 25), watch.Check(state, Day, [stop], Grace, Local(15, 10), Dk).Due!.StopAt);
    }

    [Fact]
    public void The_catch_up_on_start_writes_the_back_dated_rows_in_in_order()
    {
        // The PC was off from 13:50 to 18:00: two elements in progress, scanned in at 13:20 and 13:40.
        var inA = In(A, 1, Local(13, 20));
        var inB = In(B, 1, Local(13, 40));
        var watch = new ShiftEndWatch(cloudSetUp: true, started: Local(18));
        watch.Loaded(new LoadedScans([inB, inA], Local(6), FromCloud: true));
        var state = Restored([inB, inA]);

        var check = watch.Check(state, Day, [], Grace, Local(18), Dk);
        Assert.Equal(ShiftEndVerdict.Write, check.Verdict);
        Assert.Equal(E, check.Due!.StopAt);

        var written = state.StopAll(check.Due.StopAt, ScanEventKind.ShiftEnd);
        var rows = written.Select(r => ScanEvent.From(r, null, "TEST-PC")!).ToList();

        Assert.False(state.IsBusy);
        Assert.Equal([A, B], rows.Select(r => r.Barcode.Raw));
        Assert.All(rows, r =>
        {
            Assert.Equal(ScanDirection.Out, r.Direction);
            Assert.Equal(ScanEventKind.ShiftEnd, r.Event);
            Assert.Equal(E, r.At);
        });
        Assert.Equal([40 * 60, 20 * 60], rows.Select(r => r.DurationSec));
        Assert.Equal([ShiftEndRule.StopId(inA.ScanId), ShiftEndRule.StopId(inB.ScanId)], rows.Select(r => r.ScanId));

        // Replayed, the passes end at the shift end and the station shows the stop.
        var replay = ScanReplay.Replay([inA, inB, .. rows], [Station]);
        Assert.Empty(replay.InProgress);
        Assert.Equal(E, replay.AutoStopped[1].At);
    }

    [Fact]
    public void The_catch_up_stops_only_elements_scanned_in_before_the_stop_time()
    {
        // Max i gang 2. A in progress since Monday 10:00, the PC off overnight; on Tuesday at 06:01
        // B is scanned in before the rebuild. The catch-up stops A at Monday 14:00 and keeps B.
        var station = Station with { MaxActive = 2 };
        var inA = In(A, 1, Local(10));
        var inB = In(B, 1, Local(6, 1, day: 24));
        var watch = new ShiftEndWatch(cloudSetUp: true, started: Local(6, day: 24));
        watch.Loaded(new LoadedScans([inA, inB], Local(6), FromCloud: true));
        var state = new StationState(station);
        state.Restore(ScanReplay.Replay([inA, inB], [station]).InProgress[1]);

        var check = watch.Check(state, Day, [], Grace, Local(6, 2, day: 24), Dk);
        Assert.Equal(ShiftEndVerdict.Write, check.Verdict);
        Assert.Equal(E, check.Due!.StopAt);

        var written = Assert.Single(state.StopAll(check.Due.StopAt, ScanEventKind.ShiftEnd));
        Assert.Equal((A, E, TimeSpan.FromHours(4)), (written.Barcode.Raw, written.At, written.Duration!.Value));
        Assert.Equal([B], state.Active.Select(a => a.Barcode.Raw));

        // The machine keeps B's order, and the next check finds nothing more to stop.
        var setups = new[] { new StationSetup(1, "Station 10", StationKind.Assembly, Guid.NewGuid()) };
        Assert.Equal(B, MachineOrders.DesiredFrom(setups, [state]).Values.Single().Number);
        Assert.Equal(ShiftEndVerdict.Nothing, watch.Check(state, Day, [ScanEvent.From(written, null, "TEST-PC")!], Grace, Local(6, 3, day: 24), Dk).Verdict);
    }

    [Fact]
    public void Nothing_is_written_before_the_rebuild_from_opticloud()
    {
        var rows = new[] { In(A, 1, Local(13, 20)) };
        var watch = new ShiftEndWatch(cloudSetUp: true, started: Local(17, 58));
        var state = Restored(rows);

        // Nothing loaded yet, then only the journal.
        Assert.Equal(ShiftEndVerdict.Waiting, watch.Check(state, Day, [], Grace, Local(18), Dk).Verdict);
        watch.Loaded(new LoadedScans(rows, Local(6)));
        Assert.Equal(ShiftEndVerdict.Waiting, watch.Check(state, Day, [], Grace, Local(18), Dk).Verdict);
        Assert.False(watch.Rebuilt);

        // OptiCloud's rows: rebuilt.
        watch.Loaded(new LoadedScans(rows, Local(6), FromCloud: true));
        Assert.Equal(ShiftEndVerdict.Write, watch.Check(state, Day, [], Grace, Local(18), Dk).Verdict);
    }

    [Fact]
    public void Without_opticloud_for_five_minutes_the_journal_alone_will_do_and_without_it_set_up_at_once()
    {
        var rows = new[] { In(A, 1, Local(13, 20)) };
        var state = Restored(rows);

        var offline = new ShiftEndWatch(cloudSetUp: true, started: Local(18));
        offline.Loaded(new LoadedScans(rows, Local(6)));
        Assert.Equal(ShiftEndVerdict.Waiting, offline.Check(state, Day, [], Grace, Local(18, 4), Dk).Verdict);
        Assert.Equal(ShiftEndVerdict.Write, offline.Check(state, Day, [], Grace, Local(18, 5), Dk).Verdict);

        var local = new ShiftEndWatch(cloudSetUp: false, started: Local(18));
        local.Loaded(new LoadedScans(rows, Local(6)));
        Assert.Equal(ShiftEndVerdict.Write, local.Check(state, Day, [], Grace, Local(18), Dk).Verdict);
    }

    [Fact]
    public void Nothing_is_written_when_opticloud_already_has_an_out_of_the_element()
    {
        var inA = In(A, 1, Local(13, 20));
        // Scanned out on another PC at 14:30, after this one had last looked.
        var outA = Out(A, 1, Local(14, 30)) with { Device = "OTHER-PC" };
        var state = Restored([inA]);
        var watch = new ShiftEndWatch(cloudSetUp: true, started: Local(6));
        watch.Loaded(new LoadedScans([inA, outA], Local(6), FromCloud: true));

        // Its Out is activity too: the stop would be at 14:30.
        var check = watch.Check(state, Day, [], Grace, Local(16), Dk);
        Assert.Equal(ShiftEndVerdict.EndedElsewhere, check.Verdict);
        Assert.True(state.IsBusy);

        // So is an In of it again after its In; its own In is not.
        Assert.True(ShiftEndWatch.EndedElsewhere([inA, In(A, 1, Local(13, 30))], 1, state.Active[0]));
        Assert.False(ShiftEndWatch.EndedElsewhere([inA, Out(A, 2, Local(14, 30)), Out(B, 1, Local(14, 30))], 1, state.Active[0]));
        Assert.False(ShiftEndWatch.EndedElsewhere([inA with { ScanId = Guid.NewGuid() }], 1, state.Active[0]));
    }

    [Fact(Timeout = 10000)]
    public async Task The_same_stop_written_a_second_time_is_refused_by_its_derived_id()
    {
        var inA = In(A, 1, Local(13, 20));
        var api = new FakeOptiCloud();
        api.AddRow(inA);
        var log = new List<string>();
        using var client = api.Client();
        var table = new ScanTable(client, log.Add);
        await table.EnsureAsync(FakeOptiCloud.Account);

        // Two PCs (or one before and after a restart) each stop the element from the same rows.
        ScanEvent Stop(string device) => ScanEvent.From(Restored([inA]).StopAll(E, ScanEventKind.ShiftEnd).Single(), null, device)!;
        var first = Stop("PC-1");
        var second = Stop("PC-2");
        Assert.Equal(first.ScanId, second.ScanId);

        await table.AddAsync(first);
        await table.AddAsync(second);

        var back = await table.ReadSinceAsync(Local(6));
        Assert.Equal(2, back.Count);
        var stop = Assert.Single(back, e => e.Direction == ScanDirection.Out);
        Assert.Equal(("PC-1", ScanEventKind.ShiftEnd, E), (stop.Device, stop.Event, stop.At));
        Assert.Contains(log, l => l.Contains("var der allerede"));
    }
}
