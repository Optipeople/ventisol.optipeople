namespace Ventisol.Station.Core.Cloud;

// What the screen shows, rebuilt from scans: per station number the element in progress and
// since when, and the finished work, in the order it finished.
public sealed record ReplayResult(IReadOnlyDictionary<int, (Barcode Barcode, DateTimeOffset Since)> InProgress, IReadOnlyList<WorkRecord> Done)
{
    public static ReplayResult Empty { get; } = new(new Dictionary<int, (Barcode, DateTimeOffset)>(), []);
}

// The scans CloudSync has, raw, from Since (the start of the window read) on. The app adds the
// scans it recorded itself and replays them on its own thread, so none of its scans is undone.
// FromCloud: read from OptiCloud, not only this PC's journal and outbox.
public sealed record LoadedScans(IReadOnlyList<ScanEvent> Events, DateTimeOffset Since, bool FromCloud = false);

// The rules are in docs/opticloud-scans.md (Rules), shared with the reports site and checked
// against the same vectors (docs/scan-rules-vectors.json).
public static class ScanReplay
{
    // Pairs by station number and barcode, oldest first, In before Out at the same time.
    // - In then Out: one WorkRecord. Scanning it in again later (rework) makes another.
    // - A second In while one is open: the earlier never got its Out (a missed scan), the later wins.
    // - An Out with no In: its In is older than the scans given, so the start is put back from
    //   DurationSec; without one it can't be timed and is skipped.
    // - In progress at a station: its latest In with no Out, over all the scans given, so an
    //   element scanned in before midnight is still there in the morning.
    // - Done: with today, only records that end at or after today (one spanning midnight counts
    //   for the day it ends); without, all.
    // Each ScanId counts once. Stations come from the settings by number, so records compare
    // equal to the screen's; a station number the settings don't know is built from the scan.
    public static ReplayResult Replay(IEnumerable<ScanEvent> events, IEnumerable<StationConfig> stations, DateTimeOffset? today = null)
    {
        var known = stations.GroupBy(s => s.Number).ToDictionary(g => g.Key, g => g.First());
        var open = new Dictionary<(int Station, string Barcode), ScanEvent>();
        var done = new List<WorkRecord>();

        foreach (var e in events.DistinctBy(e => e.ScanId).OrderBy(e => e.At).ThenBy(e => e.Direction))
        {
            var key = (e.StationNo, e.Barcode.Raw);
            if (e.Direction == ScanDirection.In)
            {
                open[key] = e;
                continue;
            }

            DateTimeOffset start;
            if (open.Remove(key, out var opening)) start = opening.At;
            else if (e.DurationSec is { } seconds) start = e.At - TimeSpan.FromSeconds(Math.Max(0, seconds));
            else continue;

            if (today is { } t && e.At < t) continue;
            var station = known.GetValueOrDefault(e.StationNo) ?? new StationConfig(e.StationNo, e.Station, e.StationKind);
            done.Add(new WorkRecord(station, e.Barcode, start, e.At));
        }

        var inProgress = open.Values.GroupBy(e => e.StationNo)
            .Select(g => g.MaxBy(e => e.At)!)
            .ToDictionary(e => e.StationNo, e => (e.Barcode, e.At));
        return new ReplayResult(inProgress, done);
    }
}
