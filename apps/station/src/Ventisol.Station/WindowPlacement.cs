using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;

namespace Ventisol.Station;

// Remembers where the window was, so it opens there again. Saved on every move and resize,
// not on close: the dev loop kills the app, and a kiosk PC may lose power.
static class WindowPlacement
{
    sealed record Saved(double Left, double Top, double Width, double Height, bool Maximized);

    static readonly string File = Path.Combine(AppPaths.Data, "window.json");

    public static void Track(Window w)
    {
        Restore(w);

        var save = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(400) };
        save.Tick += Ui.SafeTick(() => { save.Stop(); Save(w); });
        void Later(object? s, EventArgs e) { save.Stop(); save.Start(); }
        w.LocationChanged += Later;
        w.SizeChanged += (s, e) => Later(s, e);
        w.StateChanged += Later;
    }

    static void Restore(Window w)
    {
        try
        {
            // Null on a first start: use the defaults.
            if (AtomicFile.TryRead(File, Log.Write) is not { } text || JsonSerializer.Deserialize<Saved>(text) is not { } p) return;

            // Only if it still lands on a screen: monitors get unplugged.
            var screen = new Rect(SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenTop,
                SystemParameters.VirtualScreenWidth, SystemParameters.VirtualScreenHeight);
            if (!screen.IntersectsWith(new Rect(p.Left, p.Top, p.Width, p.Height))) return;

            w.WindowStartupLocation = WindowStartupLocation.Manual;
            (w.Left, w.Top, w.Width, w.Height) = (p.Left, p.Top, p.Width, p.Height);
            if (p.Maximized) w.WindowState = WindowState.Maximized;
        }
        catch (Exception e) { Log.Write($"window.json could not be used, the window opens where Windows puts it: {e.Message}"); }
    }

    static void Save(Window w)
    {
        try
        {
            var r = w.WindowState == WindowState.Normal ? new Rect(w.Left, w.Top, w.Width, w.Height) : w.RestoreBounds;
            AtomicFile.TryWrite(File, JsonSerializer.Serialize(
                new Saved(r.Left, r.Top, r.Width, r.Height, w.WindowState == WindowState.Maximized)), Log.Write);
        }
        catch (Exception e) { Log.Write($"window.json not saved: {e.Message}"); } // Not worth failing the screen over.
    }
}
