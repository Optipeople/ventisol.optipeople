using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ventisol.Station.Core.Cloud;

// Scans waiting to be sent, one JSON file each in a folder, so a restart or a network outage
// never loses one. Files are named by when they were added, so the name order is the send order.
// A file is written to .tmp and then moved, so a crash never leaves half a scan behind.
// A scan the server refuses outright is moved to failed\ and logged, not retried forever.
public sealed class Outbox
{
    public static IReadOnlyList<TimeSpan> Backoff { get; } =
        [TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60)];

    sealed record FileScan(Guid ScanId, string Barcode, int StationNo, string Station, StationKind StationKind, Guid? MachineId,
        ScanDirection Direction, DateTimeOffset At, int? DurationSec, string Device);

    static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() },
    };

    readonly string _folder, _failed;
    readonly Action<string> _log;
    readonly Lock _gate = new();
    readonly SemaphoreSlim _wake = new(0);
    long _lastTicks;
    int _pending;

    public Outbox(string folder, Action<string>? log = null)
    {
        _folder = folder;
        _failed = Path.Combine(folder, "failed");
        _log = log ?? (_ => { });
        Directory.CreateDirectory(_folder);
        Recover();
        _pending = Files().Count;
    }

    public string Folder => _folder;

    public int Pending => Volatile.Read(ref _pending);

    // Raised on the thread that added or sent a scan.
    public event EventHandler<int>? PendingChanged;
    public event EventHandler<ScanEvent>? Sent;
    public event EventHandler<OptiCloudException>? SendFailed;

    // On disk before it returns. Throws if the disk can't be written.
    public void Add(ScanEvent e)
    {
        lock (_gate)
        {
            var ticks = Math.Max(DateTime.UtcNow.Ticks, _lastTicks + 1);
            _lastTicks = ticks;
            var path = Path.Combine(_folder, $"{ticks:D19}-{e.ScanId:N}.json");
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(ToFile(e), Options));
            File.Move(tmp, path, overwrite: true);
        }
        _wake.Release();
        Changed();
    }

    // Waiting now, oldest first. A file that can't be read is left for RunAsync to move aside.
    public IReadOnlyList<ScanEvent> Peek() => [.. Files().Select(Read).OfType<ScanEvent>()];

    // Sends oldest first until cancelled. A failure waits (2s, 5s, 15s, 30s, then every 60s)
    // and tries the same scan again, so the order is kept.
    public async Task RunAsync(Func<ScanEvent, CancellationToken, Task> send, CancellationToken ct, Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        delay ??= Task.Delay;
        var failures = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var next = Files().FirstOrDefault();
                if (next is null)
                {
                    await _wake.WaitAsync(ct);
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
                    MoveAside(next, x.Message);
                    failures = 0;
                    continue;
                }
                catch (OptiCloudException x)
                {
                    SendFailed?.Invoke(this, x);
                    await delay(Backoff[Math.Min(failures++, Backoff.Count - 1)], ct);
                    continue;
                }

                failures = 0;
                TryDelete(next);
                Changed();
                Sent?.Invoke(this, e);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception x)
            {
                // Anything else (the disk, a bug in send) must not end sending for good.
                _log($"Outbox: {x.GetType().Name}: {x.Message}");
                try { await delay(Backoff[Math.Min(failures++, Backoff.Count - 1)], ct); }
                catch (OperationCanceledException) { break; }
            }
        }
    }

    List<string> Files()
    {
        try { return [.. Directory.EnumerateFiles(_folder, "*.json").Order(StringComparer.Ordinal)]; }
        catch (DirectoryNotFoundException) { return []; }
    }

    ScanEvent? Read(string path)
    {
        try { return JsonSerializer.Deserialize<FileScan>(File.ReadAllText(path), Options) is { } f ? FromFile(f) : null; }
        catch (Exception x) when (x is JsonException or IOException or NotSupportedException or UnauthorizedAccessException) { return null; }
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
        _log($"Outbox: {Path.GetFileName(path)} lagt i failed: {why}");
        Changed();
    }

    void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (IOException x) { _log($"Outbox: {Path.GetFileName(path)} kunne ikke slettes: {x.Message}"); }
    }

    void Changed()
    {
        var n = Files().Count;
        if (Interlocked.Exchange(ref _pending, n) != n) PendingChanged?.Invoke(this, n);
    }

    static FileScan ToFile(ScanEvent e) => new(e.ScanId, e.Barcode.Raw, e.StationNo, e.Station, e.StationKind, e.MachineId, e.Direction, e.At, e.DurationSec, e.Device);

    static ScanEvent? FromFile(FileScan f) => Barcode.TryParse(f.Barcode, out var b) && f.ScanId != Guid.Empty
        ? new ScanEvent(f.ScanId, b, f.StationNo, f.Station ?? "", f.StationKind, f.MachineId, f.Direction, f.At, f.DurationSec, f.Device ?? "")
        : null;
}
