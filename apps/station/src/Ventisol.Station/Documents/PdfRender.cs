using System.IO;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Ventisol.Station.Core.Documents;
using Windows.Data.Pdf;
using Windows.Storage.Streams;
using WinRect = Windows.Foundation.Rect;

namespace Ventisol.Station.Documents;

// Renders order PDFs to bitmaps with Windows' own PDF engine (Windows.Data.Pdf), so the vector
// drawing comes out sharp at the size it is shown, with no PDF viewer on the kiosk PC. Rendering runs
// in the background, one page at a time. The last drawings are kept by file version, page, crop and
// colours, so a drawing pre-rendered at scan-in shows at once when the station is tapped. Whole pages
// ("Vis hele PDF") are not kept here: they go through PdfPages, which holds its own few.
static class PdfRender
{
    // The drawing's longer side in pixels: sharp on a full-height panel of a 1080p or 1440p screen.
    public const int DrawingPixels = 1800;
    // A whole page's width in pixels, for "Vis hele PDF".
    public const int PagePixels = 1600;
    const int MaxCached = 32;
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    // One render at a time in the whole app, drawings and pages alike.
    public static readonly SemaphoreSlim OneAtATime = new(1, 1);
    static readonly object Gate = new();
    // Newest last.
    static readonly List<(string Key, Task<BitmapSource> Task)> Cache = [];

    // The element's drawing, cut out of its page, drawn in ink on the panel colour so it sits in the
    // dark screen like the rest instead of as a white sheet.
    public static Task<BitmapSource> DrawingAsync(OrderDocumentLoad load, OrderPosition position, Color ground, Color ink) =>
        Cached($"{load.FileKey}|d{position.PageIndex}|{position.Drawing}|{ground}|{ink}", load.Pdf!,
            pdf => Render(pdf, position.PageIndex, position.Drawing, DrawingPixels, (ground, ink)));

    static Task<BitmapSource> Cached(string key, byte[] pdf, Func<byte[], Task<BitmapSource>> render)
    {
        lock (Gate)
        {
            var i = Cache.FindIndex(c => c.Key == key);
            if (i >= 0)
            {
                var hit = Cache[i];
                Cache.RemoveAt(i);
                Cache.Add(hit);
                return hit.Task;
            }
            var task = Task.Run(async () =>
            {
                await OneAtATime.WaitAsync().ConfigureAwait(false);
                try { return await render(pdf).WaitAsync(Timeout).ConfigureAwait(false); }
                finally { OneAtATime.Release(); }
            });
            Cache.Add((key, task));
            if (Cache.Count > MaxCached) Cache.RemoveAt(0);
            // A failed render is not kept: opening it again tries again.
            _ = task.ContinueWith(t => { lock (Gate) Cache.RemoveAll(c => c.Task == t); },
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return task;
        }
    }

    // The PDF opened for rendering. The stream must live as long as the document is used.
    public static async Task<(PdfDocument Document, InMemoryRandomAccessStream Stream)> OpenAsync(byte[] pdf)
    {
        var input = new InMemoryRandomAccessStream();
        try
        {
            using (var writer = new DataWriter(input.GetOutputStreamAt(0)))
            {
                writer.WriteBytes(pdf);
                await writer.StoreAsync();
                await writer.FlushAsync();
                writer.DetachStream();
            }
            return (await PdfDocument.LoadFromStreamAsync(input), input);
        }
        catch
        {
            input.Dispose();
            throw;
        }
    }

    static async Task<BitmapSource> Render(byte[] pdf, int pageIndex, PdfBox? crop, int pixels, (Color Ground, Color Ink)? colours)
    {
        var (doc, input) = await OpenAsync(pdf);
        using (input) return await Render(doc, pageIndex, crop, pixels, colours);
    }

    // Renders page pageIndex (0-based), or the part of it in crop, so its longer side (a whole page:
    // its width) is about pixels wide. With colours, white becomes ground and black becomes ink.
    public static async Task<BitmapSource> Render(PdfDocument doc, int pageIndex, PdfBox? crop, int pixels, (Color Ground, Color Ink)? colours)
    {
        if (pageIndex < 0 || pageIndex >= doc.PageCount) throw new ArgumentOutOfRangeException(nameof(pageIndex));

        using var page = doc.GetPage((uint)pageIndex);
        // Windows measures the page in DIPs (1/96 inch), the PDF in points (1/72 inch).
        var size = page.Size;
        var options = new PdfPageRenderOptions();
        double width = size.Width, height = size.Height;
        if (crop is { Width: > 0, Height: > 0 } box)
        {
            var s = size.Width / box.PageWidth;
            var left = Math.Max(0, box.Left * s);
            var top = Math.Max(0, box.TopFromTop * s);
            width = Math.Min(box.Width * s, size.Width - left);
            height = Math.Min(box.Height * s, size.Height - top);
            options.SourceRect = new WinRect(left, top, width, height);
        }
        var scale = (crop is null ? pixels / width : pixels / Math.Max(width, height));
        options.DestinationWidth = (uint)Math.Max(1, Math.Round(width * scale));
        options.DestinationHeight = (uint)Math.Max(1, Math.Round(height * scale));

        using var output = new InMemoryRandomAccessStream();
        await page.RenderToStreamAsync(output, options);
        using var png = output.AsStreamForRead();
        var frame = BitmapDecoder.Create(png, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad).Frames[0];
        BitmapSource result = colours is { } c ? Tint(frame, c.Ground, c.Ink) : frame;
        result.Freeze();
        return result;
    }

    // White to ground, black to ink, the greys in between by their darkness.
    static BitmapSource Tint(BitmapSource source, Color ground, Color ink)
    {
        var bgra = new FormatConvertedBitmap(source, PixelFormats.Bgra32, null, 0);
        int w = bgra.PixelWidth, h = bgra.PixelHeight, stride = w * 4;
        var px = new byte[stride * h];
        bgra.CopyPixels(px, stride, 0);
        for (var i = 0; i < px.Length; i += 4)
        {
            // Transparent counts as paper.
            double a = px[i + 3] / 255.0;
            double light = (0.114 * px[i] + 0.587 * px[i + 1] + 0.299 * px[i + 2]) / 255.0 * a + (1 - a);
            // The drawing's hairlines come out as light greys; lift them so they read at a distance.
            double t = Math.Min(1, (1 - light) * 1.8);
            px[i] = (byte)(ground.B + (ink.B - ground.B) * t);
            px[i + 1] = (byte)(ground.G + (ink.G - ground.G) * t);
            px[i + 2] = (byte)(ground.R + (ink.R - ground.R) * t);
            px[i + 3] = 255;
        }
        return BitmapSource.Create(w, h, 96, 96, PixelFormats.Bgra32, null, px, stride);
    }
}
