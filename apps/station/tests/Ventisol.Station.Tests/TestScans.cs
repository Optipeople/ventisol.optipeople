using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.Tests;

static class TestScans
{
    public static Barcode Code(string raw) => Barcode.TryParse(raw, out var b) ? b : throw new ArgumentException(raw);

    public static ScanEvent Scan(string barcode, int station, ScanDirection direction, DateTimeOffset at, int? duration = null)
    {
        var s = StationConfig.Defaults.FirstOrDefault(c => c.Number == station) ?? new StationConfig(station, $"Station {station}");
        return new ScanEvent(Guid.NewGuid(), Code(barcode), station, s.Name, s.Kind, null, direction, at, duration, "TEST-PC");
    }

    public static ScanEvent In(string barcode, int station, DateTimeOffset at) => Scan(barcode, station, ScanDirection.In, at);

    public static ScanEvent Out(string barcode, int station, DateTimeOffset at) => Scan(barcode, station, ScanDirection.Out, at);

    public static string TempFolder()
    {
        var path = Path.Combine(Path.GetTempPath(), "ventisol-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    public static async Task Until(Func<bool> condition, int timeoutMs = 10000)
    {
        var until = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("Condition never became true");
            await Task.Delay(10);
        }
    }
}
