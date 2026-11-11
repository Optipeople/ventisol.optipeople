using System.Globalization;
using System.Text.RegularExpressions;

namespace Ventisol.Station.Core.Documents;

public enum OrderDocumentStatus
{
    // No folder set: the feature is off.
    Off,
    Found,
    NotFound,
    // The folder can't be read right now (missing, no access, or too slow to answer).
    FolderUnavailable,
}

public sealed record OrderDocumentLookup(int Order, OrderDocumentStatus Status, string? Path = null, string? Error = null);

// What a look through the folder found: how many orders have a document, or why it couldn't look.
public sealed record OrderDocumentFolderStatus(bool Available, int Orders, int Files, string? Error = null);

// Finds the PDF 3E wrote for an order in the documents folder: "<order>_<yyyyMMdd>.pdf", in the
// folder or any folder below it. With more than one for an order, the newest date in the name wins,
// then the newest write time. The folder is a network share on site, so it is never read on the
// caller's thread: the files are listed in the background into an index, kept for RefreshAfter
// (30 s), and listed again when that is up or when an order isn't in the index (at most every
// MissRefreshAfter, 3 s). A listing that takes longer than Timeout (10 s) answers FolderUnavailable,
// or from the last index if there is one, and goes on in the background to fill the index.
// One listing runs at a time; callers share it.
public sealed partial class OrderDocumentLocator
{
    public static readonly TimeSpan DefaultRefreshAfter = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan DefaultMissRefreshAfter = TimeSpan.FromSeconds(3);
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(10);

    // A file found in the folder.
    public sealed record Entry(string Path, int Order, DateOnly? Date, DateTime WriteTimeUtc);

    sealed record Index(IReadOnlyDictionary<int, Entry> Best, int Files, DateTimeOffset At);

    readonly Func<string, CancellationToken, IReadOnlyList<Entry>> _list;
    readonly TimeProvider _time;
    readonly object _gate = new();
    Index? _index;
    Task<Index>? _listing;
    string? _lastError;

    public OrderDocumentLocator(string? folder, TimeProvider? time = null, Func<string, CancellationToken, IReadOnlyList<Entry>>? list = null)
    {
        Folder = string.IsNullOrWhiteSpace(folder) ? null : folder.Trim();
        _time = time ?? TimeProvider.System;
        _list = list ?? ListFolder;
    }

    public string? Folder { get; }
    public TimeSpan RefreshAfter { get; init; } = DefaultRefreshAfter;
    public TimeSpan MissRefreshAfter { get; init; } = DefaultMissRefreshAfter;
    public TimeSpan Timeout { get; init; } = DefaultTimeout;

    // The orders in the last index, or null before the first listing has finished.
    public int? IndexedOrders { get { lock (_gate) return _index?.Best.Count; } }

    // Whether the last index has a PDF for the order, without listing the folder. False when unknown.
    public bool Has(int order)
    {
        lock (_gate) return _index?.Best.ContainsKey(order) == true;
    }

    public async Task<OrderDocumentLookup> FindAsync(int order, CancellationToken ct = default)
    {
        if (Folder is null) return new(order, OrderDocumentStatus.Off);

        Index? index;
        lock (_gate) index = _index;
        var now = _time.GetUtcNow();

        if (index is not null && now - index.At < RefreshAfter)
        {
            if (index.Best.TryGetValue(order, out var hit)) return Found(order, hit);
            if (now - index.At < MissRefreshAfter) return new(order, OrderDocumentStatus.NotFound);
        }

        var (fresh, error) = await ListAsync(ct).ConfigureAwait(false);
        if (fresh is not null)
            return fresh.Best.TryGetValue(order, out var e) ? Found(order, e) : new(order, OrderDocumentStatus.NotFound);

        // No new listing in time: the last one still says where the file was, if it knew.
        if (index is not null && index.Best.TryGetValue(order, out var old)) return Found(order, old);
        return new(order, OrderDocumentStatus.FolderUnavailable, Error: error);
    }

    // Lists the folder now (sharing a listing already under way), for the setup screen's status line.
    public async Task<OrderDocumentFolderStatus> RefreshAsync(CancellationToken ct = default)
    {
        if (Folder is null) return new(false, 0, 0, "Ingen mappe valgt");
        var (index, error) = await ListAsync(ct).ConfigureAwait(false);
        return index is null ? new(false, 0, 0, error) : new(true, index.Best.Count, index.Files);
    }

