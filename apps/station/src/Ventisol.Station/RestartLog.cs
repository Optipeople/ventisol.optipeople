using System.IO;
using System.Text.Json;

namespace Ventisol.Station;

// When the app last restarted itself because something failed (a window that could not be built,
// three errors in a minute, a fatal error), kept in a small file so the count outlives the process.
// It is what stops a restart loop: the more restarts in the last hour, the longer the next start
// waits before it builds its window, up to ten minutes. From the third on, the saved layout is set
// aside as well (the caller does that). A restart someone asked for is never noted here.
sealed class RestartLog(string folder, Action<string> log)
{
    // From this many restarts in the hour, the saved layout is set aside.
    public const int SetLayoutAsideAt = 3;

    static readonly TimeSpan Window = TimeSpan.FromHours(1);
    const int Keep = 20;

    readonly string _file = Path.Combine(folder, "restarts.json");

    // How long the start after the given number of restarts in the hour waits.
    public static TimeSpan DelayFor(int count) => count switch
    {
        <= 1 => TimeSpan.Zero,
        2 => TimeSpan.FromSeconds(10),
        3 => TimeSpan.FromSeconds(30),
        4 => TimeSpan.FromMinutes(2),
        5 => TimeSpan.FromMinutes(5),
        _ => TimeSpan.FromMinutes(10),
    };

    // Notes a restart now. Returns how many there have been in the last hour, this one included.
    public int Record(DateTimeOffset now)
    {
        var recent = Recent(now);
        recent.Add(now);
        if (recent.Count > Keep) recent.RemoveRange(0, recent.Count - Keep);
        AtomicFile.TryWrite(_file, JsonSerializer.Serialize(recent), log);
        return recent.Count;
    }

    public int Count(DateTimeOffset now) => Recent(now).Count;

    // What is left of the wait for an app that starts now. Zero when it can start at once.
    public TimeSpan WaitBeforeStart(DateTimeOffset now)
    {
        var recent = Recent(now);
        if (recent.Count == 0) return TimeSpan.Zero;
        var left = DelayFor(recent.Count) - (now - recent[^1]);
        return left > TimeSpan.Zero ? left : TimeSpan.Zero;
    }

    // The restarts in the last hour, oldest first. A time in the future (the clock was set back) is dropped.
    List<DateTimeOffset> Recent(DateTimeOffset now)
    {
        try
        {
            if (AtomicFile.TryRead(_file, log) is not { } text) return [];
            var all = JsonSerializer.Deserialize<List<DateTimeOffset>>(text) ?? [];
            return [.. all.Where(t => t <= now && t > now - Window).Order()];
        }
        catch (Exception e)
        {
            log($"restarts.json could not be read: {e.Message}");
            return [];
        }
    }
}
