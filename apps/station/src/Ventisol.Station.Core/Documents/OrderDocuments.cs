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

    // Ready from a copy kept earlier (in memory or on this PC), because the folder can't be reached now.
    public bool FromCopy { get; init; }
}

// Finds and reads an element's order document in the background: the locator finds the file, then it is
// read into memory and parsed. Parsed documents are kept by path, write time and size (the last
// MaxCached), so the same order again, or a pre-fetch at scan-in, makes the next look instant. A file
// that takes longer than ReadTimeout answers Unreadable; the read goes on and fills the cache.
// The folder is reached over the internet, so it can be gone for a few minutes. Then a copy answers
// (FromCopy): the parsed document still in memory, or the copy in Cache, the folder on this PC every
// PDF read from the share is saved to. When the share answers, the share wins.
public sealed class OrderDocuments
{
    public const int MaxCached = 24;
    public static readonly TimeSpan DefaultReadTimeout = TimeSpan.FromSeconds(15);
    // How long a failed read waits to learn whether the folder is still there.
    static readonly TimeSpan ReachTimeout = TimeSpan.FromSeconds(3);

    sealed record Read(OrderDocument Document, byte[] Pdf, string Key, string Path, int Order, DateOnly? Date);

    readonly OrderDocumentLocator _locator;
    readonly Func<string, byte[]> _readFile;
    readonly object _gate = new();
    // Newest last.
    readonly List<(string Key, Task<Read> Task)> _cache = [];

    public OrderDocuments(OrderDocumentLocator locator, Func<string, byte[]>? readFile = null, OrderDocumentCache? cache = null)
    {
        _locator = locator;
        _readFile = readFile ?? File.ReadAllBytes;
        Cache = cache;
    }

    public bool IsOn => _locator.Folder is not null;
    public string? Folder => _locator.Folder;

