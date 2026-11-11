using System.IO;
using System.Text.Json;
using Ventisol.Station.Core;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

// The blocks' layout, which widgets there are and which stations this screen leaves out, kept on this PC. Moves to the setup in
// OptiCloud later, so every screen can be set up from one place.
static class LayoutStore
{
    // Hidden is missing in layouts saved before stations could be taken off: then every station shows.
    sealed record Saved(List<TilePlace> Tiles, List<WidgetSpec> Widgets, List<string>? Hidden = null);

    static readonly string File = Path.Combine(AppPaths.Data, "layout.json");

    public static (StationLayout Layout, IReadOnlyList<WidgetSpec> Widgets, IReadOnlyList<string> Hidden) Load(IReadOnlyList<string> stationIds)
    {
        try
        {
            var saved = JsonSerializer.Deserialize<Saved>(System.IO.File.ReadAllText(File));
            if (saved is { Tiles: not null, Widgets: not null } &&
                StationLayout.Restore(saved.Tiles, stationIds, saved.Hidden ?? [], saved.Widgets.Select(w => w.Id)) is { } r)
            {
                // A new station on a full screen starts the layout over, and widgets with no room left are dropped.
                var widgets = saved.Widgets.Where(w => r.Layout.Tiles.Any(t => t.Id == w.Id)).ToList();
                if (widgets.Count < saved.Widgets.Count) Log.Write($"Layout: no room for {saved.Widgets.Count - widgets.Count} widget(s), dropped");
                return (r.Layout, widgets, r.Hidden);
            }
        }
        catch { } // None saved yet, an older format, or unreadable: start from the default.
        return (StationLayout.Default(stationIds), [], []);
    }

    public static void Save(StationLayout layout, IEnumerable<WidgetSpec> widgets, IEnumerable<string> hidden)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(File)!);
            System.IO.File.WriteAllText(File, JsonSerializer.Serialize(new Saved([.. layout.Tiles], [.. widgets], [.. hidden])));
        }
        catch { } // The layout still holds until the app restarts.
    }
}
