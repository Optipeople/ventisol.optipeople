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
    public async Task A_scan_refused_three_times_alike_is_moved_aside_and_the_rest_go_on()
    {
        var bad = In("058556050103", 1, T0);
        var good = In("058556050102", 2, T0.AddMinutes(1));
        new Outbox(_folder).Add(bad);
        new Outbox(_folder).Add(good);
        var sent = new List<ScanEvent>();
        var log = new List<string>();
        var box = new Outbox(_folder, m => { lock (log) log.Add(m); });
        var refused = new List<ScanEvent>();
        box.Refused += (_, e) => { lock (refused) refused.Add(e); };
        var tries = 0;
        var waits = new List<TimeSpan>();
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((e, _) =>
        {
            if (e.ScanId == bad.ScanId)
            {
                tries++;
                throw new OptiCloudException("OptiCloud svarede: nej", 400, rejected: true);
            }
            lock (sent) sent.Add(e);
            return Task.CompletedTask;
        }, stop.Token, Record(waits));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(Outbox.RefusalsBeforeAside, tries);
        Assert.Equal([2, 5], waits.Select(w => w.TotalSeconds));
        Assert.Equal([good], sent);
        Assert.Equal([bad], refused);
        Assert.Equal(1, box.Failed);
        Assert.Single(Directory.GetFiles(Path.Combine(_folder, "failed"), "*.json"));
        Assert.Contains(log, l => l.Contains("failed") && l.Contains("nej"));
    }

    [Fact(Timeout = 10000)]
    public async Task Refusals_must_be_alike_to_count_and_a_network_failure_between_does_not_reset_them()
    {
        var box = new Outbox(_folder);
        box.Add(In("058556050103", 1, T0));
        var answers = new Queue<OptiCloudException>(
        [
            new("OptiCloud svarede: a", 400, rejected: true),
            new("OptiCloud svarede: b", 400, rejected: true),
            new(OptiCloudException.Unreachable),
            new("OptiCloud svarede: b", 400, rejected: true),
            new("OptiCloud svarede: b", 400, rejected: true),
        ]);
        var tries = 0;
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((_, _) =>
        {
            tries++;
            throw answers.Dequeue();
        }, stop.Token, Record([]));
        await Until(() => box.Failed == 1);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(5, tries);
        Assert.Equal(0, box.Pending);
    }

    [Fact(Timeout = 10000)]
    public async Task A_user_without_access_is_retried_never_moved_aside()
    {
        var box = new Outbox(_folder);
        var a = In("058556050103", 1, T0);
        box.Add(a);
        var tries = 0;
        var failed = new List<OptiCloudException>();
        box.SendFailed += (_, x) => { lock (failed) failed.Add(x); };
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((_, _) =>
        {
            if (++tries <= 5) throw new OptiCloudException(OptiCloudException.Forbidden, 403, auth: true);
            return Task.CompletedTask;
        }, stop.Token, Record([]));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(6, tries);
        Assert.Equal(5, failed.Count);
        Assert.Equal(0, box.Failed);
    }

    [Fact]
    public void A_wrong_password_waits_a_quarter_of_an_hour()
    {
        Assert.Equal(TimeSpan.FromMinutes(15), Outbox.Wait(new OptiCloudException(OptiCloudException.BadLogin, 400, auth: true), 0));
        Assert.Equal(TimeSpan.FromSeconds(2), Outbox.Wait(new OptiCloudException(OptiCloudException.Forbidden, 403, auth: true), 0));
        Assert.Equal(TimeSpan.FromSeconds(60), Outbox.Wait(new OptiCloudException(OptiCloudException.Unreachable), 9));
    }

    [Fact(Timeout = 10000)]
    public async Task A_sent_file_that_will_not_delete_is_not_sent_again_and_goes_later()
    {
        var box = new Outbox(_folder);
        var a = In("058556050103", 1, T0);
        box.Add(a);
        var file = Directory.GetFiles(_folder, "*.json").Single();
        var sent = new List<ScanEvent>();
        var waits = new List<TimeSpan>();
        using var stop = new CancellationTokenSource();
        Task run;

        // Open without delete sharing, as a virus scanner might: File.Delete fails.
        using (new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            run = box.RunAsync((e, _) => { lock (sent) sent.Add(e); return Task.CompletedTask; }, stop.Token, (t, ct) =>
            {
                lock (waits) waits.Add(t);
                return Task.Delay(5, ct);
            });
            await Until(() => { lock (waits) return waits.Count >= 3; });
            Assert.Equal([a], sent);
            Assert.Equal(0, box.Pending);
            Assert.Empty(box.Peek());
            Assert.True(File.Exists(file));
        }

        await Until(() => !File.Exists(file));
        var b = In("058556050102", 2, T0);
        box.Add(b);
        await Until(() => { lock (sent) return sent.Count == 2; });
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([a, b], sent);
        Assert.Equal([2, 5, 15], waits.Take(3).Select(w => w.TotalSeconds));
    }

    [Fact]
    public void Refused_scans_can_be_put_back_in_line()
    {
        var a = In("058556050103", 1, T0);
        new Outbox(_folder).Add(a);
        var failed = Directory.CreateDirectory(Path.Combine(_folder, "failed")).FullName;
        foreach (var f in Directory.GetFiles(_folder, "*.json")) File.Move(f, Path.Combine(failed, Path.GetFileName(f)));
        var box = new Outbox(_folder);
        Assert.Equal((0, 1), (box.Pending, box.Failed));

        Assert.Equal(1, box.RetryFailed());

        Assert.Equal((1, 0), (box.Pending, box.Failed));
        Assert.Equal([a], box.Peek());
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