    // Where the PDFs read from the share are kept on this PC; null keeps them in memory only.
    public OrderDocumentCache? Cache { get; set; }

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
            case OrderDocumentStatus.FolderUnavailable:
                return await FromCopyAsync(barcode, null, ct).ConfigureAwait(false)
                    ?? new(barcode, OrderDocumentLoadStatus.FolderUnavailable, Error: lookup.Error);
        }

        var path = lookup.Path!;
        Read read;
        try
        {
            // Even the file's write time is a trip to the share, so all of it runs in the background.
            read = await Task.Run(() => ReadCached(path, save: true), CancellationToken.None).WaitAsync(ReadTimeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            return await FromCopyAsync(barcode, path, ct).ConfigureAwait(false)
                ?? new(barcode, OrderDocumentLoadStatus.Unreadable, Path: path, Error: "Filen svarer ikke");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            // The share is gone, not the file: answer from a copy and keep the index for when it is back.
            if (!await ReachableAsync().ConfigureAwait(false)
                && await FromCopyAsync(barcode, path, ct).ConfigureAwait(false) is { } copy)
                return copy;
            // Moved or deleted since the folder was listed: look again next time.
            _locator.Forget();
            return new(barcode, OrderDocumentLoadStatus.Unreadable, Path: path, Error: Describe(ex));
        }

        return Loaded(barcode, read, path, fromCopy: false);
    }

    static OrderDocumentLoad Loaded(Barcode barcode, Read read, string path, bool fromCopy)
    {
        var doc = read.Document;
        // Nothing read at all (not a PDF, or every page failed): the file is there but useless.
        if (doc.PageCount == 0)
            return new(barcode, OrderDocumentLoadStatus.Unreadable, doc, Path: path, Error: "Filen kan ikke læses som PDF") { FileKey = read.Key, FromCopy = fromCopy };
        return new(barcode, OrderDocumentLoadStatus.Ready, doc, doc.PositionFor(barcode), read.Pdf, path) { FileKey = read.Key, FromCopy = fromCopy };
    }

    // The order's document as kept: in memory first, then on this PC. The same file the index pointed
    // to if there is one, else the newest by the date in the name. Null when there's none.
    async Task<OrderDocumentLoad?> FromCopyAsync(Barcode barcode, string? path, CancellationToken ct)
    {
        var name = path is null ? null : System.IO.Path.GetFileName(path);
        Read? best = null;
        lock (_gate)
        {
            foreach (var (_, task) in _cache)
            {
                if (!task.IsCompletedSuccessfully || task.Result is not { } r || r.Order != barcode.Order || r.Document.PageCount == 0) continue;
                if (best is null || Better(r, best, name)) best = r;
            }
        }
        if (best is not null && (name is null || SameName(best.Path, name)))
            return Loaded(barcode, best, path ?? best.Path, fromCopy: true);

        if (Cache is { } cache)
        {
            try
            {
                var copy = await Task.Run(() => cache.Find(barcode.Order, name), CancellationToken.None).WaitAsync(ReachTimeout, ct).ConfigureAwait(false);
                if (copy is not null)
                {
                    var read = await Task.Run(() => ReadCached(copy, save: false), CancellationToken.None).WaitAsync(ReadTimeout, ct).ConfigureAwait(false);
                    if (read.Document.PageCount > 0) return Loaded(barcode, read, path ?? copy, fromCopy: true);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception)
            {
                // No usable copy on this PC.
            }
        }
        return best is null ? null : Loaded(barcode, best, path ?? best.Path, fromCopy: true);
    }

    static bool SameName(string path, string name) =>
        string.Equals(System.IO.Path.GetFileName(path), name, StringComparison.OrdinalIgnoreCase);

    static bool Better(Read a, Read b, string? name)
    {
        if (name is not null && SameName(a.Path, name) != SameName(b.Path, name)) return SameName(a.Path, name);
        return (a.Date ?? DateOnly.MinValue) > (b.Date ?? DateOnly.MinValue);
    }

    // Whether the documents folder answers at all (in the background, a few seconds at most).
    async Task<bool> ReachableAsync()
    {
        if (Folder is not { } folder) return false;
        try { return await Task.Run(() => Directory.Exists(folder)).WaitAsync(ReachTimeout).ConfigureAwait(false); }
        catch (Exception) { return false; }
    }

    Task<Read> ReadCached(string path, bool save)
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
            var cache = save ? Cache : null;
            var task = Task.Run(() =>
            {
                var bytes = _readFile(path);
                var doc = OrderDocumentParser.Parse(bytes, path);
                OrderDocumentLocator.TryParseFileName(System.IO.Path.GetFileName(path), out var order, out var date);
                // A copy on this PC for when the share can't be reached. A failed copy only means no copy.
                if (cache is not null && doc.PageCount > 0)
                {
                    try { cache.Save(path, bytes); }
                    catch (Exception) { }
                }
                return new Read(doc, bytes, key, path, order, date);
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

// Copies of the order PDFs on this PC, by their file name, for when the share can't be reached. A PDF
// is saved here each time it is read from the share. A copy not saved again for MaxAge (7 days) goes,
// and only the newest MaxFiles (200) are kept.
public sealed class OrderDocumentCache(string folder, TimeProvider? time = null)
{
    public const int MaxFiles = 200;
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);
    static readonly TimeSpan PruneEvery = TimeSpan.FromHours(1);

    readonly TimeProvider _time = time ?? TimeProvider.System;
    readonly object _gate = new();
    DateTimeOffset? _prunedAt;

    public string Folder { get; } = folder;

    public void Save(string sourcePath, byte[] bytes)
    {
        Directory.CreateDirectory(Folder);
        var target = Path.Combine(Folder, Path.GetFileName(sourcePath));
        var temp = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, target, overwrite: true);
        var now = _time.GetUtcNow();
        File.SetLastWriteTimeUtc(target, now.UtcDateTime);

        lock (_gate)
        {
            if (_prunedAt is { } at && now - at < PruneEvery) return;
            _prunedAt = now;
        }
        Prune();
    }

    // The copy for an order: the file of that name if there is one, else the newest date in the name.
    public string? Find(int order, string? fileName = null)
    {
        if (!Directory.Exists(Folder)) return null;
        if (fileName is not null)
        {
            var named = Path.Combine(Folder, Path.GetFileName(fileName));
            if (File.Exists(named)) return named;
        }
        string? best = null;
        var bestDate = DateOnly.MinValue;
        var bestWritten = DateTime.MinValue;
        foreach (var f in new DirectoryInfo(Folder).EnumerateFiles("*_*.pdf"))
        {
            if (!OrderDocumentLocator.TryParseFileName(f.Name, out var o, out var date) || o != order) continue;
            var d = date ?? DateOnly.MinValue;
            var written = f.LastWriteTimeUtc;
            if (best is null || d > bestDate || d == bestDate && written > bestWritten)
                (best, bestDate, bestWritten) = (f.FullName, d, written);
        }
        return best;
    }

    public void Prune()
    {
        if (!Directory.Exists(Folder)) return;
        var now = _time.GetUtcNow().UtcDateTime;
        var kept = 0;
        foreach (var f in new DirectoryInfo(Folder).EnumerateFiles().OrderByDescending(f => f.LastWriteTimeUtc).ToList())
        {
            // A .tmp is a save under way, or one that never finished if it is old.
            var stale = f.Name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)
                ? now - f.LastWriteTimeUtc > TimeSpan.FromHours(1)
                : now - f.LastWriteTimeUtc > MaxAge || ++kept > MaxFiles;
            if (!stale) continue;
            try { f.Delete(); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
    }
}
