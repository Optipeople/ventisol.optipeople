namespace Ventisol.Station.Core.Cloud;

// Scans waiting to be sent, one JSON file each in a folder, so a restart or a network outage
// never loses one. Files are named by when they were added, so the name order is the send order.
// A file is written to .tmp and then moved, so a crash never leaves half a scan behind.
// A scan the server refuses the same way RefusalsBeforeAside times in a row is moved to failed\
// and logged, not retried forever; RetryFailed puts those back (after the setup is fixed).
public sealed class Outbox
{
    public static IReadOnlyList<TimeSpan> Backoff { get; } =
        [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60)];

    // A wrong password tried every minute can get the user locked out in OptiCloud.
    public static readonly TimeSpan LoginBackoff = TimeSpan.FromMinutes(15);

    // One refusal may be a passing fault on the server (a deploy, a hiccup in a check):
    // a scan is only given up when it is refused alike this many times, with waits between.
    public const int RefusalsBeforeAside = 3;

    // How long to wait after the failures-th failure in a row (counting from 0).
    public static TimeSpan Wait(Exception? x, int failures) =>
        x is OptiCloudException { IsBadLogin: true } ? LoginBackoff : Backoff[Math.Min(failures, Backoff.Count - 1)];

    readonly string _folder, _failed;
    readonly Action<string> _log;
    readonly Lock _gate = new();
    readonly SemaphoreSlim _wake = new(0);
    // Sent, but the file would not go (a virus scanner holding it...): never sent again from here.
    readonly HashSet<Guid> _sent = [];
    long _lastTicks;
    int _pending, _failedCount;

    public Outbox(string folder, Action<string>? log = null)
    {
        _folder = folder;
        _failed = Path.Combine(folder, "failed");
        _log = log ?? (_ => { });
        Directory.CreateDirectory(_folder);
        Recover();
        _pending = Files().Count;
        _failedCount = FailedFiles().Count;
    }

    public string Folder => _folder;

    public int Pending => Volatile.Read(ref _pending);

    // Scans in failed\: refused by the server or unreadable.
    public int Failed => Volatile.Read(ref _failedCount);

    // Raised on the thread that added or sent a scan.
    public event EventHandler<int>? PendingChanged;
    public event EventHandler<ScanEvent>? Sent;
    public event EventHandler<OptiCloudException>? SendFailed;
    // Given up on after RefusalsBeforeAside refusals; Failed has already gone up.
    public event EventHandler<ScanEvent>? Refused;

    // On disk before it returns. Throws if the disk can't be written.
    public void Add(ScanEvent e)
    {
        lock (_gate)
        {
            var ticks = Math.Max(DateTime.UtcNow.Ticks, _lastTicks + 1);
            _lastTicks = ticks;
            var path = Path.Combine(_folder, $"{ticks:D19}-{e.ScanId:N}.json");
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, ScanJson.Write(e));
            File.Move(tmp, path, overwrite: true);
        }
        _wake.Release();
        Changed();
    }

    // Waiting now, oldest first. A file that can't be read is left for RunAsync to move aside.
    public IReadOnlyList<ScanEvent> Peek() => [.. Files().Where(f => !IsSent(f)).Select(Read).OfType<ScanEvent>()];

    // Moves everything in failed\ back in line, in its old place (the names keep the order).
    // A scan that did get in is recognised by its ScanId when sent again. Returns how many.
    public int RetryFailed()
    {
        var moved = 0;
        foreach (var path in FailedFiles())
        {
            try
            {
                File.Move(path, Path.Combine(_folder, Path.GetFileName(path)), overwrite: true);
                moved++;
            }
            catch (Exception x) when (x is IOException or UnauthorizedAccessException) { _log($"Outbox: {Path.GetFileName(path)} kunne ikke flyttes tilbage: {x.Message}"); }
        }
        Volatile.Write(ref _failedCount, FailedFiles().Count);
        if (moved > 0)
        {
            _log($"Outbox: {moved} afviste scanninger sendes igen");
            _wake.Release();
            Changed();
        }
        return moved;
    }

    // Sends oldest first until cancelled. A failure waits (2s, 5s, 15s, 30s, then every 60s;
    // 15 minutes after a wrong password) and tries the same scan again, so the order is kept.
    public async Task RunAsync(Func<ScanEvent, CancellationToken, Task> send, CancellationToken ct, Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        delay ??= Task.Delay;
        // Never runs on the caller's thread, even when send and delay finish at once.
        await Task.Yield();
        var failures = 0;
        var stuck = 0;
        (Guid Id, string Why, int Times) refusal = default;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var files = Files();
                var leftover = false;
                foreach (var done in files.Where(IsSent)) leftover |= !TryDelete(done, quiet: true);

                var next = files.FirstOrDefault(f => !IsSent(f));
                if (next is null)
                {
                    // Waiting for a file that won't go must not spin.
                    if (leftover) await delay(Backoff[Math.Min(stuck++, Backoff.Count - 1)], ct);
                    else
                    {
                        stuck = 0;
                        await _wake.WaitAsync(ct);
                    }
                    continue;
                }

                if (Read(next) is not { } e)
                {
                    MoveAside(next, "kunne ikke læses");
                    continue;
                }

                try
                {
                    await send(e, ct);
                }
                catch (OptiCloudException x) when (x.IsRejected)
                {
                    refusal = refusal.Id == e.ScanId && refusal.Why == x.Message ? refusal with { Times = refusal.Times + 1 } : (e.ScanId, x.Message, 1);
                    if (refusal.Times >= RefusalsBeforeAside)
                    {
                        MoveAside(next, x.Message);
                        refusal = default;
                        failures = 0;
                        Refused?.Invoke(this, e);
                        continue;
                    }
                    SendFailed?.Invoke(this, x);
                    await delay(Wait(x, failures++), ct);
                    continue;
                }
                catch (OptiCloudException x)
                {
                    SendFailed?.Invoke(this, x);
                    await delay(Wait(x, failures++), ct);
                    continue;
                }

                failures = 0;
                refusal = default;
                if (!TryDelete(next)) lock (_gate) _sent.Add(e.ScanId);
                Changed();
                Sent?.Invoke(this, e);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception x)
            {
                // Anything else (the disk, a bug in send) must not end sending for good.
                _log($"Outbox: {x.GetType().Name}: {x.Message}");
                try { await delay(Wait(x, failures++), ct); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    List<string> Files()
    {
        try { return [.. Directory.EnumerateFiles(_folder, "*.json").Order(StringComparer.Ordinal)]; }
        catch (DirectoryNotFoundException) { return []; }
    }

    List<string> FailedFiles()
    {
        try { return [.. Directory.EnumerateFiles(_failed, "*.json").Order(StringComparer.Ordinal)]; }
        catch (DirectoryNotFoundException) { return []; }
    }

    bool IsSent(string path)
    {
        if (IdOf(path) is not { } id) return false;
        lock (_gate) return _sent.Contains(id);
    }

    // Names are <ticks>-<ScanId>.json.
    static Guid? IdOf(string path)
    {
        var name = Path.GetFileNameWithoutExtension(path);
        var dash = name.IndexOf('-');
        return dash >= 0 && Guid.TryParseExact(name[(dash + 1)..], "N", out var id) ? id : null;
    }

    static ScanEvent? Read(string path)
    {
        try { return ScanJson.Read(File.ReadAllText(path)); }
        catch (Exception x) when (x is IOException or UnauthorizedAccessException) { return null; }
    }

    // A .tmp left by a crash between write and move is finished if it reads as a scan.
    void Recover()
    {
        foreach (var tmp in Directory.EnumerateFiles(_folder, "*.json.tmp").ToList())
        {
            try
            {
                if (Read(tmp) is not null) File.Move(tmp, tmp[..^4], overwrite: true);
                else File.Delete(tmp);
            }
            catch (IOException x) { _log($"Outbox: {Path.GetFileName(tmp)}: {x.Message}"); }
        }
    }

    // If even this fails, it throws: RunAsync then waits and tries again, the scan stays.
    void MoveAside(string path, string why)
    {
        Directory.CreateDirectory(_failed);
        File.Move(path, Path.Combine(_failed, Path.GetFileName(path)), overwrite: true);
        Volatile.Write(ref _failedCount, FailedFiles().Count);
        _log($"Outbox: {Path.GetFileName(path)} lagt i failed: {why}");
        Changed();
    }

    // Once deleted, a file is gone and need not be remembered as sent. Logged the first time
    // only: a file that won't go is tried again on every round.
    bool TryDelete(string path, bool quiet = false)
    {
        try
        {
            File.Delete(path);
            if (IdOf(path) is { } id) lock (_gate) _sent.Remove(id);
            return true;
        }
        catch (Exception x) when (x is IOException or UnauthorizedAccessException)
        {
            if (!quiet) _log($"Outbox: {Path.GetFileName(path)} kunne ikke slettes: {x.Message}");
            return false;
        }
    }

    void Changed()
    {
        var n = Files().Count(f => !IsSent(f));
        if (Interlocked.Exchange(ref _pending, n) != n) PendingChanged?.Invoke(this, n);
    }
}
