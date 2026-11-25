using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Ventisol.Station.Core;

// Stop at shift end (docs/plan-shift-end.md §4, §6.2). Pure: no clock, no I/O. Nothing calls it on
// the floor yet; the tick in MainWindow will (plan step 7).

// One weekly shift on the wall clock: Day at Start to End. End at or before Start runs over midnight
// into the next day (a night shift, 22:00 to 06:00).
public sealed record ShiftBlock(DayOfWeek Day, TimeOnly Start, TimeOnly End)
{
    public bool OverMidnight => End <= Start;
}

// A machine's shifts, or the standard shift of Opsætning, as weekly wall-clock blocks, turned into
// real spans per date. SkipDates: dates on which no shift starts (a holiday, a skipped shift).
public sealed record ShiftSchedule(IReadOnlyList<ShiftBlock> Blocks, IReadOnlyList<DateOnly> SkipDates)
{
    // From(IReadOnlyList<MachineShiftRow> rows) goes here: OptiCloud's weekly rows
    // (ExternalGetMachineShiftByMachineId, plan §3.1, §6.1), glued rows over midnight as one block,
    // deleted rows dropped, skipMachineShifts as SkipDates. It waits for a saved real answer
    // (plan step 1), so it is built on a known shape.

    static readonly DayOfWeek[] Weekdays = [DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday];

    // The standard shift: the same times Monday to Friday. End before start is a night shift over midnight.
    public static ShiftSchedule Standard(TimeOnly start, TimeOnly end) =>
        new([.. Weekdays.Select(d => new ShiftBlock(d, start, end))], []);

    // How far before and after the range blocks are looked at, so a span's ends are its own and not
    // cut by the range: shifts joined in a chain, a weekend before the next start.
    static readonly TimeSpan Margin = TimeSpan.FromDays(8);

    // The working spans that overlap [from, to], oldest first. Shifts that touch, overlap or lie less than
    // ShiftEndRule.JoinGap apart are one span. Times are wall clock per date in zone, so a shift is as
    // long as its clock says on either side of a clock change; a time that does not exist (spring) is
    // the next real instant, one that exists twice (autumn) the later.
    public IReadOnlyList<(DateTimeOffset Start, DateTimeOffset End)> Spans(DateTimeOffset from, DateTimeOffset to, TimeZoneInfo zone)
    {
        var first = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(from - Margin, zone).DateTime);
        var last = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(to + Margin, zone).DateTime);
        var skip = SkipDates.ToHashSet();

        var shifts = new List<(DateTimeOffset Start, DateTimeOffset End)>();
        for (var date = first; date <= last; date = date.AddDays(1))
        {
            if (skip.Contains(date)) continue;
            foreach (var b in Blocks.Where(b => b.Day == date.DayOfWeek))
            {
                var start = Instant(date, b.Start, zone);
                var end = Instant(b.OverMidnight ? date.AddDays(1) : date, b.End, zone);
                if (end > start) shifts.Add((start, end));
            }
        }

        var spans = new List<(DateTimeOffset Start, DateTimeOffset End)>();
        foreach (var s in shifts.OrderBy(s => s.Start))
        {
            if (spans.Count > 0 && s.Start - spans[^1].End < ShiftEndRule.JoinGap)
            {
                if (s.End > spans[^1].End) spans[^1] = (spans[^1].Start, s.End);
                continue;
            }
            spans.Add(s);
        }
        return [.. spans.Where(s => s.End > from && s.Start < to)];
    }

    // A wall-clock time on a date as a real instant in zone.
    public static DateTimeOffset Instant(DateOnly date, TimeOnly time, TimeZoneInfo zone)
    {
        var local = date.ToDateTime(time, DateTimeKind.Unspecified);
        // In the spring gap: the first minute after it.
        for (var i = 0; i < 24 * 60 && zone.IsInvalidTime(local); i++) local = local.AddMinutes(1);
        // Twice in autumn: the later instant, the one with the smaller offset.
        var offset = zone.IsAmbiguousTime(local) ? zone.GetAmbiguousTimeOffsets(local).Min() : zone.GetUtcOffset(local);
        return new DateTimeOffset(local, offset);
    }
}

// A station's stop: StopAt (x) is the time its rows get, DueAt (x + grace) when it is written,
// ShiftEnd the end of the span it follows (for the texts). DueAt <= now means write it.
public sealed record ShiftEndDue(int Station, DateTimeOffset StopAt, DateTimeOffset DueAt, DateTimeOffset ShiftEnd);

public static class ShiftEndRule
{
    // Shifts less than this apart are one span: a break set up as two shifts stops nothing.
    public static readonly TimeSpan JoinGap = TimeSpan.FromHours(2);

    // A real Out at most this long after a ShiftEnd Out of the same element wins (plan §4.6).
    public static readonly TimeSpan LateOutWins = TimeSpan.FromHours(12);

