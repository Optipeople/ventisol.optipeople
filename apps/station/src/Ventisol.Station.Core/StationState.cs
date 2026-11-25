namespace Ventisol.Station.Core;

// Rejected: nothing is stored. Reason says why, for the log (the tile has its own words).
// Mark: a row that carries no time and never pairs (docs/plan-scan-commands.md §6.1).
public enum ScanKind { In, Out, Switched, Rejected, Mark }

// Why a row was written: the Event column of VentisolScans. Scan is an ordinary scan and is left
// out of the row. The values belong to docs/plan-scan-commands.md §6.1; a newer app may add more.
public enum ScanEventKind { Scan, Pause, Resume, Hold, CheckedOut, Undo, ShiftEnd }

public sealed record ScanResult(ScanKind Kind, StationConfig Station, Barcode Barcode, DateTimeOffset At, TimeSpan? Duration = null, string? Reason = null)
{
    // Why the row is written; Scan for an ordinary scan.
    public ScanEventKind Event { get; init; }

    // When switching orders, this holds the previous order that was stopped.
    public Barcode? Previous { get; init; }

    // In: how many elements are in progress at the station now, this one included.
    public int ActiveCount { get; init; }

    // The row's ScanId when it is fixed here: a ShiftEnd Out's id, derived from its In's
    // (ShiftEndRule.StopId). Null: the row gets a new one.
    public Guid? ScanId { get; init; }
}

// One element in progress at a station, and since when. InScanId: the ScanId of its In row, for the
// derived id of a stop at shift end; null until known (an element from an old journal line, or not
// yet noted after a scan). It is not part of what the element is: the same element since the same
// time is equal whether its id is known or not.
public sealed record ActiveElement(Barcode Barcode, DateTimeOffset Since, Guid? InScanId = null)
{
    public TimeSpan Elapsed(DateTimeOffset now) => now - Since;

    public bool Equals(ActiveElement? other) => other is not null && Barcode == other.Barcode && Since == other.Since;

    public override int GetHashCode() => HashCode.Combine(Barcode, Since);
}

// What a station is working on: the elements in progress there, oldest first. The first scan of an
// element starts it, a second scan of the same element ends it. What a different element does while
// one is in progress depends on the station's "Max i gang" (StationConfig.MaxActive):
// - 1: it stops the element in progress and starts the new one (Switched).
// - more: it starts beside the others (In), until MaxActive are in progress; one more is Rejected.
public sealed class StationState(StationConfig station)
{
    public const string FullReason = "max i gang";

    readonly List<ActiveElement> _active = [];

    public StationConfig Station { get; private set; } = station;

    // Its machine is called something else in OptiPeople (StationNames). What is in progress stays.
    public void Rename(string name) => Station = Station with { Name = name };

    public int MaxActive => Math.Clamp(Station.MaxActive, 1, StationConfig.MaxActiveLimit);

    // Oldest first. The last is the one scanned in last.
    public IReadOnlyList<ActiveElement> Active => _active;

    // The element scanned in last, and since when: at a station with 1, the one in progress.
    public Barcode? Current => _active.Count > 0 ? _active[^1].Barcode : null;
    public DateTimeOffset? StartedAt => _active.Count > 0 ? _active[^1].Since : null;

    public bool IsBusy => _active.Count > 0;
    public bool IsFull => _active.Count >= MaxActive;

    public ActiveElement? Find(string raw) => _active.FirstOrDefault(a => a.Barcode.Raw == raw);

    public bool Has(string raw) => Find(raw) is not null;

    // How long the element scanned in last has been in progress.
    public TimeSpan Elapsed(DateTimeOffset now) => StartedAt is { } t ? now - t : TimeSpan.Zero;

    public ScanResult Scan(Barcode barcode, DateTimeOffset now)
    {
        // An element in progress here: this scan ends it, whatever else is in progress.
        if (Find(barcode.Raw) is { } running)
        {
            _active.Remove(running);
            return new ScanResult(ScanKind.Out, Station, barcode, now, now - running.Since);
        }

        // One at a time: stop the element in progress, start the new one.
        if (MaxActive == 1 && _active.Count > 0)
        {
            var previous = _active[0];
            _active.Clear();
            Add(new ActiveElement(barcode, now));
            return new ScanResult(ScanKind.Switched, Station, barcode, now, now - previous.Since) { Previous = previous.Barcode, ActiveCount = 1 };
        }

        if (IsFull)
            return new ScanResult(ScanKind.Rejected, Station, barcode, now, Reason: FullReason) { ActiveCount = _active.Count };

        Add(new ActiveElement(barcode, now));
        return new ScanResult(ScanKind.In, Station, barcode, now) { ActiveCount = _active.Count };
    }

    // Back to what OptiCloud holds, after a restart or on a viewer: this element in progress since then,
    // and nothing else.
    public void Restore(Barcode barcode, DateTimeOffset startedAt) => Restore([new ActiveElement(barcode, startedAt)]);

    // The same for every element in progress here. More than MaxActive: the latest ones.
    public void Restore(IEnumerable<ActiveElement> active)
    {
        _active.Clear();
        foreach (var a in active.OrderBy(a => a.Since).TakeLast(MaxActive)) Add(a);
    }

    public void Reset() => _active.Clear();

    // The In row of an element in progress here was recorded with this ScanId. False when it is not in progress.
    public bool NoteInScanId(string raw, Guid scanId)
    {
        var i = _active.FindIndex(a => a.Barcode.Raw == raw);
        if (i < 0) return false;
        _active[i] = _active[i] with { InScanId = scanId };
        return true;
    }

    // Every element in progress since at or before at ends at at (an Out each, oldest first), with ev
    // as its Event: the stop at shift end (docs/plan-shift-end.md §4.2), all at the same time. An
    // element scanned in after at is not stopped and stays in progress: an Out before its In is no
    // pass (a catch-up stopping yesterday's element after this morning's In). A ShiftEnd Out gets its
    // derived ScanId (ShiftEndRule.StopId).
    public IReadOnlyList<ScanResult> StopAll(DateTimeOffset at, ScanEventKind ev)
    {
        var stopped = _active.Where(a => a.Since <= at).ToList();
        var results = stopped.Select(a => new ScanResult(ScanKind.Out, Station, a.Barcode, at, at - a.Since)
        {
            Event = ev,
            ScanId = ev == ScanEventKind.ShiftEnd ? ShiftEndRule.StopId(a, Station.Number) : null,
        }).ToList();
        _active.RemoveAll(stopped.Contains);
        return results;
    }

    // In order of Since; one with the same Since goes after, so the last is the one scanned last.
    void Add(ActiveElement a)
    {
        var at = _active.FindLastIndex(x => x.Since <= a.Since) + 1;
        _active.Insert(at, a);
    }
}
