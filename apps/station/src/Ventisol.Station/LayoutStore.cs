using System.IO;
using System.Text.Json;
using Ventisol.Station.Core;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

// The blocks' layout and which widgets there are, kept on this PC. Moves to the setup in
// OptiCloud later, so every screen can be set up from one place.
static class LayoutStore
{
    sealed record Saved(List<TilePlace> Tiles, List<WidgetSpec> Widgets);

    static readonly string File = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Ventisol", "Station", "layout.json");

    public static (StationLayout Layout, IReadOnlyList<WidgetSpec> Widgets) Load(IReadOnlyList<string> stationIds)
    {
        try
        {
            var saved = JsonSerializer.Deserialize<Saved>(System.IO.File.ReadAllText(File));
            if (saved is { Tiles: not null, Widgets: not null })
            {
                var layout = new StationLayout(saved.Tiles);
                if (layout.IsValidFor([.. stationIds, .. saved.Widgets.Select(w => w.Id)])) return (layout, saved.Widgets);
            }
        }
        catch { } // None saved yet, an older format, or unreadable: start from the default.
        return (StationLayout.Default(stationIds), []);
    }

    public static void Save(StationLayout layout, IEnumerable<WidgetSpec> widgets)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(File)!);
            System.IO.File.WriteAllText(File, JsonSerializer.Serialize(new Saved([.. layout.Tiles], [.. widgets])));
        }
        catch { } // The layout still holds until the app restarts.
    }
}
