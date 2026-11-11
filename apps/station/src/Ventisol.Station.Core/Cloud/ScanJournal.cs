namespace Ventisol.Station.Core.Cloud;

// Every scan this station recorded, one JSON line each, a file per local day (yyyy-MM-dd.jsonl).
// The outbox forgets a scan once it is sent; this keeps it, so a restart shows the day at once,
// before OptiCloud answers or when it can't be reached. Only the last KeepDays days are kept
// (and a day with a scan still waiting in the outbox).
public sealed class ScanJournal(string folder, Action<string>? log = null)
{
    public const int KeepDays = 3;

    readonly Lock _gate = new();

    public string Folder => folder;

    // Throws if the disk can't be written.
    public void Append(ScanEvent e)
    {
        lock (_gate)
        {
            Directory.CreateDirectory(folder);
            var path = PathFor(LocalDate(e.At));
            // A crash mid-line leaves no newline: start a fresh line so only that one scan is lost.
            var broken = File.Exists(path) && !EndsWithNewline(path);
            var bytes = System.Text.Encoding.UTF8.GetBytes((broken ? "\n" : "") + ScanJson.Write(e) + "\n");
            // On the disk before it returns, not only in Windows' cache: a power cut keeps the line.
            using var f = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read, 4096, FileOptions.WriteThrough);
            f.Write(bytes);
            f.Flush(flushToDisk: true);
        }
    }

    // Oldest first. A line that can't be read is skipped.
    public IReadOnlyList<ScanEvent> ReadSince(DateTimeOffset since)
    {
        var found = new List<ScanEvent>();
        lock (_gate)
        {
            foreach (var path in Files())
            {
                try
                {
                    foreach (var line in File.ReadLines(path))
                        if (line.Length > 0 && ScanJson.Read(line) is { } e && e.At >= since) found.Add(e);
                }
                catch (Exception x) when (x is IOException or UnauthorizedAccessException) { log?.Invoke($"Journal: {Path.GetFileName(path)}: {x.Message}"); }
            }
        }
        return [.. found.DistinctBy(e => e.ScanId).OrderBy(e => e.At).ThenBy(e => e.Direction)];
    }

    // The scan with this ScanId, newest day first; null if no day kept has it.
    // Used by the outbox to rebuild a file a power cut left empty.
    public ScanEvent? Find(Guid scanId)
    {
        var key = scanId.ToString();
        lock (_gate)
        {
            foreach (var path in Enumerable.Reverse(Files()))
            {
                try
                {
                    foreach (var line in File.ReadLines(path))
                        if (line.Contains(key, StringComparison.OrdinalIgnoreCase) && ScanJson.Read(line) is { } e && e.ScanId == scanId) return e;
                }
                catch (Exception x) when (x is IOException or UnauthorizedAccessException) { log?.Invoke($"Journal: {Path.GetFileName(path)}: {x.Message}"); }
            }
        }
        return null;
    }

    // Days before the last KeepDays (counting today) go, except a day holding a scan in waiting:
    // the outbox may still need it to rebuild a file (an outage longer than KeepDays).
    public void Prune(DateTimeOffset now, IReadOnlyCollection<Guid>? waiting = null)
    {
        var keepFrom = LocalDate(now).AddDays(1 - KeepDays);
        HashSet<Guid>? keep = waiting is { Count: > 0 } ? [.. waiting] : null;
        lock (_gate)
        {
            foreach (var path in Files())
            {
                if (!DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(path), "yyyy-MM-dd", out var day) || day >= DateOnly.FromDateTime(keepFrom)) continue;
                try
                {
                    if (keep is not null && Holds(path, keep)) continue;
                    File.Delete(path);
                }
                catch (Exception x) when (x is IOException or UnauthorizedAccessException) { log?.Invoke($"Journal: {Path.GetFileName(path)} kunne ikke slettes: {x.Message}"); }
            }
        }
    }

    static bool Holds(string path, HashSet<Guid> ids) =>
        File.ReadLines(path).Any(line => line.Length > 0 && ScanJson.Read(line) is { } e && ids.Contains(e.ScanId));

    string PathFor(DateTime day) => Path.Combine(folder, $"{day:yyyy-MM-dd}.jsonl");

    List<string> Files()
    {
        try { return [.. Directory.EnumerateFiles(folder, "*.jsonl").Order(StringComparer.Ordinal)]; }
        catch (DirectoryNotFoundException) { return []; }
    }

    static DateTime LocalDate(DateTimeOffset at) => TimeZoneInfo.ConvertTime(at, TimeZoneInfo.Local).Date;

    static bool EndsWithNewline(string path)
    {
        using var r = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (r.Length == 0) return true;
        r.Seek(-1, SeekOrigin.End);
        return r.ReadByte() == '\n';
    }
}
