using System.Globalization;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.Core;

// The stop at shift end on the screen (docs/plan-shift-end.md §4.3, §6.5): which schedule a station
// follows, what its tile says, and the check the window's tick runs before it writes a stop.
// Pure, no clock and no files: the window gives it the time, the rows and what this PC noted.

// Where a station's shifts come from.
public static class ShiftSchedules
{
    // Its machine's shifts in OptiPeople when they are known (machineShifts, by machine id; not read
    // yet, plan §3.1 and §6.1: MachineShifts plugs in here), else the standard shift of Opsætning,
    // else none: a station without shifts is never stopped. Null too while "Stop ved vagtslut" is off.
    public static ShiftSchedule? For(StationSettings settings, int station, Func<Guid, ShiftSchedule?>? machineShifts = null)
    {
        if (!settings.ShiftEndOn) return null;
        if (machineShifts is not null
            && settings.Stations.FirstOrDefault(s => s.Number == station)?.MachineId is { } machine
            && machineShifts(machine) is { } fromMachine)
            return fromMachine;
        return settings.StandardShift is { } s ? ShiftSchedule.Standard(s.Start, s.End) : null;
    }

    // This PC hears the station's scans: a scanner is set up for it here (a cradle or the keyboard),
    // or none is set up for any station and it is the first one (a keyboard scanner scans there, as
    // the window routes it). Only such a station is judged and stopped by this PC: one whose scanner
    // is on another PC has taps and refused scans this PC never sees (plan §4.3).
    public static bool ScansHere(StationSettings settings, int station)
    {
        if (settings.Mode != StationMode.Scan) return false;
        if (settings.Stations.FirstOrDefault(s => s.Number == station) is not { } setup) return false;
        if (!string.IsNullOrWhiteSpace(setup.ScannerSerial)) return true;
        return settings.Stations.All(s => string.IsNullOrWhiteSpace(s.ScannerSerial)) && settings.Stations[0].Number == station;
    }

    // "Vent efter vagtslut", kept to 15 to 90 minutes as Opsætning offers it.
    public static TimeSpan Grace(StationSettings settings) => TimeSpan.FromMinutes(Math.Clamp(settings.ShiftEndGraceMinutes,
        StationSettings.MinShiftEndGraceMinutes, StationSettings.MaxShiftEndGraceMinutes));
}

// What a tile shows of the shift end. Grace: the shift has ended and nothing has happened since, the
// countdown runs. Overtime: work went on after the end (or the element began after it), the countdown
// runs from the last activity. Stopped: the station was stopped, the idle line says when.
public enum ShiftEndState { None, Grace, Overtime, Stopped }

// The tile's words (plan §2.1, §2.2). Times on the PC's wall clock.
public static class ShiftEndTexts
{
    public const string Overtime = "Overarbejde";
    public const string Restarted = "Startet igen";
    public const string WorkOn = "Arbejder videre";

    static readonly CultureInfo Danish = CultureInfo.GetCultureInfo("da-DK");

    // The countdown's state: Grace or Overtime while the stop is still to come, else None.
    public static ShiftEndState StateOf(ShiftEndDue? due, DateTimeOffset now) => due switch
    {
        null => ShiftEndState.None,
        _ when due.StopAt > due.ShiftEnd => ShiftEndState.Overtime,
        _ => ShiftEndState.Grace,
    };

    // The band's first line.
    public static string Title(ShiftEndState state, ShiftEndDue due, TimeZoneInfo? zone = null) => state switch
    {
        ShiftEndState.Grace => $"Vagten sluttede {Clock(due.ShiftEnd, zone)}",
        ShiftEndState.Overtime => Overtime,
        ShiftEndState.Stopped => Stopped(due.StopAt, zone),
        _ => "",
    };

    // "Stopper om 42 min, hvis intet sker": whole minutes, rounded up, never below 1.
    public static string Countdown(DateTimeOffset dueAt, DateTimeOffset now)
    {
        var minutes = Math.Max(1, (int)Math.Ceiling((dueAt - now).TotalMinutes));
        return $"Stopper om {minutes} min, hvis intet sker";
    }

    // The flash at the stop and the idle line after it.
    public static string Stopped(DateTimeOffset at, TimeZoneInfo? zone = null) => $"Stoppet ved vagtskifte {Clock(at, zone)}";

    // The flash when an element stopped at a shift end is scanned in again.
    public static string RestartedDetail(DateTimeOffset stoppedAt, DateTimeOffset now, TimeZoneInfo? zone = null) =>
        $"Blev stoppet ved vagtskifte {Day(stoppedAt, now, zone)} {Clock(stoppedAt, zone)} – scan igen for at stoppe";

    static DateTimeOffset Local(DateTimeOffset at, TimeZoneInfo? zone) => TimeZoneInfo.ConvertTime(at, zone ?? TimeZoneInfo.Local);