    // A one-off look at a folder, as the setup screen does while a path is typed.
    public static Task<OrderDocumentFolderStatus> CheckFolderAsync(string? folder, TimeSpan? timeout = null, CancellationToken ct = default) =>
        new OrderDocumentLocator(folder) { Timeout = timeout ?? DefaultTimeout }.RefreshAsync(ct);

    // Drops the index, so the next lookup lists the folder again (say, when a found file could not be opened).
    public void Forget()
    {
        lock (_gate) _index = null;
    }

    async Task<(Index? Index, string? Error)> ListAsync(CancellationToken ct)
    {
        Task<Index> listing;
        lock (_gate)
        {
            if (_listing is null)
            {
                var folder = Folder!;
                _listing = Task.Run(() => Build(folder), CancellationToken.None);
                _ = _listing.ContinueWith(Done, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
            listing = _listing;
        }

        try
        {
            return (await listing.WaitAsync(Timeout, _time, ct).ConfigureAwait(false), null);
        }
        catch (TimeoutException)
        {
            return (null, "Mappen svarer ikke");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return (null, Describe(ex));
        }
    }

    Index Build(string folder)
    {
        var files = _list(folder, CancellationToken.None);
        var best = new Dictionary<int, Entry>();
        foreach (var f in files)
            if (!best.TryGetValue(f.Order, out var have) || Newer(f, have)) best[f.Order] = f;
        return new Index(best, files.Count, _time.GetUtcNow());
    }

    void Done(Task<Index> t)
    {
        lock (_gate)
        {
            if (t.IsCompletedSuccessfully) { _index = t.Result; _lastError = null; }
            else
            {
                // An unreadable folder drops the index: its paths would only fail to open.
                _index = null;
                _lastError = t.Exception is { } ex ? Describe(ex.GetBaseException()) : "Mappen kan ikke læses";
            }
            if (_listing == t) _listing = null;
        }
    }

    public string? LastError { get { lock (_gate) return _lastError; } }

    static bool Newer(Entry a, Entry b) =>
        (a.Date ?? DateOnly.MinValue).CompareTo(b.Date ?? DateOnly.MinValue) switch
        {
            > 0 => true,
            < 0 => false,
            _ => a.WriteTimeUtc > b.WriteTimeUtc,
        };

    static OrderDocumentLookup Found(int order, Entry e) => new(order, OrderDocumentStatus.Found, e.Path);

    static string Describe(Exception ex) => ex switch
    {
        DirectoryNotFoundException => "Mappen findes ikke",
        UnauthorizedAccessException => "Ingen adgang til mappen",
        _ => "Mappen kan ikke læses",
    };

    // "58721_20261022.pdf" gives order 58721 and 22 October 2026. Anything after the first "_"
    // that isn't a date still counts, with no date.
    public static bool TryParseFileName(string fileName, out int order, out DateOnly? date)
    {
        order = 0;
        date = null;
        var m = FileNameRegex().Match(fileName);
        if (!m.Success || !int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out order)) return false;
        if (DateOnly.TryParseExact(m.Groups[2].Value, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d)) date = d;
        return true;
    }

    // Every "<order>_*.pdf" in the folder and the folders below it, skipping what can't be read.
    // Throws when the folder itself can't be read.
    public static IReadOnlyList<Entry> ListFolder(string folder, CancellationToken ct)
    {
        var dir = new DirectoryInfo(folder);
        if (!dir.Exists) throw new DirectoryNotFoundException(folder);
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            MatchCasing = MatchCasing.CaseInsensitive,
            MaxRecursionDepth = 8,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };
        var result = new List<Entry>();
        foreach (var f in dir.EnumerateFiles("*_*.pdf", options))
        {
            ct.ThrowIfCancellationRequested();
            if (TryParseFileName(f.Name, out var order, out var date))
                result.Add(new Entry(f.FullName, order, date, f.LastWriteTimeUtc));
        }
        return result;
    }

    [GeneratedRegex(@"^0*(\d{1,9})_([^\\/]*)\.pdf$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FileNameRegex();
}
