namespace Ventisol.Station.Core;

// Scan: the central PC, where the scanners are and scans are sent to OptiCloud.
// Viewer: any other screen, which only shows what OptiCloud holds.
public enum StationMode { Scan, Viewer }

// One station as set up on the setup screen. MachineId is the station's machine in OptiCloud,
// ScannerSerial the scanner id of the cradle that belongs to it: the USB port it is plugged into
// ("usb:" + location path, see UsbPort), or "keyboard". COM port numbers move, the USB port doesn't.
// Either is null until it has been set up. MaxActive is "Max i gang" (see StationConfig), 1 to
// StationConfig.MaxActiveLimit. WorkMode is its Arbejdsform (see StationWorkMode).
public sealed record StationSetup(int Number, string Name, StationKind Kind, Guid? MachineId = null, string? ScannerSerial = null, int MaxActive = 1,
    StationWorkMode WorkMode = StationWorkMode.Enkel)
{
    public StationConfig Config => new(Number, Name, Kind, MaxActive, WorkMode);
}

// Everything the setup screen sets, kept on this PC. The password is stored encrypted
// for this Windows user, never as plain text (see SettingsStore in the app).
// DocumentsFolder is where 3E puts the order PDFs (on site R:\Indkøb\Shares\Ordre); null leaves
// the order documents off. MarkAfterHours is "Marker efter (timer)": an element in progress longer
// than that is marked on its tile, as one forgotten there would take a share of the station's time.
// ShiftEndOn is "Stop ved vagtslut": the elements still in progress are stopped at the shift's end when
// nothing happens at the station for ShiftEndGraceMinutes ("Vent efter vagtslut", 15 to 90) after it.
// StandardShift is "Standardvagt", Monday to Friday, used where the machine has no shifts in OptiPeople;
// null is none (see docs/plan-shift-end.md §3.3).
public sealed record StationSettings(
    StationMode Mode,
    string ApiBaseUrl,
    Guid? AccountId,
    string? Username,
    IReadOnlyList<StationSetup> Stations,
    string? DocumentsFolder = null,
    int MarkAfterHours = StationSettings.DefaultMarkAfterHours,
    bool ShiftEndOn = true,
    int ShiftEndGraceMinutes = StationSettings.DefaultShiftEndGraceMinutes,
    StandardShift? StandardShift = null)
{
    public const string DefaultApiBaseUrl = "https://api.optipeople.dk";

    public const int DefaultMarkAfterHours = 4;
    public const int MaxMarkAfterHours = 48;

    public const int DefaultShiftEndGraceMinutes = 60;
    public const int MinShiftEndGraceMinutes = 15;
    public const int MaxShiftEndGraceMinutes = 90;

    // Before anyone has used the setup screen: the stations in the proposal, not connected.
    public static StationSettings Default { get; } = new(
        StationMode.Scan,
        DefaultApiBaseUrl,
        AccountId: null,
        Username: null,
        [.. StationConfig.Defaults.Select(s => new StationSetup(s.Number, s.Name, s.Kind))]);

    public bool IsConnected => AccountId is not null && !string.IsNullOrWhiteSpace(Username);
}

// The standard shift of a PC, Monday to Friday. End before Start is a night shift: it ends the next day.
public sealed record StandardShift(TimeOnly Start, TimeOnly End)
{
    // "06:00–14:00", the same in any culture.
    public override string ToString() => $"{Time(Start)}–{Time(End)}";

    // "06:00"
    public static string Time(TimeOnly t) => t.ToString("HH':'mm", System.Globalization.CultureInfo.InvariantCulture);

    // "6:00", "06:00" or "0600" as a time of day; null for anything else (blank too).
    public static TimeOnly? ParseTime(string? text)
    {
        var t = text?.Trim();
        if (string.IsNullOrEmpty(t)) return null;
        string[] formats = ["H':'mm", "HH':'mm", "HHmm", "H'.'mm", "HH'.'mm", "H':'mm':'ss", "HH':'mm':'ss"];
        return TimeOnly.TryParseExact(t, formats, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.None, out var v) ? v : null;
    }
}