    public static string Clock(DateTimeOffset at, TimeZoneInfo? zone = null) => Local(at, zone).ToString("HH':'mm", CultureInfo.InvariantCulture);

    // "i dag", "i går", else the weekday ("fredag").
    static string Day(DateTimeOffset at, DateTimeOffset now, TimeZoneInfo? zone)
    {
        var days = (Local(now, zone).Date - Local(at, zone).Date).Days;
        return days switch
        {
            <= 0 => "i dag",
            1 => "i går",
            _ => Local(at, zone).ToString("dddd", Danish),
        };
    }
}

// What the check found for a station.
// Nothing: nothing in progress, no shifts, or no shift end to stop at. Counting: the stop is still to
// come (Due.DueAt after now), the tile counts down. Waiting: due, but the screen has not been rebuilt
// from OptiCloud yet, so nothing is written. EndedElsewhere: due, but the rows show the element ended
// or started again at the station after its In (another PC); nothing is written, the station follows
// the rows. Write: write the stop now, at Due.StopAt.
public enum ShiftEndVerdict { Nothing, Counting, Waiting, EndedElsewhere, Write }

public sealed record ShiftEndCheck(ShiftEndVerdict Verdict, ShiftEndDue? Due = null)
{
    public static ShiftEndCheck None { get; } = new(ShiftEndVerdict.Nothing);
}

// The scan PC's watch over the shift ends: the rows of the last load, whether the screen has been
// rebuilt from OptiCloud, and the activity only this PC knows (shift-end.json, kept by the window).
// cloudSetUp: OptiCloud is set up, so a rebuild from it is waited for; started: when the app started.
public sealed class ShiftEndWatch(bool cloudSetUp, DateTimeOffset started, ShiftEndActivity? local = null)
{
    // Without OptiCloud for this long after the start, the journal alone is taken as the truth (plan §4.3):
    // the station is the only writer.
    public static readonly TimeSpan JournalAlone = TimeSpan.FromMinutes(5);

    IReadOnlyList<ScanEvent> _rows = [];
    bool _loaded, _rebuilt;

    public ShiftEndActivity Local { get; } = local ?? new ShiftEndActivity();

    // The rows of the newest load (OptiCloud's, with the journal and outbox); the check looks in them.
    public IReadOnlyList<ScanEvent> Rows => _rows;

    public bool Rebuilt => _rebuilt;

    // Every load, the first from the journal and those from OptiCloud.
    public void Loaded(LoadedScans loaded)
    {
        _rows = loaded.Events;
        _loaded = true;
        if (loaded.FromCloud) _rebuilt = true;
    }

    // A stop may be written: the screen was rebuilt from OptiCloud, or there is no OptiCloud, or it has
    // not answered for JournalAlone since the start.
    public bool Ready(DateTimeOffset now) => _loaded && (_rebuilt || !cloudSetUp || now - started >= JournalAlone);

    // A station's activity: its rows (not ShiftEnd ones) in the last load and those recorded since, and
    // what this PC noted (scans refused or unreadable, taps on "Arbejder videre").
    public IReadOnlyList<DateTimeOffset> Activity(int station, IEnumerable<ScanEvent> recorded) =>
    [
        .. _rows.Concat(recorded)
            .Where(e => e.StationNo == station && e.Event != ScanEventKind.ShiftEnd)
            .DistinctBy(e => e.ScanId)
            .Select(e => e.At),
        .. Local.For(station),
    ];

    // The check for one station (plan §4.2, §4.3). recorded: the scans this screen recorded since the load.
    public ShiftEndCheck Check(StationState state, ShiftSchedule? schedule, IEnumerable<ScanEvent> recorded, TimeSpan grace,
        DateTimeOffset now, TimeZoneInfo zone)
    {
        if (schedule is null || !state.IsBusy) return ShiftEndCheck.None;
        var station = state.Station.Number;
        var since = state.Active.Min(a => a.Since);
        if (ShiftEndRule.Evaluate(station, schedule, Activity(station, recorded), since, grace, now, zone) is not { } due)
            return ShiftEndCheck.None;
        if (due.DueAt > now) return new(ShiftEndVerdict.Counting, due);
        if (!Ready(now)) return new(ShiftEndVerdict.Waiting, due);
        if (state.Active.Any(a => EndedElsewhere(_rows, station, a))) return new(ShiftEndVerdict.EndedElsewhere, due);
        return new(ShiftEndVerdict.Write, due);
    }

    // Right before writing (plan §4.3): the rows hold an Out of the element at the station at or after
    // its In, or another In after it. Its own In (by ScanId, or at the same time) does not count.
    public static bool EndedElsewhere(IEnumerable<ScanEvent> rows, int station, ActiveElement element) =>
        rows.Any(r => r.StationNo == station && r.Barcode.Raw == element.Barcode.Raw && r.ScanId != element.InScanId
            && (r.Direction == ScanDirection.Out && r.At >= element.Since || r.Direction == ScanDirection.In && r.At > element.Since));
}
