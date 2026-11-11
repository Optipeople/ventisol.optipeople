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
            Assert.Null(box.Oldest());
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

    // Fails the first try, then waits ten minutes after it unless the wait is cut short.
    async Task<(List<ScanEvent> Sent, Task Run, CancellationTokenSource Stop)> FailOnceThenWaitLong(Outbox box, OptiCloudException failure)
    {
        var sent = new List<ScanEvent>();
        var failed = 0;
        var stop = new CancellationTokenSource();
        var run = box.RunAsync((e, _) =>
        {
            if (Interlocked.Increment(ref failed) == 1) throw failure;
            lock (sent) sent.Add(e);
            return Task.CompletedTask;
        }, stop.Token, (_, ct) => Task.Delay(TimeSpan.FromMinutes(10), ct));
        await Until(() => Volatile.Read(ref failed) >= 1);
        return (sent, run, stop);
    }

    [Fact(Timeout = 10000)]
    public async Task A_nudge_ends_the_wait_after_a_failure_and_tries_at_once()
    {
        var box = new Outbox(_folder);
        var a = In("058556050103", 1, T0);
        box.Add(a);
        var (sent, run, stop) = await FailOnceThenWaitLong(box, new OptiCloudException(OptiCloudException.Unreachable));

        box.Nudge();
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([a], sent);
    }

    [Fact(Timeout = 10000)]
    public async Task A_new_scan_ends_the_wait_and_both_go_in_order()
    {
        var box = new Outbox(_folder);
        var a = In("058556050103", 1, T0);
        box.Add(a);
        var (sent, run, stop) = await FailOnceThenWaitLong(box, new OptiCloudException(OptiCloudException.Unreachable));

        var b = Out("058556050103", 1, T0.AddMinutes(1));
        box.Add(b);
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([a, b], sent);
    }

    [Fact(Timeout = 10000)]
    public async Task A_nudge_does_not_end_the_wait_after_a_wrong_password()
    {
        var box = new Outbox(_folder);
        box.Add(In("058556050103", 1, T0));
        var (sent, run, stop) = await FailOnceThenWaitLong(box, new OptiCloudException(OptiCloudException.BadLogin, 400, auth: true));

        box.Nudge();
        box.Add(In("058556050102", 2, T0));
        await Task.Delay(300);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Empty(sent);
        Assert.Equal(2, box.Pending);
    }

    [Theory]
    [InlineData(null, false, OptiCloudException.Unreachable, true)]
    [InlineData(null, false, OptiCloudException.Unreachable + " (intet svar)", true)]
    [InlineData(400, true, "OptiCloud svarede: nej", false)]
    [InlineData(500, false, "OptiCloud har en fejl (500)", false)]
    [InlineData(403, false, OptiCloudException.Forbidden, false)]
    [InlineData(400, false, OptiCloudException.BadLogin, false)]
    public void Only_not_reaching_opticloud_is_cut_short_by_a_nudge(int? status, bool rejected, string message, bool ends)
    {
        var auth = message is OptiCloudException.Forbidden or OptiCloudException.BadLogin;
        Assert.Equal(ends, Outbox.NudgeEnds(new OptiCloudException(message, status, rejected, auth)));
    }

    [Fact(Timeout = 10000)]
    public async Task Neither_a_nudge_nor_a_new_scan_ends_the_wait_after_a_refusal()
    {
        // Else scans every few seconds would use up the refusals before one is moved aside in seconds.
        var box = new Outbox(_folder);
        box.Add(In("058556050103", 1, T0));
        var tokens = new List<CancellationToken>();
        using var stop = new CancellationTokenSource();
        var run = box.RunAsync((_, _) => throw new OptiCloudException("OptiCloud svarede: nej", 400, rejected: true), stop.Token, (_, ct) =>
        {
            lock (tokens) tokens.Add(ct);
            return Task.Delay(Timeout.Infinite, ct);
        });
        await Until(() => { lock (tokens) return tokens.Count == 1; });

        box.Nudge();
        box.Add(In("058556050102", 2, T0));

        // The wait hangs on the stop token alone, so nothing but stopping ends it.
        lock (tokens) Assert.Equal(stop.Token, tokens[0]);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(0, box.Failed);
    }

    [Fact(Timeout = 10000)]
    public async Task Pending_ends_right_with_scans_added_while_others_are_sent()
    {
        var box = new Outbox(_folder);
        using var stop = new CancellationTokenSource();
        var run = box.RunAsync((_, _) => Task.CompletedTask, stop.Token);

        await Task.WhenAll(Enumerable.Range(0, 4).Select(t => Task.Run(() =>
        {
            for (var i = 0; i < 25; i++) box.Add(In("058556050103", t * 25 + i + 1, T0));
        })));
        await Until(() => box.Peek().Count == 0 && box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(0, box.Pending);
        Assert.Empty(Directory.GetFiles(_folder, "*.json"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_a_power_cut_left_empty_is_rebuilt_from_the_journal_and_sent()
    {
        var journal = new ScanJournal(Path.Combine(_folder, "journal"));
        var a = In("058556050103", 1, T0);
        var b = Out("058556050103", 1, T0.AddMinutes(1));
        var first = new Outbox(_folder);
        foreach (var s in new[] { a, b }) { first.Add(s); journal.Append(s); }
        File.WriteAllBytes(Directory.GetFiles(_folder, "*.json").Order(StringComparer.Ordinal).First(), []);
        var log = new List<string>();
        var box = new Outbox(_folder, m => { lock (log) log.Add(m); }) { Rebuild = journal.Find };
        var sent = new List<ScanEvent>();
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((e, _) => { lock (sent) sent.Add(e); return Task.CompletedTask; }, stop.Token, Record([]));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([a, b], sent);
        Assert.Equal(0, box.Failed);
        Assert.Contains(log, l => l.Contains("journalen"));
    }

    [Fact(Timeout = 10000)]
    public async Task An_empty_file_the_journal_does_not_have_is_moved_aside_and_logged()
    {
        var a = In("058556050103", 1, T0);
        var b = In("058556050102", 2, T0);
        var first = new Outbox(_folder);
        first.Add(a);
        first.Add(b);
        File.WriteAllBytes(Directory.GetFiles(_folder, "*.json").Order(StringComparer.Ordinal).First(), []);
        var log = new List<string>();
        var box = new Outbox(_folder, m => { lock (log) log.Add(m); }) { Rebuild = new ScanJournal(Path.Combine(_folder, "journal")).Find };
        var sent = new List<ScanEvent>();
        using var stop = new CancellationTokenSource();

        var run = box.RunAsync((e, _) => { lock (sent) sent.Add(e); return Task.CompletedTask; }, stop.Token, Record([]));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([b], sent);
        Assert.Equal(1, box.Failed);
        Assert.Contains(log, l => l.Contains("failed"));
    }

    [Fact]
    public void New_scans_stay_behind_older_ones_when_the_clock_was_set_back()
    {
        // Queued while the clock was a day ahead, then the clock was corrected and the PC restarted.
        var a = In("058556050103", 1, T0);
        new Outbox(_folder).Add(a);
        var file = Directory.GetFiles(_folder, "*.json").Single();
        var ahead = DateTime.UtcNow.AddDays(1).Ticks;
        File.Move(file, Path.Combine(_folder, $"{ahead:D19}-{a.ScanId:N}.json"));

        var box = new Outbox(_folder);
        var b = Out("058556050103", 1, T0.AddMinutes(1));
        var c = In("058556050102", 2, T0.AddMinutes(2));
        box.Add(b);
        box.Add(c);

        Assert.Equal([a, b, c], box.Peek());
        Assert.Equal([a, b, c], new Outbox(_folder).Peek());
    }

    [Fact]
    public void Written_files_are_whole_and_leave_no_tmp_behind()
    {
        var box = new Outbox(_folder);
        var a = In("058556050103", 1, T0);
        box.Add(a);

        Assert.Empty(Directory.GetFiles(_folder, "*.tmp"));
        Assert.Equal([a], new Outbox(_folder).Peek());
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_held_by_another_program_waits_and_is_sent_when_it_is_let_go()
    {
        var a = In("058556050103", 1, T0);
        var b = Out("058556050103", 1, T0.AddMinutes(1));
        var log = new List<string>();
        var box = new Outbox(_folder, m => { lock (log) log.Add(m); }) { Rebuild = _ => null };
        box.Add(a);
        box.Add(b);
        var first = Directory.GetFiles(_folder, "*.json").Order(StringComparer.Ordinal).First();
        var sent = new List<ScanEvent>();
        var waits = 0;
        using var stop = new CancellationTokenSource();

        // A virus scanner or a backup has the oldest file open.
        var held = new FileStream(first, FileMode.Open, FileAccess.Read, FileShare.None);
        Task run;
        try
        {
            run = box.RunAsync((e, _) => { lock (sent) sent.Add(e); return Task.CompletedTask; }, stop.Token,
                async (_, ct) => { Interlocked.Increment(ref waits); await Task.Delay(1, ct); });
            await Until(() => Volatile.Read(ref waits) >= 3);

            // Not a broken file: nothing is moved aside, and the scan behind it waits its turn.
            Assert.False(Directory.Exists(Path.Combine(_folder, "failed")));
            Assert.Equal((2, 0), (box.Pending, box.Failed));
            lock (sent) Assert.Empty(sent);
        }
        finally { held.Dispose(); }

        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([a, b], sent);
        Assert.Equal(0, box.Failed);
        lock (log) Assert.Single(log, l => l.Contains("kan ikke åbnes"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_that_never_opens_is_moved_aside_after_a_set_number_of_tries_and_the_rest_go_on()
    {
        var a = In("058556050103", 1, T0);
        var b = Out("058556050103", 1, T0.AddMinutes(1));
        var log = new List<string>();
        var box = new Outbox(_folder, m => { lock (log) log.Add(m); }) { Rebuild = _ => null };
        box.Add(a);
        box.Add(b);
        var first = Directory.GetFiles(_folder, "*.json").Order(StringComparer.Ordinal).First();
        var sent = new List<ScanEvent>();
        var waits = new List<TimeSpan>();
        using var stop = new CancellationTokenSource();

        // Held for good, by something that lets the file be moved but not read.
        using var held = new FileStream(first, FileMode.Open, FileAccess.Read, FileShare.Delete);
        var run = box.RunAsync((e, _) => { lock (sent) sent.Add(e); return Task.CompletedTask; }, stop.Token, Record(waits));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([b], sent);
        Assert.Equal(1, box.Failed);
        Assert.Single(Directory.GetFiles(Path.Combine(_folder, "failed"), "*.json"));
        // A wait between the tries, none after the last one.
        Assert.Equal(Outbox.OpenTriesBeforeAside - 1, waits.Count);
        lock (log)
        {
            Assert.Single(log, l => l.Contains("kan ikke åbnes"));
            Assert.Single(log, l => l.Contains("behandles som ulæselig"));
        }
    }

    // A rule made later for new scans (Barcode.TryParseScan) must not drop a scan already waiting.
    [Fact(Timeout = 10000)]
    public async Task A_waiting_scan_for_an_older_order_is_still_sent_after_a_restart()
    {
        var a = In("057999050103", 1, T0);
        var b = Out("042117030201", 2, T0.AddMinutes(1));
        var first = new Outbox(_folder);
        first.Add(a);
        first.Add(b);
        var box = new Outbox(_folder);
        var sent = new List<ScanEvent>();
        using var stop = new CancellationTokenSource();

        Assert.Equal([a, b], box.Peek());
        var run = box.RunAsync((e, _) => { lock (sent) sent.Add(e); return Task.CompletedTask; }, stop.Token, Record([]));
        await Until(() => box.Pending == 0);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal([a, b], sent);
        Assert.Equal(0, box.Failed);
        Assert.False(Directory.Exists(Path.Combine(_folder, "failed")));
    }

    [Fact]
    public void A_tmp_file_that_is_held_at_the_start_is_left_for_the_next_start()
    {
        var first = new Outbox(_folder);
        first.Add(In("058556050103", 1, T0));
        var file = Directory.GetFiles(_folder, "*.json").Single();
        var tmp = file + ".tmp";
        File.Move(file, tmp);
        var log = new List<string>();

        using (new FileStream(tmp, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            var box = new Outbox(_folder, log.Add);
            Assert.Equal(0, box.Pending);
        }

        Assert.True(File.Exists(tmp));
        Assert.Single(log);
        Assert.Equal(1, new Outbox(_folder).Pending);
    }
}
