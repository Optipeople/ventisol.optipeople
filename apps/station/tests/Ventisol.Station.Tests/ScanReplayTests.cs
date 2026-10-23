using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public class ScanReplayTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 6, 0, 0, TimeSpan.Zero);
    const string A = "058556050103", B = "058556050102";

    static ReplayResult Replay(params ScanEvent[] events) => ScanReplay.Replay(events, StationConfig.Defaults);

    [Fact]
    public void An_in_without_an_out_is_in_progress_since_the_in()
    {
        var r = Replay(In(A, 1, T0));

        Assert.Equal((Code(A), T0), r.InProgress[1]);
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
        Assert.Equal(T0.AddMinutes(30), r.InProgress[1].Since);
    }

    [Fact]
    public void An_out_without_an_in_is_skipped()
    {
        var r = Replay(Out(A, 1, T0), In(B, 1, T0.AddMinutes(1)));

        Assert.Empty(r.Done);
        Assert.Equal(Code(B), r.InProgress[1].Barcode);
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
        s.Restore(r.InProgress[1].Barcode, r.InProgress[1].Since);

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
}
