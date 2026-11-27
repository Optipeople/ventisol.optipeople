using Ventisol.Station.Core.Cloud;

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
// so a viewer renders the same file that was parsed, without going to the share again. Path is the
// file the bytes came from: the share's file, or the copy on this PC.
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

    // The copy is another file than the one the folder lists for the order now: an older version.
    public bool OlderVersion { get; init; }
}

// A PDF bigger than OrderDocuments.MaxPdfBytes: not read. An IOException, so it is handled as a
// file that can't be read wherever nothing more is made of it.
public sealed class OrderDocumentTooLargeException(string path, long size)
    : IOException($"{System.IO.Path.GetFileName(path)} er for stor ({size / (1024 * 1024)} MB, højst {OrderDocuments.MaxPdfBytes / (1024 * 1024)} MB)")
{
    public long Size { get; } = size;
}

// Finds and reads an element's order document in the background: the locator finds the file, then it is
// read into memory and parsed. Parsed documents are kept by path, write time and size (the last
// MaxCached), so the same order again, or a pre-fetch at scan-in, makes the next look instant. A file
// that takes longer than ReadTimeout answers Unreadable; the read goes on and fills the cache.
// The folder is reached over the internet, so it can be gone for a few minutes. Then a copy answers
// (FromCopy): the parsed document still in memory, or the copy in Cache, the folder on this PC every
// PDF read from the share is saved to. When the share answers, the share wins. A read that hangs or
// finds the share gone marks the locator down, so the next scans go straight to the copy instead of
// each waiting ReadTimeout, until the locator tries the share again.
public sealed class OrderDocuments
{
    public const int MaxCached = 24;
    // The biggest PDF read. A file is read whole into memory (here, and before it is put in
    // OptiCloud), and 3E's order documents are a few MB: something far bigger in the folder is not
    // one of them, and reading it could take the app down.
    public const long MaxPdfBytes = 50L * 1024 * 1024;
    public static readonly TimeSpan DefaultReadTimeout = TimeSpan.FromSeconds(15);
    // How long a failed read waits to learn whether the folder is still there.
    static readonly TimeSpan ReachTimeout = TimeSpan.FromSeconds(3);

    // Path is the file read; IsCopy when that is a copy in Cache, not the share's file.
    sealed record Read(OrderDocument Document, byte[] Pdf, string Key, string Path, bool IsCopy, int Order, DateOnly? Date,
        OrderDocumentKind Kind = OrderDocumentKind.List);

    readonly OrderDocumentLocator _locator;
    readonly Func<string, byte[]> _readFile;
    readonly object _gate = new();
    // Newest last.
    readonly List<(string Key, Task<Read> Task)> _cache = [];

    public OrderDocuments(OrderDocumentLocator locator, Func<string, byte[]>? readFile = null, OrderDocumentCache? cache = null)
    {
        _locator = locator;
        _readFile = readFile ?? ReadPdf;
        Cache = cache;
    }

