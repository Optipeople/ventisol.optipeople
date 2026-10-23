namespace Ventisol.Station.Core.Cloud;

// Every scan this station recorded, one JSON line each, a file per local day (yyyy-MM-dd.jsonl).
// The outbox forgets a scan once it is sent; this keeps it, so a restart shows the day at once,
// before OptiCloud answers or when it can't be reached. Only the last KeepDays days are kept.
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
            File.AppendAllText(path, (broken ? "\n" : "") + ScanJson.Write(e) + "\n");
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

    // Days before the last KeepDays (counting today) go.
    public void Prune(DateTimeOffset now)
    {
        var keepFrom = LocalDate(now).AddDays(1 - KeepDays);
        lock (_gate)
        {
            foreach (var path in Files())
            {
                if (!DateOnly.TryParseExact(Path.GetFileNameWithoutExtension(path), "yyyy-MM-dd", out var day) || day >= DateOnly.FromDateTime(keepFrom)) continue;
                try { File.Delete(path); }
                catch (Exception x) when (x is IOException or UnauthorizedAccessException) { log?.Invoke($"Journal: {Path.GetFileName(path)} kunne ikke slettes: {x.Message}"); }
            }
        }
    }

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
