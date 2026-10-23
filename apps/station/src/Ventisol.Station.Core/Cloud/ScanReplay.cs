namespace Ventisol.Station.Core.Cloud;

// What the screen shows, rebuilt from scans: per station number the element in progress and
// since when, and the finished work, oldest first.
public sealed record ReplayResult(IReadOnlyDictionary<int, (Barcode Barcode, DateTimeOffset Since)> InProgress, IReadOnlyList<WorkRecord> Done)
{
    public static ReplayResult Empty { get; } = new(new Dictionary<int, (Barcode, DateTimeOffset)>(), []);
}

public static class ScanReplay
{
    // An In and the next Out of the same element at the same station make one WorkRecord;
    // scanning it in again later (rework) makes another. An Out with no In before it is skipped.
    // A station's element in progress is its latest In with no Out after it.
    // Stations come from the settings by number, so records compare equal to the screen's;
    // a station number the settings don't know is built from the scan itself.
    public static ReplayResult Replay(IEnumerable<ScanEvent> events, IEnumerable<StationConfig> stations)
    {
        var known = stations.GroupBy(s => s.Number).ToDictionary(g => g.Key, g => g.First());
        var open = new Dictionary<(int Station, string Barcode), ScanEvent>();
        var done = new List<WorkRecord>();

        foreach (var e in events.DistinctBy(e => e.ScanId).OrderBy(e => e.At).ThenBy(e => e.Direction))
        {
            var key = (e.StationNo, e.Barcode.Raw);
            if (e.Direction == ScanDirection.In)
            {
                open.TryAdd(key, e);
                continue;
            }
            if (!open.Remove(key, out var start)) continue;
            var station = known.GetValueOrDefault(e.StationNo) ?? new StationConfig(e.StationNo, e.Station, e.StationKind);
            done.Add(new WorkRecord(station, e.Barcode, start.At, e.At));
        }

        var inProgress = open.Values.GroupBy(e => e.StationNo)
            .Select(g => g.MaxBy(e => e.At)!)
            .ToDictionary(e => e.StationNo, e => (e.Barcode, e.At));
        return new ReplayResult(inProgress, done);
    }
}
