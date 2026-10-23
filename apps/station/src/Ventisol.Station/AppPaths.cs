using System.IO;

namespace Ventisol.Station;

static class AppPaths
{
    // Settings, layout, outbox and logs. VENTISOL_STATION_DATA points it elsewhere, so a test run
    // (against the fake OptiCloud, say) never touches this PC's real setup.
    public static string Data { get; } =
        Environment.GetEnvironmentVariable("VENTISOL_STATION_DATA") is { Length: > 0 } dir
            ? dir
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Ventisol", "Station");
}
