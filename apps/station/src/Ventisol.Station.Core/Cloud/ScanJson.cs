using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ventisol.Station.Core.Cloud;

// A scan as JSON on the PC (outbox files, journal lines). Not the table row: that is ScanEvent.ToValues.
static class ScanJson
{
    sealed record FileScan(Guid ScanId, string Barcode, int StationNo, string Station, StationKind StationKind, Guid? MachineId,
        ScanDirection Direction, DateTimeOffset At, int? DurationSec, string Device);

    static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Converters = { new JsonStringEnumConverter() },
    };

    public static string Write(ScanEvent e) =>
        JsonSerializer.Serialize(new FileScan(e.ScanId, e.Barcode.Raw, e.StationNo, e.Station, e.StationKind, e.MachineId, e.Direction, e.At, e.DurationSec, e.Device), Options);

    // Null for anything that isn't a whole scan (half written, edited by hand...).
    public static ScanEvent? Read(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<FileScan>(json, Options) is { } f && Barcode.TryParse(f.Barcode, out var b) && f.ScanId != Guid.Empty
                ? new ScanEvent(f.ScanId, b, f.StationNo, f.Station ?? "", f.StationKind, f.MachineId, f.Direction, f.At, f.DurationSec, f.Device ?? "")
                : null;
        }
        catch (Exception x) when (x is JsonException or NotSupportedException or ArgumentException) { return null; }
    }
}