    // For one station with elements in progress (or paused) since earliestRunningSince: null while
    // nothing would stop them (inside a span, or the next span starts first, or grace is 0); else
    // when they stop (StopAt = x) and when that is due (x + grace).
    // Off shift [E, N): x is the later of E, the elements' start and the last activity that follows
    // within grace; with no activity for grace after x, and x + grace before N, the station stops at x.
    // The off-shift periods since the elements' start are walked in order (a catch-up after the PC was
    // off), and the first that stops them is the answer; its DueAt may be in the past then, or in the
    // future during the grace period (the countdown). Activity after now is not known and not used.
    // activity: the station's rows (not ShiftEnd ones), scans heard, cards, tile stops, taps; any order.
    public static ShiftEndDue? Evaluate(int station, ShiftSchedule schedule, IReadOnlyList<DateTimeOffset> activity,
        DateTimeOffset earliestRunningSince, TimeSpan grace, DateTimeOffset now, TimeZoneInfo zone)
    {
        if (grace <= TimeSpan.Zero || earliestRunningSince > now) return null;
        // Spans until a day after the stop could be due, so the next start (N) is known when it matters.
        var spans = schedule.Spans(earliestRunningSince - TimeSpan.FromDays(1), now + grace + TimeSpan.FromDays(1), zone);
        var seen = activity.Where(a => a <= now).Order().ToList();

        for (var i = 0; i < spans.Count; i++)
        {
            var end = spans[i].End;
            if (end > now) break;
            var next = i + 1 < spans.Count ? spans[i + 1].Start : DateTimeOffset.MaxValue;
            if (next <= earliestRunningSince) continue;

            var x = end > earliestRunningSince ? end : earliestRunningSince;
            foreach (var a in seen)
            {
                if (a <= x) continue;
                if (a >= next || a - x >= grace) break;
                x = a;
            }
            var due = x + grace;
            if (due < next) return new ShiftEndDue(station, x, due, end);
        }
        return null;
    }

    // The ScanId of the ShiftEnd Out of the element whose In had inScanId: a name-based UUID (v5), so
    // a second write of the same stop (a restart, a second PC) is the same row and refused as a duplicate.
    public static Guid StopId(Guid inScanId) => Uuid5($"{inScanId:D}/ShiftEnd");

    // For an element from an old journal line, whose In's ScanId is not known: from barcode, station and In time.
    public static Guid StopId(Barcode barcode, int station, DateTimeOffset inAt) =>
        Uuid5($"{barcode.Raw}/{station}/{inAt.UtcDateTime:yyyy-MM-ddTHH:mm:ss.fffZ}/ShiftEnd");

    public static Guid StopId(ActiveElement element, int station) =>
        element.InScanId is { } id ? StopId(id) : StopId(element.Barcode, station, element.Since);

    // Fixed for good: changing it changes every derived id.
    static readonly Guid Namespace = new("6f1c3a52-8d4e-4b7a-9c2e-5a0d7e31b9f4");

    // RFC 9562 version 5: SHA-1 of the namespace (big-endian) and the name in UTF-8.
    static Guid Uuid5(string name)
    {
        var ns = Namespace.ToByteArray(bigEndian: true);
        var text = Encoding.UTF8.GetBytes(name);
        var hash = SHA1.HashData([.. ns, .. text]);
        var bytes = hash.AsSpan(0, 16).ToArray();
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x50);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        return new Guid(bytes, bigEndian: true);
    }
}

// What only this PC knows of a station's activity (a refused or unreadable scan, a card, a tap on
// "Arbejder videre"), kept so a restart in the grace period keeps it. Rows are activity too but
// come from the journal and OptiCloud. The app keeps it in shift-end.json in its data folder
// (written by the app, as its other files); here only the content and its JSON. Kept for the
// window of 36 hours.
public sealed class ShiftEndActivity
{
    readonly Dictionary<int, List<DateTimeOffset>> _byStation = [];

    public void Note(int station, DateTimeOffset at)
    {
        if (!_byStation.TryGetValue(station, out var list)) _byStation[station] = list = [];
        list.Add(at);
    }

    public IReadOnlyList<DateTimeOffset> For(int station) =>
        _byStation.TryGetValue(station, out var list) ? [.. list.Order()] : [];

    // Drops what is older than the window before now. True when anything was dropped.
    public bool Prune(DateTimeOffset now)
    {
        var start = Cloud.CloudSync.WindowStart(now);
        var dropped = 0;
        foreach (var (station, list) in _byStation.ToList())
        {
            dropped += list.RemoveAll(a => a < start);
            if (list.Count == 0) _byStation.Remove(station);
        }
        return dropped > 0;
    }

    sealed record FileStation(int Station, List<DateTimeOffset> Activity);

    public string ToJson() => JsonSerializer.Serialize(
        _byStation.OrderBy(p => p.Key).Select(p => new FileStation(p.Key, [.. p.Value.Order()])).ToList());

    // A file that can't be read is empty: it only ever holds extra activity.
    public static ShiftEndActivity FromJson(string? json)
    {
        var a = new ShiftEndActivity();
        if (string.IsNullOrWhiteSpace(json)) return a;
        try
        {
            foreach (var s in JsonSerializer.Deserialize<List<FileStation>>(json) ?? [])
                foreach (var at in s?.Activity ?? []) a.Note(s!.Station, at);
        }
        catch (JsonException) { return new ShiftEndActivity(); }
        return a;
    }
}
