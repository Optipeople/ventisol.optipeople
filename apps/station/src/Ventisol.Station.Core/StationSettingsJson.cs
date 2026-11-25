using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ventisol.Station.Core;

// The settings as they are kept in settings.json. The file has its own shape (and a version),
// so the records can change without breaking a PC that was set up with an older app.
// Never holds the password: that is stored apart, encrypted for this Windows user.
public static class StationSettingsJson
{
    const int Version = 1;

    // MaxActive and MarkAfterHours came later: a file without them reads as 1 and 4 (0 is "not given").
    // WorkMode came later too, and is text, not the enum: an enum value this app doesn't know (a newer
    // app wrote it) would make the whole file unreadable. Missing or unknown reads as Enkel.
    sealed record FileStation(int Number, string? Name, StationKind Kind, Guid? MachineId, string? ScannerSerial, int MaxActive = 1,
        string? WorkMode = null);

    // The Vagtslut settings came later still: a file without them reads as on, 60 minutes and no standard
    // shift (0 minutes is "not given"). The standard shift's times are "HH:mm" text; one that can't be read
    // makes it none (logged), never the whole file unreadable.
    sealed record FileShift(string? Start, string? End);

    sealed record FileSettings(int Version, StationMode Mode, string? ApiBaseUrl, Guid? AccountId, string? Username, List<FileStation>? Stations,
        string? DocumentsFolder = null, int MarkAfterHours = StationSettings.DefaultMarkAfterHours,
        bool? ShiftEndOn = null, int ShiftEndGraceMinutes = 0, FileShift? StandardShift = null);

