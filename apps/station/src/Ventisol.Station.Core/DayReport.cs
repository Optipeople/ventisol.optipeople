namespace Ventisol.Station.Core;

// One element done at one station: scanned in, then out.
public sealed record WorkRecord(StationConfig Station, Barcode Barcode, DateTimeOffset Start, DateTimeOffset End)
{
    public TimeSpan Duration => End - Start;
}

// An order as the scans show it: where it is being worked on now, else the station it was last scanned out at.
// No "packed" or "done" status: without the order's element count from 3E the scans can't tell that, and a guess
// (e.g. "through packing and nothing in progress") shows an order as packed the moment it is closed at a station.
public sealed record OrderLine(int Order, int Elements, TimeSpan Total, IReadOnlyList<string> ActiveAt, DateTimeOffset LastSeen, string? LastStation);

public sealed record Kpis(int Elements, TimeSpan? AverageTime, int StationsBusy, int Stations, int OrdersAtPacking);

public sealed record StationLine(StationConfig Station, int Done, TimeSpan? Average, double Utilization);

// What the operators' report view shows, worked out from the finished work and what runs now.
// Time on an element that is still in progress counts up to now.
public static class DayReport
{
    // Orders seen today, most recent first. Each element in progress counts, also several at one
    // station, each with its own wall-clock time.
    public static IReadOnlyList<OrderLine> Orders(IEnumerable<WorkRecord> done, IEnumerable<StationState> stations, DateTimeOffset now)
    {
        var active = stations.SelectMany(s => s.Active.Select(a => (s.Station, a.Barcode, a.Since))).ToList();
        var finished = done.ToList();

        return finished.Select(r => r.Barcode.Order)
            .Concat(active.Select(a => a.Barcode.Order))
            .Distinct()
            .Select(order =>
            {
                var mine = finished.Where(r => r.Barcode.Order == order).ToList();
                var here = active.Where(a => a.Barcode.Order == order).ToList();
                var total = mine.Aggregate(TimeSpan.Zero, (t, r) => t + r.Duration)
                          + here.Aggregate(TimeSpan.Zero, (t, a) => t + (now - a.Since));
                var lastSeen = here.Count > 0 ? now : mine.Max(r => r.End);
                var last = mine.MaxBy(r => r.End)?.Station.Name;
                return new OrderLine(order, mine.Select(r => r.Barcode.Raw).Distinct().Count(), total,
                    [.. here.Select(a => a.Station.Name).Distinct()], lastSeen, last);
            })
            .OrderByDescending(o => o.LastSeen)
            .ToList();
    }

    // Where an order is, as a short line: the stations working on it now, else the station it was last scanned out at.
    public static string Where(OrderLine o) =>
        o.ActiveAt.Count > 0 ? string.Join(", ", o.ActiveAt) : o.LastStation is { } s ? $"Sidst ved {s}" : "Venter";

    // The day in four numbers: elements worked on, average time per element at a station,
    // stations working now, and orders scanned out at a packing station (a count of scans, not a claim they're packed).
    public static Kpis Totals(IEnumerable<WorkRecord> done, IEnumerable<StationState> stations, DateTimeOffset now)
    {
        var finished = done.ToList();
        var all = stations.ToList();
        var elements = finished.Select(r => r.Barcode.Raw).Concat(all.SelectMany(s => s.Active).Select(a => a.Barcode.Raw)).Distinct().Count();
        TimeSpan? average = finished.Count > 0 ? finished.Aggregate(TimeSpan.Zero, (t, r) => t + r.Duration) / finished.Count : null;
        var atPacking = finished.Where(r => r.Station.Kind == StationKind.Packing).Select(r => r.Barcode.Order).Distinct().Count();
        return new Kpis(elements, average, all.Count(s => s.IsBusy), all.Count, atPacking);
    }

    // Per station: elements done, average time per element, and how much of the day so far
    // it has been working. The day so far starts at the first scan inside today (local midnight of
    // now unless given): an element counts from its scan in, or from its scan out when it was
    // scanned in before today (from now, when it is still in progress). Only the time worked since
    // that first scan counts. So one element left in over night neither stretches the day back to
    // midnight for every station nor gets the night as work. Time with several elements in progress
    // at once (a station with "Max i gang" above 1) counts once: the union of the elements' times,
    // not their sum. The average is of the elements' whole time.
    public static IReadOnlyList<StationLine> Stations(IEnumerable<WorkRecord> done, IEnumerable<StationState> stations, DateTimeOffset now, DateTimeOffset? today = null)
    {
        var finished = done.ToList();
        var all = stations.ToList();
        var midnight = today ?? Cloud.CloudSync.Midnight(now);
        var scans = finished.Select(r => r.Start >= midnight ? r.Start : r.End)
            .Concat(all.SelectMany(s => s.Active).Select(a => a.Since >= midnight ? a.Since : now)).ToList();
        var first = scans.Count > 0 ? Later(scans.Min(), midnight) : now;
        var day = Positive(now - first);

        return all.Select(s =>
        {
            var mine = finished.Where(r => r.Station.Number == s.Station.Number).ToList();
            var busy = Union(mine.Select(r => (Later(r.Start, first), r.End))
                .Concat(s.Active.Select(a => (Later(a.Since, first), now))));
            TimeSpan? average = mine.Count > 0 ? mine.Aggregate(TimeSpan.Zero, (t, r) => t + r.Duration) / mine.Count : null;
            var utilization = day > TimeSpan.Zero ? Math.Clamp(busy / day, 0, 1) : 0;
            return new StationLine(s.Station, mine.Count, average, utilization);
        }).ToList();
    }

    // The time covered by the intervals, overlaps counted once. Empty or reversed ones add nothing.
    static TimeSpan Union(IEnumerable<(DateTimeOffset From, DateTimeOffset To)> intervals)
    {
        var total = TimeSpan.Zero;
        DateTimeOffset? from = null, to = null;
        foreach (var (f, t) in intervals.Where(i => i.To > i.From).OrderBy(i => i.From))
        {
            if (to is { } end && f <= end)
            {
                if (t > end) to = t;
                continue;
            }
            if (from is { } a && to is { } b) total += b - a;
            (from, to) = (f, t);
        }
        if (from is { } x && to is { } y) total += y - x;
        return total;
    }

    static DateTimeOffset Later(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;

    static TimeSpan Positive(TimeSpan t) => t > TimeSpan.Zero ? t : TimeSpan.Zero;
}