    // The file's bytes. One over MaxPdfBytes is not read: OrderDocumentTooLargeException.
    public static byte[] ReadPdf(string path)
    {
        using var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1, FileOptions.SequentialScan);
        if (f.Length > MaxPdfBytes) throw new OrderDocumentTooLargeException(path, f.Length);
        var bytes = new byte[f.Length];
        f.ReadExactly(bytes);
        return bytes;
    }

    // Hears of a file not read because it is too big. Any thread.
    public Action<string>? Log { get; init; }

    public bool IsOn => _locator.Folder is not null || Cloud is not null;
    public string? Folder => _locator.Folder;

    // With no folder set: the PDFs come from the OptiCloud list instead (a PC that can't reach the share).
    public CloudDocumentSource? Cloud { get; init; }

    // Where the documents come from, for the screen: the folder, or "OptiCloud".
    public string? SourceName => Folder ?? (Cloud is not null ? "OptiCloud" : null);

    // The copy on this PC of a document from OptiCloud is kept under this made-up folder.
    const string CloudFolder = "OptiCloud";
    public OrderDocumentLocator Locator => _locator;

    // Where the PDFs read from the share are kept on this PC; null keeps them in memory only.
    public OrderDocumentCache? Cache { get; set; }

    // Whether the order has a PDF in the folder as last listed; false when unknown. Never waits.
    public bool Has(int order) => _locator.Has(order);

    // The highest order number with a PDF in the folder as last listed; null when unknown. Never waits.
    public int? NewestOrder => _locator.NewestOrder;

    // Lists the folder in the background, so Has knows the orders before the first scan.
    public void Warm()
    {
        if (IsOn) _ = _locator.RefreshAsync();
    }
    public TimeSpan ReadTimeout { get; init; } = DefaultReadTimeout;

    // The order's document (its list), and the element's position in it. An order with arched or
    // bevelled elements has those positions in a BS list of their own ("58931_20261127BS.pdf"): when the
    // list doesn't hold the element's position and the folder has a BS list that does, that one answers.
    public async Task<OrderDocumentLoad> LoadAsync(Barcode barcode, CancellationToken ct = default)
    {
        if (Folder is null && Cloud is { } cloud) return await LoadFromCloudAsync(cloud, barcode, ct).ConfigureAwait(false);
        var load = await LoadFromShareAsync(barcode, null, ct).ConfigureAwait(false);
        if (load is not { Status: OrderDocumentLoadStatus.Ready, Position: null }) return load;
        var bs = _locator.KnownPath(barcode.Order, OrderDocumentKind.BsList);
        if (bs is null || string.Equals(bs, load.Path, StringComparison.OrdinalIgnoreCase)) return load;
        var part = await LoadFromShareAsync(barcode, OrderDocumentKind.BsList, ct).ConfigureAwait(false);
        return part is { Status: OrderDocumentLoadStatus.Ready, Position: not null } ? part : load;
    }

    async Task<OrderDocumentLoad> LoadFromShareAsync(Barcode barcode, OrderDocumentKind? kind, CancellationToken ct)
    {
        var lookup = await _locator.FindAsync(barcode.Order, kind, ct).ConfigureAwait(false);
        switch (lookup.Status)
        {
            case OrderDocumentStatus.Off: return new(barcode, OrderDocumentLoadStatus.Off);
            case OrderDocumentStatus.NotFound: return new(barcode, OrderDocumentLoadStatus.NotFound);
            case OrderDocumentStatus.FolderUnavailable:
                return await FromCopyAsync(barcode, null, ct).ConfigureAwait(false)
                    ?? new(barcode, OrderDocumentLoadStatus.FolderUnavailable, Error: lookup.Error);
        }

        var path = lookup.Path!;
        // The share hung or was gone a moment ago: don't make every scan wait for it again.
        if (_locator.IsDown)
            return await FromCopyAsync(barcode, path, ct).ConfigureAwait(false)
                ?? new(barcode, OrderDocumentLoadStatus.FolderUnavailable, Path: path, Error: _locator.LastError ?? "Mappen svarer ikke");

        // Even the file's write time is a trip to the share, so all of it runs in the background.
        var reading = ReadAndKeep(path, isCopy: false);
        Read read;
        try
        {
            read = await reading.WaitAsync(ReadTimeout, ct).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // The share hangs: copies answer for a while, or until this read gets through after all.
            _locator.ShareDown("Mappen svarer ikke");
            _ = reading.ContinueWith(t => { if (t.IsCompletedSuccessfully) _locator.ShareAnswered(); }, TaskScheduler.Default);
            return await FromCopyAsync(barcode, path, ct).ConfigureAwait(false)
                ?? new(barcode, OrderDocumentLoadStatus.Unreadable, Path: path, Error: "Filen svarer ikke");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            if (await ReachableAsync().ConfigureAwait(false))
            {
                // The folder is there, the file isn't (moved or deleted since it was listed): look again next time.
                _locator.Forget();
                return new(barcode, OrderDocumentLoadStatus.Unreadable, Path: path, Error: Describe(ex));
            }
            // The share is gone, not the file: keep the index for when it is back, and answer from a copy meanwhile.
            _locator.ShareDown("Mappen kan ikke nås");
            return await FromCopyAsync(barcode, path, ct).ConfigureAwait(false)
                ?? new(barcode, OrderDocumentLoadStatus.FolderUnavailable, Path: path, Error: "Mappen kan ikke nås");
        }

        return Loaded(barcode, read, fromCopy: false);
    }

    // The order's PDF from the OptiCloud list. While OptiCloud can't be reached, a copy answers, as for the share.
    async Task<OrderDocumentLoad> LoadFromCloudAsync(CloudDocumentSource cloud, Barcode barcode, CancellationToken ct)
    {
        CloudDocumentLookup lookup;
        // A slow OptiCloud (a login, a full read of the list) must not keep the screen waiting: the copy answers.
        try { lookup = await cloud.FindAsync(barcode.Order, CancellationToken.None).WaitAsync(ReadTimeout, ct).ConfigureAwait(false); }
        catch (TimeoutException) { lookup = new(CloudDocumentStatus.Unavailable, Error: "OptiCloud svarer ikke"); }
        switch (lookup.Status)
        {
            case CloudDocumentStatus.NotFound: return new(barcode, OrderDocumentLoadStatus.NotFound);
            case CloudDocumentStatus.Unavailable:
                return await FromCopyAsync(barcode, null, ct).ConfigureAwait(false)
                    ?? new(barcode, OrderDocumentLoadStatus.FolderUnavailable, Error: lookup.Error);
        }

        var doc = lookup.Document!;
        var path = System.IO.Path.Combine(CloudFolder, doc.FileName);
        var reading = ReadCloudCached(cloud, doc, path);
        Read read;
        try
        {
            read = await reading.WaitAsync(ReadTimeout, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            if (ex is not TimeoutException) cloud.Forget(barcode.Order);
            var why = ex switch
            {
                TimeoutException => "OptiCloud svarer ikke",
                OptiCloudException x => x.Message,
                OrderDocumentTooLargeException => $"Filen er for stor (over {MaxPdfBytes / (1024 * 1024)} MB)",
                _ => "Filen kan ikke hentes fra OptiCloud",
            };
            return await FromCopyAsync(barcode, path, ct).ConfigureAwait(false)
                ?? new(barcode, OrderDocumentLoadStatus.Unreadable, Path: path, Error: why);
        }
        _ = Task.Run(() => Keep(read));
        return Loaded(barcode, read, fromCopy: false);
    }

    // Downloads (or finds in memory) the file in the background; a copy is saved on this PC.
    Task<Read> ReadCloudCached(CloudDocumentSource cloud, CloudDocument doc, string path)
    {
        var key = doc.Key;
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
            var cache = Cache;
            var task = Task.Run(async () =>
            {
                byte[] bytes;
                try { bytes = await cloud.ReadAsync(doc).ConfigureAwait(false); }
                catch (OrderDocumentTooLargeException x)
                {
                    Log?.Invoke($"Ordredokumenter: {x.Message} i OptiCloud, hentes ikke");
                    throw;
                }
                var parsed = OrderDocumentParser.Parse(bytes, path);
                if (cache is not null && parsed.PageCount > 0)
                {
                    try { cache.Save(path, bytes); }
                    catch (Exception) { }
                }
                return new Read(parsed, bytes, key, path, IsCopy: false, doc.Order, doc.Date, doc.Kind);
            });
            _cache.Add((key, task));
            if (_cache.Count > MaxCached) _cache.RemoveAt(0);
            _ = task.ContinueWith(t => { lock (_gate) _cache.RemoveAll(c => c.Task == t); },
                CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return task;
        }
    }

    static OrderDocumentLoad Loaded(Barcode barcode, Read read, bool fromCopy)
    {
        var doc = read.Document;
        // Nothing read at all (not a PDF, or every page failed): the file is there but useless.
        if (doc.PageCount == 0)
            return new(barcode, OrderDocumentLoadStatus.Unreadable, doc, Path: read.Path, Error: "Filen kan ikke læses som PDF") { FileKey = read.Key, FromCopy = fromCopy };
        return new(barcode, OrderDocumentLoadStatus.Ready, doc, doc.PositionFor(barcode), read.Pdf, read.Path) { FileKey = read.Key, FromCopy = fromCopy };
    }

    // The order's document as kept: in memory first, then on this PC. The version the index points to
    // (path) if there is one, else the newest by the date in the name, marked OlderVersion when the index
    // points to another file. Null when there's none.
    async Task<OrderDocumentLoad?> FromCopyAsync(Barcode barcode, string? path, CancellationToken ct)
    {
        Read? best = null;
        lock (_gate)
        {
            foreach (var (_, task) in _cache)
            {
                if (!task.IsCompletedSuccessfully || task.Result is not { } r || r.Order != barcode.Order || r.Document.PageCount == 0) continue;
                if (best is null || Better(r, best, path)) best = r;
            }
        }
        if (best is not null && (path is null || IsVersion(best, path)))
            return Copy(barcode, best, path);

        if (Cache is { } cache)
        {
            try
            {
                var copy = await Task.Run(() => cache.Find(barcode.Order, path), CancellationToken.None).WaitAsync(ReachTimeout, ct).ConfigureAwait(false);
                if (copy is not null)
                {
                    var read = await ReadAndKeep(copy, isCopy: true).WaitAsync(ReadTimeout, ct).ConfigureAwait(false);
                    if (read.Document.PageCount > 0) return Copy(barcode, read, path);
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
        return best is null ? null : Copy(barcode, best, path);
    }

    OrderDocumentLoad Copy(Barcode barcode, Read read, string? path)
    {
        // Shown again, maybe from memory: the copy on this PC is in use, so prune keeps it.
        _ = Task.Run(() => Keep(read));
        return Loaded(barcode, read, fromCopy: true) with { OlderVersion = path is not null && !IsVersion(read, path) };
    }

    // Whether the read is the share's file at path, or its copy on this PC.
    bool IsVersion(Read read, string path) =>
        read.IsCopy ? Cache?.IsCopyOf(read.Path, path) == true : string.Equals(read.Path, path, StringComparison.OrdinalIgnoreCase);

    bool Better(Read a, Read b, string? path)
    {
        if (path is not null && IsVersion(a, path) != IsVersion(b, path)) return IsVersion(a, path);
        return OrderDocumentLocator.Ranks(a.Kind, a.Date, b.Kind, b.Date) > 0;
    }

    // Whether the documents folder answers at all (in the background, a few seconds at most).
    async Task<bool> ReachableAsync()
    {
        if (Folder is not { } folder) return false;
        try { return await Task.Run(() => Directory.Exists(folder)).WaitAsync(ReachTimeout).ConfigureAwait(false); }
        catch (Exception) { return false; }
    }

    // Reads (or finds in memory) the file in the background, then keeps its copy on this PC fresh.
    Task<Read> ReadAndKeep(string path, bool isCopy) => Task.Run(async () =>
    {
        var read = await ReadCached(path, isCopy).ConfigureAwait(false);
        Keep(read);
        return read;
    }, CancellationToken.None);

    // A document shown keeps its copy on this PC: touched, or saved again if it went, so a copy read
    // daily from memory isn't pruned after MaxAge. A failed copy only means no copy.
    void Keep(Read read)
    {
        if (Cache is not { } cache || read.Document.PageCount == 0) return;
        try
        {
            if (read.IsCopy) cache.Touch(read.Path);
            else cache.Keep(read.Path, read.Pdf);
        }
        catch (Exception) { }
    }

    Task<Read> ReadCached(string path, bool isCopy)
    {
        // The write time and size say whether the cached copy is still this file.
        var info = new FileInfo(path);
        if (!info.Exists) throw new FileNotFoundException(path);
        if (info.Length > MaxPdfBytes)
        {
            var big = new OrderDocumentTooLargeException(path, info.Length);
            Log?.Invoke($"Ordredokumenter: {big.Message}, læses ikke");
            throw big;
        }
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
            var cache = isCopy ? null : Cache;
            var task = Task.Run(() =>
            {
                var bytes = _readFile(path);
                var doc = OrderDocumentParser.Parse(bytes, path);
                OrderDocumentLocator.TryParseFileName(System.IO.Path.GetFileName(path), out OrderFileName name);
                // A copy on this PC for when the share can't be reached. A failed copy only means no copy.
                if (cache is not null && doc.PageCount > 0)
                {
                    try { cache.Save(path, bytes); }
                    catch (Exception) { }
                }
                return new Read(doc, bytes, key, path, isCopy, name.Order, name.Date, name.Kind);
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
        OrderDocumentTooLargeException => $"Filen er for stor (over {MaxPdfBytes / (1024 * 1024)} MB)",
        UnauthorizedAccessException => "Ingen adgang til filen",
        IOException => "Filen kan ikke åbnes",
        _ => "Filen kan ikke læses",
    };
}

// Copies of the order PDFs on this PC, for when the share can't be reached. A PDF is saved here each
// time it is read from the share, named by NameFor: its file name behind a short hash of its folder, so
// files of the same name in two subfolders keep a copy each, and the name still gives order and date.
// A copy not saved or touched for MaxAge (7 days) goes, and only the newest MaxFiles (200) are kept.
public sealed class OrderDocumentCache(string folder, TimeProvider? time = null)
{
    public const int MaxFiles = 200;
    public static readonly TimeSpan MaxAge = TimeSpan.FromDays(7);
    static readonly TimeSpan PruneEvery = TimeSpan.FromHours(1);
    // A copy in use is touched at most this often.
    static readonly TimeSpan TouchEvery = TimeSpan.FromHours(1);

    readonly TimeProvider _time = time ?? TimeProvider.System;
    readonly object _gate = new();
    DateTimeOffset? _prunedAt;

    public string Folder { get; } = folder;

    // The copy's file name for a file on the share: "c<hash of its folder>_<its name>". The prefix holds
    // a letter, so TryParseFileName skips it like BE_.
    public static string NameFor(string sourcePath)
    {
        var dir = (Path.GetDirectoryName(sourcePath) ?? "").TrimEnd('\\', '/').ToUpperInvariant();
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(dir));
        return $"c{Convert.ToHexStringLower(hash, 0, 4)}_{Path.GetFileName(sourcePath)}";
    }

    // Whether the copy is of that file on the share. Copies saved before the folder hash was added carry the
    // plain file name; those count too, so they aren't called an older version after the update.
    public bool IsCopyOf(string copyPath, string sourcePath) =>
        string.Equals(Path.GetFileName(copyPath), NameFor(sourcePath), StringComparison.OrdinalIgnoreCase) ||
        string.Equals(Path.GetFileName(copyPath), Path.GetFileName(sourcePath), StringComparison.OrdinalIgnoreCase);

    public void Save(string sourcePath, byte[] bytes)
    {
        Directory.CreateDirectory(Folder);
        var target = Path.Combine(Folder, NameFor(sourcePath));
        var temp = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        // On the disk (not only in Windows' cache) before the move, so a power cut leaves the old copy or the new one.
        using (var f = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            f.Write(bytes);
            f.Flush(flushToDisk: true);
        }
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

    // The share's file was shown: its copy is touched, or saved if there is none.
    public void Keep(string sourcePath, byte[] bytes)
    {
        var target = Path.Combine(Folder, NameFor(sourcePath));
        if (File.Exists(target)) Touch(target);
        else Save(sourcePath, bytes);
    }

    // A copy in use: a new write time, so Prune keeps it.
    public void Touch(string copyPath)
    {
        var now = _time.GetUtcNow().UtcDateTime;
        if (now - File.GetLastWriteTimeUtc(copyPath) > TouchEvery) File.SetLastWriteTimeUtc(copyPath, now);
    }

    // The copy for an order: the copy of that file on the share if there is one, else the order's list before
    // its BS files, then the newest date in the name.
    public string? Find(int order, string? sourcePath = null)
    {
        if (!Directory.Exists(Folder)) return null;
        if (sourcePath is not null)
        {
            var named = Path.Combine(Folder, NameFor(sourcePath));
            if (File.Exists(named)) return named;
        }
        string? best = null;
        OrderFileName bestName = default;
        var bestWritten = DateTime.MinValue;
        foreach (var f in new DirectoryInfo(Folder).EnumerateFiles("*_*.pdf"))
        {
            if (!OrderDocumentLocator.TryParseFileName(f.Name, out OrderFileName name) || name.Order != order) continue;
            var written = f.LastWriteTimeUtc;
            var rank = best is null ? 1 : OrderDocumentLocator.Ranks(name.Kind, name.Date, bestName.Kind, bestName.Date);
            if (rank > 0 || rank == 0 && written > bestWritten)
                (best, bestName, bestWritten) = (f.FullName, name, written);
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
