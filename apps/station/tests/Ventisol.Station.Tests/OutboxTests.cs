using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public sealed class OutboxTests : IDisposable
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 6, 0, 0, TimeSpan.Zero);
    readonly string _folder = TempFolder();

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch (IOException) { }
    }

    static Func<TimeSpan, CancellationToken, Task> Record(List<TimeSpan> waits) => (t, _) =>
    {
        lock (waits) waits.Add(t);
        return Task.CompletedTask;
    };

    [Fact]
    public void Waiting_scans_survive_a_restart()
    {
        var a = In("058556050103", 1, T0);
        var b = Out("058556050103", 1, T0.AddMinutes(3));
        new Outbox(_folder).Add(a);
        new Outbox(_folder).Add(b);

        var again = new Outbox(_folder);

        Assert.Equal(2, again.Pending);
        Assert.Equal([a, b], again.Peek());
        Assert.Empty(Directory.GetFiles(_folder, "*.tmp"));
    }

    [Fact]
    public void A_half_written_file_from_a_crash_is_finished_or_dropped()
    {
        var a = In("058556050103", 1, T0);
        new Outbox(_folder).Add(a);
        var file = Directory.GetFiles(_folder, "*.json").Single();
        File.Move(file, file + ".tmp");
        File.WriteAllText(Path.Combine(_folder, "0000000000000000001-x.json.tmp"), "{ half");

        var again = new Outbox(_folder);

        Assert.Equal([a], again.Peek());
        Assert.Empty(Directory.GetFiles(_folder, "*.tmp"));
    }

    [Fact(Timeout = 10000)]
    public async Task Sends_oldest_first_and_empties()
    {
        var box = new Outbox(_folder);
        var scans = Enumerable.Range(0, 5).Select(i => In("058556050103", 1, T0.AddMinutes(-i))).ToList();
        foreach (var s in scans) box.Add(s);
        var sent = new List<ScanEvent>();
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((e, _) => { lock (sent) sent.Add(e); return Task.CompletedTask; }, stop.Token);
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(scans, sent);
    }

    [Fact(Timeout = 10000)]
    public async Task A_failure_backs_off_and_keeps_the_order()
    {
        var box = new Outbox(_folder);
        var a = In("058556050103", 1, T0);
        var b = Out("058556050103", 1, T0.AddMinutes(1));
        box.Add(a);
        box.Add(b);
        var waits = new List<TimeSpan>();
        var sent = new List<ScanEvent>();
        var failures = 0;
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((e, _) =>
        {
            if (failures < 6) { failures++; throw new OptiCloudException(OptiCloudException.Unreachable); }
            lock (sent) sent.Add(e);
            return Task.CompletedTask;
        }, stop.Token, Record(waits));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([a, b], sent);
        Assert.Equal([2, 5, 15, 30, 60, 60], waits.Select(w => w.TotalSeconds));
    }

    [Fact(Timeout = 10000)]
    public async Task A_scan_the_server_refuses_is_moved_aside_and_the_rest_go_on()
    {
        var box = new Outbox(_folder);
        var bad = In("058556050103", 1, T0);
        var good = In("058556050102", 2, T0.AddMinutes(1));
        box.Add(bad);
        box.Add(good);
        var sent = new List<ScanEvent>();
        var log = new List<string>();
        box = new Outbox(_folder, m => { lock (log) log.Add(m); });
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((e, _) =>
        {
            if (e.ScanId == bad.ScanId) throw new OptiCloudException("OptiCloud svarede: nej", 400, rejected: true);
            lock (sent) sent.Add(e);
            return Task.CompletedTask;
        }, stop.Token, Record([]));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([good], sent);
        Assert.Single(Directory.GetFiles(Path.Combine(_folder, "failed"), "*.json"));
        Assert.Contains(log, l => l.Contains("failed") && l.Contains("nej"));
    }

    [Fact(Timeout = 10000)]
    public async Task Pending_is_told_as_it_changes()
    {
        var box = new Outbox(_folder);
        var counts = new List<int>();
        box.PendingChanged += (_, n) => { lock (counts) counts.Add(n); };

        box.Add(In("058556050103", 1, T0));
        box.Add(In("058556050102", 2, T0));
        using var stop = new CancellationTokenSource();
        var run = box.RunAsync((_, _) => Task.CompletedTask, stop.Token);
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([1, 2, 1, 0], counts);
    }
}
