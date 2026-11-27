using System.Windows.Media.Imaging;
using Ventisol.Station.Core.Documents;
using Windows.Data.Pdf;
using Windows.Storage.Streams;

namespace Ventisol.Station.Documents;

// One order PDF held open while "Vis hele PDF" is on screen: the file is read and parsed once, on
// the first page asked for, and every page after that is drawn from the same open document.
// It keeps the last few pages it drew, apart from the drawings in PdfRender, so scrolling back a page
// is instant and the pages never push a station's drawing out. Dispose it when the pages close.
sealed class PdfPages(byte[] pdf) : IDisposable
{
    // About 7 MB a page at PagePixels wide.
    const int MaxCached = 6;

    // Newest last.
    readonly List<(int Index, BitmapSource Image)> _cache = [];
    // The one open of the file, shared by every page. A render gives up after PdfRender.Timeout and
    // lets the next one in, but the open it began may still be running: the next page waits for that
    // same open, never a second one beside it. Set and read under the _cache lock.
    Task<(PdfDocument Document, InMemoryRandomAccessStream Stream)>? _open;
    volatile bool _disposed;

    // A whole page as printed, black on white, or the part of it in crop (always the same part for
    // a page). One render at a time, shared with the drawings.
    public Task<BitmapSource> PageAsync(int pageIndex, PdfBox? crop = null)
    {
        lock (_cache)
        {
            var i = _cache.FindIndex(c => c.Index == pageIndex);
            if (i >= 0)
            {
                var hit = _cache[i];
                _cache.RemoveAt(i);
                _cache.Add(hit);
                return Task.FromResult(hit.Image);
            }
        }
        return Task.Run(async () =>
        {
            await PdfRender.OneAtATime.WaitAsync().ConfigureAwait(false);
            try
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                var image = await RenderAsync(pageIndex, crop).WaitAsync(PdfRender.Timeout).ConfigureAwait(false);
                lock (_cache)
                {
                    if (!_disposed)
                    {
                        _cache.RemoveAll(c => c.Index == pageIndex);
                        _cache.Add((pageIndex, image));
                        if (_cache.Count > MaxCached) _cache.RemoveAt(0);
                    }
                }
                return image;
            }
            finally { PdfRender.OneAtATime.Release(); }
        });
    }

    async Task<BitmapSource> RenderAsync(int pageIndex, PdfBox? crop)
    {
        var (document, _) = await Open().ConfigureAwait(false);
        return await PdfRender.Render(document, pageIndex, crop, PdfRender.PagePixels, null).ConfigureAwait(false);
    }

    // The open in flight or done. A failed one is not kept: the next page tries again.
    Task<(PdfDocument Document, InMemoryRandomAccessStream Stream)> Open()
    {
        lock (_cache)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_open is null || _open.IsFaulted || _open.IsCanceled) _open = OpenOnce();
            return _open;
        }
    }

    // An open that ends after Dispose (its render was given up on meanwhile) closes what it opened.
    async Task<(PdfDocument Document, InMemoryRandomAccessStream Stream)> OpenOnce()
    {
        var opened = await PdfRender.OpenAsync(pdf).ConfigureAwait(false);
        lock (_cache)
        {
            if (!_disposed) return opened;
        }
        opened.Stream.Dispose();
        throw new ObjectDisposedException(nameof(PdfPages));
    }

    // Lets go of the pages at once, and of the open document as soon as no render is using it.
    // (Windows' PdfDocument has no Close of its own; it goes with its stream and the last reference.)
    public void Dispose()
    {
        Task<(PdfDocument Document, InMemoryRandomAccessStream Stream)>? open;
        lock (_cache)
        {
            if (_disposed) return;
            _disposed = true;
            _cache.Clear();
            open = _open;
            _open = null;
        }
        if (open is null) return;
        _ = Task.Run(async () =>
        {
            try
            {
                // An open still running sees _disposed and closes its own (OpenOnce): that throws here.
                var (_, stream) = await open.ConfigureAwait(false);
                await PdfRender.OneAtATime.WaitAsync().ConfigureAwait(false);
                try { stream.Dispose(); }
                finally { PdfRender.OneAtATime.Release(); }
            }
            catch { }
        });
    }
}
