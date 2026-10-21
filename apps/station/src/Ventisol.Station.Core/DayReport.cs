namespace Ventisol.Station.Core;

// One element done at one station: scanned in, then out.
public sealed record WorkRecord(StationConfig Station, Barcode Barcode, DateTimeOffset Start, DateTimeOffset End)
{
    public TimeSpan Duration => End - Start;
}

// Packed: it has been through packing and nothing on it is in progress. The order closes
// at the last packing scan; without the order's element count from 3E, this is the best guess.
public sealed record OrderLine(int Order, int Elements, TimeSpan Total, IReadOnlyList<string> ActiveAt, DateTimeOffset LastSeen, bool Packed);

public sealed record Kpis(int Elements, TimeSpan? AverageTime, int StationsBusy, int Stations, int OrdersPacked);

public sealed record StationLine(StationConfig Station, int Done, TimeSpan? Average, double Utilization);

// What the operators' report view shows, worked out from the finished work and what runs now.
// Time on an element that is still in progress counts up to now.
public static class DayReport
{
    // Orders seen today, most recent first.
    public static IReadOnlyList<OrderLine> Orders(IEnumerable<WorkRecord> done, IEnumerable<StationState> stations, DateTimeOffset now)
    {
        var active = stations.Where(s => s.Current is not null).ToList();
        var finished = done.ToList();

        return finished.Select(r => r.Barcode.Order)
            .Concat(active.Select(s => s.Current!.Order))
            .Distinct()
            .Select(order =>
            {
                var mine = finished.Where(r => r.Barcode.Order == order).ToList();
                var here = active.Where(s => s.Current!.Order == order).ToList();
                var total = mine.Aggregate(TimeSpan.Zero, (t, r) => t + r.Duration)
                          + here.Aggregate(TimeSpan.Zero, (t, s) => t + s.Elapsed(now));
                var lastSeen = here.Count > 0 ? now : mine.Max(r => r.End);
                var packed = here.Count == 0 && mine.Any(r => r.Station.Kind == StationKind.Packing);
                return new OrderLine(order, mine.Select(r => r.Barcode.Raw).Distinct().Count(), total,
                    [.. here.Select(s => s.Station.Name)], lastSeen, packed);
            })
            .OrderByDescending(o => o.LastSeen)
            .ToList();
    }

    // The day in four numbers: elements worked on, average time per element at a station,
    // stations working now, and orders packed.
    public static Kpis Totals(IEnumerable<WorkRecord> done, IEnumerable<StationState> stations, DateTimeOffset now)
    {
        var finished = done.ToList();
        var all = stations.ToList();
        var elements = finished.Select(r => r.Barcode.Raw).Concat(all.Where(s => s.Current is not null).Select(s => s.Current!.Raw)).Distinct().Count();
        TimeSpan? average = finished.Count > 0 ? finished.Aggregate(TimeSpan.Zero, (t, r) => t + r.Duration) / finished.Count : null;
        var packed = Orders(finished, all, now).Count(o => o.Packed);
        return new Kpis(elements, average, all.Count(s => s.IsBusy), all.Count, packed);
    }

    // Per station: elements done, average time per element, and how much of the day so far
    // it has been working. The day starts at the first scan anywhere.
    public static IReadOnlyList<StationLine> Stations(IEnumerable<WorkRecord> done, IEnumerable<StationState> stations, DateTimeOffset now)
    {
        var finished = done.ToList();
        var all = stations.ToList();
        var starts = finished.Select(r => r.Start).Concat(all.Where(s => s.StartedAt is not null).Select(s => s.StartedAt!.Value)).ToList();
        var day = starts.Count > 0 ? now - starts.Min() : TimeSpan.Zero;

        return all.Select(s =>
        {
            var mine = finished.Where(r => r.Station == s.Station).ToList();
            var busy = mine.Aggregate(TimeSpan.Zero, (t, r) => t + r.Duration) + s.Elapsed(now);
            TimeSpan? average = mine.Count > 0 ? mine.Aggregate(TimeSpan.Zero, (t, r) => t + r.Duration) / mine.Count : null;
            var utilization = day > TimeSpan.Zero ? Math.Clamp(busy / day, 0, 1) : 0;
            return new StationLine(s.Station, mine.Count, average, utilization);
        }).ToList();
    }
}
