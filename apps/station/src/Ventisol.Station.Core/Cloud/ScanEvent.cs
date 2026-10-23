using System.Diagnostics.CodeAnalysis;
using System.Globalization;

namespace Ventisol.Station.Core.Cloud;

public enum ScanDirection { In, Out }

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
    string Device)
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
    ];

    // What a station's scan becomes. Null for a rejected scan: those are only shown, never stored.
    public static ScanEvent? From(ScanResult r, Guid? machineId, string? device = null) => r.Kind switch
    {
        ScanKind.In => new(Guid.NewGuid(), r.Barcode, r.Station.Number, r.Station.Name, r.Station.Kind, machineId, ScanDirection.In, r.At, null, device ?? Environment.MachineName),
        ScanKind.Out => new(Guid.NewGuid(), r.Barcode, r.Station.Number, r.Station.Name, r.Station.Kind, machineId, ScanDirection.Out, r.At,
            r.Duration is { } d ? (int)Math.Round(d.TotalSeconds) : null, device ?? Environment.MachineName),
        _ => null,
    };

    // The row's values. An empty DurationSec is left out rather than sent as null.
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
        if (!Enum.TryParse<ScanDirection>(Get("Direction"), ignoreCase: true, out var direction) || !Enum.IsDefined(direction)) return false;
        if (!TryParseTime(Get("ScanTime"), out var at)) return false;

        var kind = Enum.TryParse<StationKind>(Get("StationKind"), ignoreCase: true, out var k) && Enum.IsDefined(k) ? k : StationKind.Assembly;
        Guid? machine = Guid.TryParse(Get("MachineId"), out var m) && m != Guid.Empty ? m : null;
        scan = new ScanEvent(id, barcode, no, Get("Station") ?? $"Station {no}", kind, machine, direction, at,
            JsonRead.ToInt(Get("DurationSec")), Get("Device") ?? "");
        return true;
    }

    public static bool TryParseTime(string? text, out DateTimeOffset at) =>
        DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out at);
}
