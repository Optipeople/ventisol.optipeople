using System.Diagnostics.CodeAnalysis;
using System.Globalization;

namespace Ventisol.Station.Core.Cloud;

// Mark: a row that carries no time and never pairs; its Event says what it is (docs/plan-scan-commands.md §6.1).
public enum ScanDirection { In, Out, Mark }

// One scan-in or scan-out, as one row in the VentisolScans table (docs/opticloud-scans.md).
// ScanId is made here, so sending the same scan twice is harmless.
public sealed record ScanEvent(
    Guid ScanId,
    Barcode Barcode,
    int StationNo,
    string Station,
    StationKind StationKind,
    Guid? MachineId,
    ScanDirection Direction,
    DateTimeOffset At,
    int? DurationSec,
    string Device,
    ScanEventKind Event = ScanEventKind.Scan)
{
    // The columns of the table, in the order of the doc.
    public static IReadOnlyList<ColumnSpec> Columns { get; } =
    [
        new("ScanId", "Scan-id", ColumnType.String, IsUnique: true, IsKey: true),
        new("Barcode", "Stregkode", ColumnType.String),
        new("OrderNo", "Ordrenr.", ColumnType.Int),
        new("Position", "Position", ColumnType.Int),
        new("SubPosition", "Underposition", ColumnType.Int),
        new("Piece", "Stk.", ColumnType.Int),
        new("Station", "Station", ColumnType.String),
        new("StationNo", "Stationsnr.", ColumnType.Int),
        new("StationKind", "Stationstype", ColumnType.String),
        new("MachineId", "Maskine-id", ColumnType.String),
        new("Direction", "Retning", ColumnType.String),
        new("ScanTime", "Scannet", ColumnType.DateTime),
        new("DurationSec", "Varighed (sek.)", ColumnType.Int),
        new("Device", "PC", ColumnType.String),
        new("Event", "Hændelse", ColumnType.String),
    ];

    // What a station's scan becomes. Null for a rejected scan: those are only shown, never stored.
    // A Mark carries no time, so no DurationSec.
    public static ScanEvent? From(ScanResult r, Guid? machineId, string? device = null) => r.Kind switch
    {
        ScanKind.In => new(Guid.NewGuid(), r.Barcode, r.Station.Number, r.Station.Name, r.Station.Kind, machineId, ScanDirection.In, r.At, null, device ?? Environment.MachineName, r.Event),
        ScanKind.Out => new(Guid.NewGuid(), r.Barcode, r.Station.Number, r.Station.Name, r.Station.Kind, machineId, ScanDirection.Out, r.At,
            r.Duration is { } d ? (int)Math.Round(d.TotalSeconds) : null, device ?? Environment.MachineName, r.Event),
        ScanKind.Mark => new(Guid.NewGuid(), r.Barcode, r.Station.Number, r.Station.Name, r.Station.Kind, machineId, ScanDirection.Mark, r.At, null, device ?? Environment.MachineName, r.Event),
        _ => null,
    };

    // The row's values. An empty DurationSec is left out rather than sent as null, and so is Event
    // when it is Scan: an ordinary scan's row stays exactly as it was before the column.
    public Dictionary<string, object?> ToValues()
    {
        var v = new Dictionary<string, object?>
        {
            ["ScanId"] = ScanId.ToString(),
            ["Barcode"] = Barcode.Raw,
            ["OrderNo"] = Barcode.Order,
            ["Position"] = Barcode.Position,
            ["SubPosition"] = Barcode.SubPosition,
            ["Piece"] = Barcode.Piece,
            ["Station"] = Station,
            ["StationNo"] = StationNo,
            ["StationKind"] = StationKind.ToString(),
            ["MachineId"] = MachineId?.ToString() ?? "",
            ["Direction"] = Direction.ToString(),
            ["ScanTime"] = At.UtcDateTime.ToString("o", CultureInfo.InvariantCulture),
            ["Device"] = Device,
        };
        if (DurationSec is { } d) v["DurationSec"] = d;
        if (Event != ScanEventKind.Scan) v["Event"] = Event.ToString();
        return v;
    }

    // A row back. False when it isn't a scan we can use (no id, no barcode, no time...).
    // A time without an offset is UTC. OrderNo and the other parts come from the barcode.
    public static bool TryFromValues(IReadOnlyDictionary<string, string?> values, [NotNullWhen(true)] out ScanEvent? scan)
    {
        scan = null;
        var v = new Dictionary<string, string?>(values, StringComparer.OrdinalIgnoreCase);
        string? Get(string name) => v.TryGetValue(name, out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;

        if (!Guid.TryParse(Get("ScanId"), out var id)) return false;
        if (!Barcode.TryParse(Get("Barcode"), out var barcode)) return false;
        if (JsonRead.ToInt(Get("StationNo")) is not { } no) return false;
        if (ParseName<ScanDirection>(Get("Direction")) is not { } direction) return false;
        if (!TryParseTime(Get("ScanTime"), out var at)) return false;

        var kind = Enum.TryParse<StationKind>(Get("StationKind"), ignoreCase: true, out var k) && Enum.IsDefined(k) ? k : StationKind.Assembly;
        Guid? machine = Guid.TryParse(Get("MachineId"), out var m) && m != Guid.Empty ? m : null;
        scan = new ScanEvent(id, barcode, no, Get("Station") ?? $"Station {no}", kind, machine, direction, at,
            JsonRead.ToInt(Get("DurationSec")), Get("Device") ?? "", ReadEvent(Get("Event")));
        return true;
    }

    // An Event text: empty (an old row, or an ordinary scan) and unknown (a newer app's value) read as Scan.
    public static ScanEventKind ReadEvent(string? text) => ParseName<ScanEventKind>(text) ?? ScanEventKind.Scan;

    // The Event text of a row when it is there but not a value this app knows, else null. For the log.
    public static string? UnknownEvent(IReadOnlyDictionary<string, string?> values)
    {
        var text = values.FirstOrDefault(p => p.Key.Equals("Event", StringComparison.OrdinalIgnoreCase)).Value?.Trim();
        return string.IsNullOrEmpty(text) || ParseName<ScanEventKind>(text) is not null ? null : text;
    }

    // An enum value by its name, any case. Not by number: "2" is not a name.
    static T? ParseName<T>(string? text) where T : struct, Enum =>
        text is { Length: > 0 } && char.IsLetter(text[0]) && Enum.TryParse<T>(text.Trim(), ignoreCase: true, out var value) && Enum.IsDefined(value) ? value : null;

    public static bool TryParseTime(string? text, out DateTimeOffset at) =>
        DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out at);
}