    static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() },
    };

    public static string Serialize(StationSettings s) => JsonSerializer.Serialize(
        new FileSettings(Version, s.Mode, s.ApiBaseUrl, s.AccountId, s.Username,
            [.. s.Stations.Select(t => new FileStation(t.Number, t.Name, t.Kind, t.MachineId, t.ScannerSerial, t.MaxActive, t.WorkMode.ToString()))],
            s.DocumentsFolder, s.MarkAfterHours, s.ShiftEndOn, s.ShiftEndGraceMinutes,
            s.StandardShift is { } shift ? new FileShift(StandardShift.Time(shift.Start), StandardShift.Time(shift.End)) : null),
        Options);

    // Null when the text isn't settings at all; otherwise the settings, made whole (see Normalize).
    // log hears, once per read, of the Arbejdsform values it did not know and read as Enkel.
    public static StationSettings? Deserialize(string json, Action<string>? log = null)
    {
        try
        {
            var f = JsonSerializer.Deserialize<FileSettings>(json, Options);
            if (f is null) return null;
            var unknown = new List<string>();
            StationWorkMode Mode(FileStation t)
            {
                if (ParseWorkMode(t.WorkMode) is { } m) return m;
                if (!string.IsNullOrWhiteSpace(t.WorkMode)) unknown.Add($"station {t.Number}: \"{t.WorkMode}\"");
                return StationWorkMode.Enkel;
            }
            var stations = (f.Stations ?? []).Where(t => t is not null)
                .Select(t => new StationSetup(t.Number, t.Name ?? "", t.Kind, t.MachineId, t.ScannerSerial, t.MaxActive, Mode(t))).ToList();
            if (unknown.Count > 0) log?.Invoke($"settings.json: unknown Arbejdsform read as Enkel ({string.Join(", ", unknown)})");
            StandardShift? standard = null;
            if (f.StandardShift is { } fs && (!string.IsNullOrWhiteSpace(fs.Start) || !string.IsNullOrWhiteSpace(fs.End)))
            {
                if (StandardShift.ParseTime(fs.Start) is { } start && StandardShift.ParseTime(fs.End) is { } end) standard = new(start, end);
                else log?.Invoke($"settings.json: standard shift \"{fs.Start}\" to \"{fs.End}\" could not be read, none is used");
            }
            return Normalize(new StationSettings(
                f.Mode,
                f.ApiBaseUrl ?? "",
                f.AccountId,
                f.Username,
                stations,
                f.DocumentsFolder,
                f.MarkAfterHours,
                f.ShiftEndOn ?? true,
                f.ShiftEndGraceMinutes,
                standard));
        }
        catch (JsonException) { return null; }
        catch (NotSupportedException) { return null; }
    }

    // An Arbejdsform as text: one of the names, any case; anything else (blank, a number, a newer
    // app's value) is null.
    public static StationWorkMode? ParseWorkMode(string? text)
    {
        var t = text?.Trim();
        foreach (var m in Enum.GetValues<StationWorkMode>())
            if (string.Equals(t, m.ToString(), StringComparison.OrdinalIgnoreCase)) return m;
        return null;
    }

    // Always the stations of StationConfig.Defaults, in order, each once: missing ones come back
    // as their default, unknown numbers are dropped, blank names get the default name, and a
    // scanner sits on one station at most (the first). Blank texts become the default or null.
    // "Max i gang" is kept to 1 .. StationConfig.MaxActiveLimit, "Marker efter" to 1 .. 48 hours (0 or
    // less: the default 4). An Arbejdsform outside the enum is Enkel; Pakning stays, though not offered
    // yet, so a newer app's file comes back as it was. "Vent efter vagtslut" is kept to 15 .. 90 minutes
    // (0 or less: the default 60); a standard shift is kept to whole minutes, and one that starts and ends
    // at the same time is none.
    public static StationSettings Normalize(StationSettings s)
    {
        var given = s.Stations.GroupBy(t => t.Number).ToDictionary(g => g.Key, g => g.First());
        var usedScanners = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var stations = new List<StationSetup>();
        foreach (var d in StationConfig.Defaults)
        {
            var t = given.GetValueOrDefault(d.Number) ?? new StationSetup(d.Number, d.Name, d.Kind);
            var name = string.IsNullOrWhiteSpace(t.Name) ? d.Name : t.Name.Trim();
            var scanner = string.IsNullOrWhiteSpace(t.ScannerSerial) ? null : t.ScannerSerial.Trim();
            if (scanner is not null && !usedScanners.Add(scanner)) scanner = null;
            stations.Add(t with
            {
                Name = name,
                ScannerSerial = scanner,
                MachineId = t.MachineId == Guid.Empty ? null : t.MachineId,
                MaxActive = Math.Clamp(t.MaxActive, 1, StationConfig.MaxActiveLimit),
                WorkMode = Enum.IsDefined(t.WorkMode) ? t.WorkMode : StationWorkMode.Enkel,
            });
        }

        var url = string.IsNullOrWhiteSpace(s.ApiBaseUrl) ? StationSettings.DefaultApiBaseUrl : s.ApiBaseUrl.Trim().TrimEnd('/');
        var user = string.IsNullOrWhiteSpace(s.Username) ? null : s.Username.Trim();
        var account = s.AccountId == Guid.Empty ? null : s.AccountId;
        var mark = s.MarkAfterHours <= 0 ? StationSettings.DefaultMarkAfterHours : Math.Min(s.MarkAfterHours, StationSettings.MaxMarkAfterHours);
        var grace = s.ShiftEndGraceMinutes <= 0 ? StationSettings.DefaultShiftEndGraceMinutes
            : Math.Clamp(s.ShiftEndGraceMinutes, StationSettings.MinShiftEndGraceMinutes, StationSettings.MaxShiftEndGraceMinutes);
        return new StationSettings(s.Mode, url, account, user, stations, NormalizeFolder(s.DocumentsFolder), mark,
            s.ShiftEndOn, grace, NormalizeShift(s.StandardShift));
    }

    // Whole minutes; a shift that starts and ends at the same time is none.
    public static StandardShift? NormalizeShift(StandardShift? shift)
    {
        if (shift is null) return null;
        var start = new TimeOnly(shift.Start.Hour, shift.Start.Minute);
        var end = new TimeOnly(shift.End.Hour, shift.End.Minute);
        return start == end ? null : new StandardShift(start, end);
    }

    // A folder path as typed or pasted: trimmed, without quotes around it ("Copy as path" adds them)
    // or a slash at the end, except on a drive root like R:\. Blank is null: the documents are off.
    public static string? NormalizeFolder(string? folder)
    {
        var f = folder?.Trim().Trim('"').Trim();
        if (string.IsNullOrEmpty(f)) return null;
        var trimmed = f.TrimEnd('\\', '/');
        if (trimmed.Length == 0) return f[..1];
        return trimmed.Length == 2 && trimmed[1] == ':' ? trimmed + "\\" : trimmed;
    }
}
