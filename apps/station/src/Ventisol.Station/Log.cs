using System.IO;

namespace Ventisol.Station;

// A plain text log per day in %LOCALAPPDATA%\Ventisol\Station\logs, kept for two weeks.
// For finding out afterwards what happened on the shop floor PC. Never throws.
static class Log
{
    static readonly string Folder = Path.Combine(AppPaths.Data, "logs");
    static readonly Lock Gate = new();
    static bool _pruned;

    public static void Write(string message)
    {
        try
        {
            var now = DateTimeOffset.Now;
            lock (Gate)
            {
                Directory.CreateDirectory(Folder);
                File.AppendAllText(Path.Combine(Folder, $"{now:yyyy-MM-dd}.log"), $"{now:HH:mm:ss.fff}  {message}{Environment.NewLine}");
                if (!_pruned) Prune(now);
            }
        }
        catch { } // A log that can't be written must never stop a scan.
    }

    static void Prune(DateTimeOffset now)
    {
        _pruned = true;
        foreach (var f in Directory.GetFiles(Folder, "*.log"))
            if (File.GetLastWriteTime(f) < now.AddDays(-14).DateTime) File.Delete(f);
    }
}
