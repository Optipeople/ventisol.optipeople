namespace Ventisol.Station.Core.Documents;

public enum OrderDocumentLoadStatus
{
    // No folder set: the feature is off.
    Off,
    // The folder can't be read right now.
    FolderUnavailable,
    // No PDF for the order in the folder.
    NotFound,
    // The file is there but couldn't be read (gone, locked, too slow, or not a PDF).
    Unreadable,
    // Read. The position may still be missing (Position null) and Document.Problems may say what wasn't read.
    Ready,
}

// An element's document: the order's PDF as read, the element's position in it, and the PDF's bytes
// so a viewer renders the same file that was parsed, without going to the share again.
public sealed record OrderDocumentLoad(
    Barcode Barcode,
    OrderDocumentLoadStatus Status,
    OrderDocument? Document = null,
    OrderPosition? Position = null,
    byte[]? Pdf = null,
    string? Path = null,
    string? Error = null)
{
    // A key for the file's content, the same for every load of the same file version (for render caches).
    public string? FileKey { get; init; }
}

// Finds and reads an element's order document in the background: the locator finds the file, then it is
// read into memory and parsed. Parsed documents are kept by path, write time and size (the last
// MaxCached), so the same order again, or a pre-fetch at scan-in, makes the next look instant. A file
// that takes longer than ReadTimeout answers Unreadable; the read goes on and fills the cache.
public sealed class OrderDocuments
{
    public const int MaxCached = 24;
    public static readonly TimeSpan DefaultReadTimeout = TimeSpan.FromSeconds(15);

    sealed record Read(OrderDocument Document, byte[] Pdf, string Key);

    readonly OrderDocumentLocator _locator;
    readonly Func<string, byte[]> _readFile;
    readonly object _gate = new();
    // Newest last.
    readonly List<(string Key, Task<Read> Task)> _cache = [];

    public OrderDocuments(OrderDocumentLocator locator, Func<string, byte[]>? readFile = null)
    {
        _locator = locator;
        _readFile = readFile ?? File.ReadAllBytes;
    }

    public bool IsOn => _locator.Folder is not null;
    public string? Folder => _locator.Folder;

    // Whether the order has a PDF in the folder as last listed; false when unknown. Never waits.
    public bool Has(int order) => _locator.Has(order);

    // Lists the folder in the background, so Has knows the orders before the first scan.
    public void Warm()
    {
        if (IsOn) _ = _locator.RefreshAsync();
    }
    public TimeSpan ReadTimeout { get; init; } = DefaultReadTimeout;

    public async Task<OrderDocumentLoad> LoadAsync(Barcode barcode, CancellationToken ct = default)
    {
        var lookup = await _locator.FindAsync(barcode.Order, ct).ConfigureAwait(false);
        switch (lookup.Status)
        {
            case OrderDocumentStatus.Off: return new(barcode, OrderDocumentLoadStatus.Off);
            case OrderDocumentStatus.NotFound: return new(barcode, OrderDocumentLoadStatus.NotFound);
            case OrderDocumentStatus.FolderUnavailable: return new(barcode, OrderDocumentLoadStatus.FolderUnavailable, Error: lookup.Error);
        }

        var path = lookup.Path!;
        Read read;
        try
        {
            // Even the file's write time is a trip to the share, so all of it runs in the background.
            read = await Task.Run(() => ReadCached(path), CancellationToken.None).WaitAsync(ReadTimeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            return new(barcode, OrderDocumentLoadStatus.Unreadable, Path: path, Error: "Filen svarer ikke");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // Moved or deleted since the folder was listed: look again next time.
            _locator.Forget();
            return new(barcode, OrderDocumentLoadStatus.Unreadable, Path: path, Error: Describe(ex));
        }

        var doc = read.Document;
        // Nothing read at all (not a PDF, or every page failed): the file is there but useless.
        if (doc.PageCount == 0)
            return new(barcode, OrderDocumentLoadStatus.Unreadable, doc, Path: path, Error: "Filen kan ikke læses som PDF") { FileKey = read.Key };
        return new(barcode, OrderDocumentLoadStatus.Ready, doc, doc.PositionFor(barcode), read.Pdf, path) { FileKey = read.Key };
    }

    Task<Read> ReadCached(string path)
    {
        // The write time and size say whether the cached copy is still this file.
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException(path);
        var key = $"{info.FullName}|{info.LastWriteTimeUtc.Ticks}|{info.Length}";

        lock (_gate)
        {
            var i = _cache.FindIndex(c => c.Key == key);
            if (i >= 0)
            {
                var hit = _cache[i];
                _cache.RemoveAt(i);
                _cache.Add(hit);
                return hit.Task;
            }
            var task = Task.Run(() =>
            {
                var bytes = _readFile(path);
                return new Read(OrderDocumentParser.Parse(bytes, path), bytes, key);
            });
            _cache.Add((key, task));
            if (_cache.Count > MaxCached) _cache.RemoveAt(0);
            // A failed read is not kept: the next look tries again.
            _ = task.ContinueWith(t => { lock (_gate) _cache.RemoveAll(c => c.Task == t); },
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return task;
        }
    }

    static string Describe(Exception ex) => ex switch
    {
        FileNotFoundException or DirectoryNotFoundException => "Filen findes ikke længere",
        UnauthorizedAccessException => "Ingen adgang til filen",
        IOException => "Filen kan ikke åbnes",
        _ => "Filen kan ikke læses",
    };
}
