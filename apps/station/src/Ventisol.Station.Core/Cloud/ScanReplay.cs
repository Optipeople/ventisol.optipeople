namespace Ventisol.Station.Core.Cloud;

// What the screen shows, rebuilt from scans: per station number the elements in progress and
// since when (oldest first, at most the station's "Max i gang"; a station with none is left out),
// and the finished work, in the order it finished.
public sealed record ReplayResult(IReadOnlyDictionary<int, IReadOnlyList<ActiveElement>> InProgress, IReadOnlyList<WorkRecord> Done)
{
    public static ReplayResult Empty { get; } = new(new Dictionary<int, IReadOnlyList<ActiveElement>>(), []);
}

// The scans CloudSync has, raw, from Since (the start of the window read) on. The app adds the
// scans it recorded itself and replays them on its own thread, so none of its scans is undone.
// FromCloud: read from OptiCloud, not only this PC's journal and outbox.
// Refresh: a Scan mode PC reading OptiCloud again after its start, for the widgets and the report.
// The stations on the screen keep their own state then; only what is done today follows OptiCloud.
public sealed record LoadedScans(IReadOnlyList<ScanEvent> Events, DateTimeOffset Since, bool FromCloud = false, bool Refresh = false);

// The rules are in docs/opticloud-scans.md (Rules), shared with the reports site and checked
// against the same vectors (docs/scan-rules-vectors.json).
public static class ScanReplay
{
    // Pairs by station number and barcode, oldest first, In before Out at the same time.
    // - In then Out: one WorkRecord. Scanning it in again later (rework) makes another.
    // - A second In while one is open: the earlier never got its Out (a missed scan), the later wins.
    // - An Out with no In: its In is older than the scans given, so the start is put back from
    //   DurationSec; without one it can't be timed and is skipped.
    // - In progress at a station: its latest Ins with no Out, as many as its "Max i gang" (one at a
    //   station with 1), over all the scans given, so an element scanned in before midnight is still
    //   there in the morning. An older open In beyond that is a missed scan-out.
    // - Done: with today, only records that end at or after today (one spanning midnight counts
    //   for the day it ends); without, all.
    // Each ScanId counts once. Stations come from the settings by number, so records compare
    // equal to the screen's; a station number the settings don't know is built from the scan.
    // "Max i gang" per station number: maxOpen when it has the station, else the station's own
    // (StationConfig.MaxActive), else 1.
    public static ReplayResult Replay(IEnumerable<ScanEvent> events, IEnumerable<StationConfig> stations, DateTimeOffset? today = null,
        IReadOnlyDictionary<int, int>? maxOpen = null)
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

        int Max(int station)
        {
            var max = maxOpen is not null && maxOpen.TryGetValue(station, out var given) ? given : known.GetValueOrDefault(station)?.MaxActive ?? 1;
            return Math.Clamp(max, 1, StationConfig.MaxActiveLimit);
        }
        var inProgress = open.Values.GroupBy(e => e.StationNo).ToDictionary(
            g => g.Key,
            g => (IReadOnlyList<ActiveElement>)[.. g.OrderBy(e => e.At).ThenBy(e => e.Barcode.Raw, StringComparer.Ordinal)
                .TakeLast(Max(g.Key)).Select(e => new ActiveElement(e.Barcode, e.At))]);
        return new ReplayResult(inProgress, done);
    }
}
