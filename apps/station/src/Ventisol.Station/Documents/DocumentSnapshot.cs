using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Documents;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station.Documents;

// A developer's look at the document screen without tapping: renders the overlay for one barcode to
// a PNG and exits. Run it with its own data folder, so it never meets the running app:
//   $env:VENTISOL_STATION_DATA = "$env:TEMP\vs-snap"
//   VentisolStation.exe --snapshot-document <folder> <barcode> <out.png> [--pages] [--bs] [--zoom] [--size 1920x1080]
// --pages shows "Vis hele PDF", --bs "Vis BS-tegning" (the order's BS drawings, when it has them),
// --zoom with --bs the drawing after a tap on it (as wide as the screen).
static class DocumentSnapshot
{
    public const string Flag = "--snapshot-document";

    public static async void Run(Application app, string[] args)
    {
        try
        {
            var i = Array.FindIndex(args, a => a.Equals(Flag, StringComparison.OrdinalIgnoreCase));
            var (folder, code, output) = (args[i + 1], args[i + 2], args[i + 3]);
            var pages = args.Contains("--pages", StringComparer.OrdinalIgnoreCase);
            var bs = args.Contains("--bs", StringComparer.OrdinalIgnoreCase);
            var (width, height) = (1600, 900);
            var s = Array.FindIndex(args, a => a.Equals("--size", StringComparison.OrdinalIgnoreCase));
            if (s >= 0 && args[s + 1].Split('x') is [var w, var h]) (width, height) = (int.Parse(w), int.Parse(h));
            if (!Barcode.TryParse(code, out var barcode)) throw new ArgumentException($"Not a barcode: {code}");

            var vm = new OrderDocumentViewModel(new OrderDocuments(new OrderDocumentLocator(folder)));
            var overlay = new DocumentOverlay();
            overlay.Attach(vm, []);
            var window = new Window
            {
                Width = width, Height = height, WindowStyle = WindowStyle.None, ResizeMode = ResizeMode.NoResize,
                ShowInTaskbar = false, ShowActivated = false, Left = -30000, Top = -30000,
                FontFamily = (FontFamily)app.FindResource("Hanken"), UseLayoutRounding = true,
                Content = overlay,
            };
            window.Show();
            overlay.Open(1);
            vm.Show(new DocumentTarget("Station 10", barcode, true, DateTimeOffset.Now.AddMinutes(-12)));

            await Until(() => vm.State != DocumentState.Loading && (vm.Drawing is not null || vm.DrawingNote is "" or "Ingen tegning fundet" or "Tegningen kan ikke vises" || vm.ShowingPages));
            if (pages && !vm.ShowingPages) vm.ShowPdfCommand.Execute(null);
            if (bs) vm.ShowBsDrawingsCommand.Execute(null);
            if (bs && args.Contains("--zoom", StringComparer.OrdinalIgnoreCase))
                foreach (var page in vm.Pages) page.Zoomed = page.FitsScreen;
            // Only the pages on screen and their neighbours are drawn; the start page is the one to wait for.
            if (vm.ShowingPages) await Until(() => vm.Pages.Skip(vm.StartPage).Take(1).All(p => p.Image is not null || p.Failed));
            await Task.Delay(900); // the overlay's slide in, and a layout pass for the pages

            var bitmap = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
            bitmap.Render(overlay);
            var png = new PngBitmapEncoder();
            png.Frames.Add(BitmapFrame.Create(bitmap));
            using (var f = File.Create(output)) png.Save(f);
            Log.Write($"Snapshot of {code} saved to {output} ({vm.State}{(bs ? vm.ShowingBsDrawings ? ", BS drawings" : ", no BS drawings" : "")})");
            window.Close();
        }
        catch (Exception ex) { Log.Write($"Snapshot failed: {ex}"); }
        app.Shutdown();
    }

    static async Task Until(Func<bool> done)
    {
        for (var t = 0; t < 200 && !done(); t++) await Task.Delay(100);
    }
}
