namespace Ventisol.Station.Core.Cloud;

// What the screen shows, rebuilt from scans: per station number the elements in progress and
// since when (oldest first, at most the station's "Max i gang"; a station with none is left out),
// and the finished work, in the order it finished.
// AutoStopped: per station number, its latest stop at shift end in the scans given (the window, not
// only today) and the elements it stopped; a station with none is left out. For the idle line and
// the "Startet igen" text (docs/plan-shift-end.md §6.4).
public sealed record ReplayResult(IReadOnlyDictionary<int, IReadOnlyList<ActiveElement>> InProgress, IReadOnlyList<WorkRecord> Done)
{
    public static ReplayResult Empty { get; } = new(new Dictionary<int, IReadOnlyList<ActiveElement>>(), []);

    public IReadOnlyDictionary<int, AutoStop> AutoStopped { get; init; } = new Dictionary<int, AutoStop>();
}

// A stop at shift end at a station: its time (the ShiftEnd rows' ScanTime) and the elements stopped then.
public sealed record AutoStop(DateTimeOffset At, IReadOnlyList<Barcode> Elements);

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
    // Pairs by station number and barcode, oldest first, In before Out at the same time. Mark rows are skipped.
    // - In then Out: one WorkRecord. Scanning it in again later (rework) makes another.
    // - A second In while one is open: the earlier never got its Out (a missed scan), the later wins.
    // - An Out with no In: its In is older than the scans given, so the start is put back from
    //   DurationSec; without one it can't be timed and is skipped.
    // - In progress at a station: its latest Ins with no Out, as many as its "Max i gang" (one at a
    //   station with 1), over all the scans given, so an element scanned in before midnight is still
    //   there in the morning. An older open In beyond that is a missed scan-out.
    // - A record's EndEvent is its Out's Event; a Mark that follows a record ending with Pause (the
    //   element's last row there, no In since) closes that pause and gives it the Mark's Event.
    // - A late Out (docs/plan-shift-end.md §4.6): an Out with no open In, when the last record of that
    //   station and barcode ended with ShiftEnd at most ShiftEndRule.LateOutWins before, ends that
    //   record instead (EndEvent Scan); later than that it is skipped.
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
        var records = new List<WorkRecord>();
        // Per station and barcode, its last record (an index into records), while no In came after it.
        var last = new Dictionary<(int Station, string Barcode), int>();
        // Records that ended with ShiftEnd, when that stop was (the Out's or the Mark's time), and
        // whether an Out ended it (only then can a late Out follow).
        var stops = new Dictionary<int, (DateTimeOffset At, bool ByOut)>();

        foreach (var e in events.DistinctBy(e => e.ScanId).OrderBy(e => e.At).ThenBy(e => e.Direction))
        {
            var key = (e.StationNo, e.Barcode.Raw);
            // A Mark carries no time and never pairs. One that closes a pause gives the record its
            // Event; the rest of the Session rules (docs/plan-scan-commands.md §7.5) come later.
            if (e.Direction == ScanDirection.Mark)
            {
                if (!open.ContainsKey(key) && last.TryGetValue(key, out var paused) && records[paused].EndEvent == ScanEventKind.Pause)
                {
                    records[paused] = records[paused] with { EndEvent = e.Event };
                    if (e.Event == ScanEventKind.ShiftEnd) stops[paused] = (e.At, false);
                }
                continue;
            }
            if (e.Direction == ScanDirection.In)
            {
                open[key] = e;
                last.Remove(key);
                continue;
            }

            DateTimeOffset start;
            if (open.Remove(key, out var opening)) start = opening.At;
            else if (last.TryGetValue(key, out var i) && stops.TryGetValue(i, out var stop) && stop.ByOut)
            {
                // A late Out after a stop at shift end: the real Out wins within LateOutWins, else it is skipped.
                if (e.At - records[i].End <= ShiftEndRule.LateOutWins)
                {
                    records[i] = records[i] with { End = e.At, EndEvent = e.Event };
                    stops.Remove(i);
                }
                continue;
            }
            else if (e.DurationSec is { } seconds) start = e.At - TimeSpan.FromSeconds(Math.Max(0, seconds));
            else continue;

            var station = known.GetValueOrDefault(e.StationNo) ?? new StationConfig(e.StationNo, e.Station, e.StationKind);
            last[key] = records.Count;
            if (e.Event == ScanEventKind.ShiftEnd) stops[records.Count] = (e.At, true);
            records.Add(new WorkRecord(station, e.Barcode, start, e.At, e.Event));
        }

        // In the order they finished; a record a late Out moved finishes at that Out.
        var done = records.Where(r => today is not { } t || r.End >= t).OrderBy(r => r.End).ToList();

        var autoStopped = stops.GroupBy(s => records[s.Key].Station.Number).ToDictionary(
            g => g.Key,
            g =>
            {
                var at = g.Max(s => s.Value.At);
                return new AutoStop(at, [.. g.Where(s => s.Value.At == at).Select(s => records[s.Key].Barcode)]);
            });

        int Max(int station)
        {
            var max = maxOpen is not null && maxOpen.TryGetValue(station, out var given) ? given : known.GetValueOrDefault(station)?.MaxActive ?? 1;
            return Math.Clamp(max, 1, StationConfig.MaxActiveLimit);
        }
        var inProgress = open.Values.GroupBy(e => e.StationNo).ToDictionary(
            g => g.Key,
            g => (IReadOnlyList<ActiveElement>)[.. g.OrderBy(e => e.At).ThenBy(e => e.Barcode.Raw, StringComparer.Ordinal)
                .TakeLast(Max(g.Key)).Select(e => new ActiveElement(e.Barcode, e.At, e.ScanId))]);
        return new ReplayResult(inProgress, done) { AutoStopped = autoStopped };
    }
}
