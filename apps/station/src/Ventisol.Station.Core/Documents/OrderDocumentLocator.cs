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

// What a file is to its order. 3E writes the order's production list; orders with arched or bevelled
// elements ("bue/skrå", BS) also get a production list of those positions alone and a file of their
// drawings, named by Ventisol: "58931_20261127BS.pdf" and "58931_20261127BS tegninger.pdf" since
// 27-11-2026, "B S 58931_20261112.pdf" and "B S tegninger 58931_20261112.pdf" before. The order is
// ranked in this order: the list first, the BS list next, the drawings last.
public enum OrderDocumentKind
{
    List = 0,
    BsList = 1,
    BsDrawings = 2,
}

// An order document's file name as read by OrderDocumentLocator.TryParseFileName. Prefix is "BE", "TE",
// "BE_X" ..., empty for an ordinary order; it never holds the BS label (that is Kind).
public readonly record struct OrderFileName(int Order, DateOnly? Date, OrderDocumentKind Kind, string Prefix)
{
    // The label the kind carries in a file name, for the OptiCloud row: "BS", "BS tegninger", or empty.
    public string KindLabel => Kind switch
    {
        OrderDocumentKind.BsList => "BS",
        OrderDocumentKind.BsDrawings => "BS tegninger",
        _ => "",
    };
}

public sealed record OrderDocumentLookup(int Order, OrderDocumentStatus Status, string? Path = null, string? Error = null);

// What a look through the folder found: how many orders have a document, or why it couldn't look.
public sealed record OrderDocumentFolderStatus(bool Available, int Orders, int Files, string? Error = null);

// Finds the PDF 3E wrote for an order in the documents folder: "<order>_<yyyyMMdd>.pdf", or with a
// prefix such as "BE_<order>_<yyyyMMdd>.pdf", in the folder or any folder below it. With more than one
// for an order (an older one kept as history, prefixed or not), the order's list wins over its BS
// files (OrderDocumentKind), then the newest date in the name, then the newest write time. The BS
// files are found apart with FindAsync(order, kind). The folder is a network share on site, so it is never read on the
// caller's thread: the files are listed in the background into an index, kept for RefreshAfter
// (30 s), and listed again when that is up or when an order isn't in the index (at most every
// MissRefreshAfter, 3 s). A listing that takes longer than Timeout (10 s) answers FolderUnavailable,
// or from the last index if there is one, and goes on in the background to fill the index.
// A listing that fails or hangs (the share is gone for a while, say the internet is down) keeps the last
// good index with its time, and the share counts as down for DownFor (45 s): lookups answer from the
// last index at once (else FolderUnavailable) without asking the share, then it is tried again.
// OrderDocuments marks it down too when a file read hangs or the share can't be reached. While a listing
// is under way, a lookup the last index knows answers from it at once. One listing runs at a time.
public sealed partial class OrderDocumentLocator
{
    public static readonly TimeSpan DefaultRefreshAfter = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan DefaultMissRefreshAfter = TimeSpan.FromSeconds(3);
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan DefaultDownFor = TimeSpan.FromSeconds(45);

    // A file found in the folder.
    public sealed record Entry(string Path, int Order, DateOnly? Date, DateTime WriteTimeUtc, OrderDocumentKind Kind = OrderDocumentKind.List);

    // Best: the order's document (the list if there is one). Parts: the newest file of each kind.
    sealed record Index(IReadOnlyDictionary<int, Entry> Best, IReadOnlyDictionary<(int, OrderDocumentKind), Entry> Parts, IReadOnlyList<Entry> All, DateTimeOffset At)
    {
        public int Files => All.Count;

        public Entry? Pick(int order, OrderDocumentKind? kind) =>
            kind is { } k ? Parts.GetValueOrDefault((order, k)) : Best.GetValueOrDefault(order);
    }

    readonly Func<string, CancellationToken, IReadOnlyList<Entry>> _list;
    readonly TimeProvider _time;
    readonly object _gate = new();
    Index? _index;
    Task<Index>? _listing;
    string? _lastError;
    // Until then the share counts as down: lookups answer from the last index without asking it.
    DateTimeOffset? _downUntil;

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
    public TimeSpan DownFor { get; init; } = DefaultDownFor;

    // The orders in the last index, or null before the first listing has finished.
    public int? IndexedOrders { get { lock (_gate) return _index?.Best.Count; } }

    // When the last good index was listed, or null before the first listing has finished.
    public DateTimeOffset? IndexedAt { get { lock (_gate) return _index?.At; } }

    // Every order document in the last index, older versions and all; null before the first listing has finished.
    public IReadOnlyList<Entry>? IndexedFiles { get { lock (_gate) return _index?.All; } }

    // Whether the last index has a PDF for the order, without listing the folder. False when unknown.
    public bool Has(int order)
    {
        lock (_gate) return _index?.Best.ContainsKey(order) == true;
    }

    // The highest order number with a PDF in the last index, without listing the folder; null when
    // unknown. Only five-digit orders count: a stray file name must not pass for the newest order.
    public int? NewestOrder
    {
        get
        {
            lock (_gate)
            {
                if (_index is null) return null;
                var orders = _index.Best.Keys.Where(o => o <= 99999);
                return orders.Any() ? orders.Max() : null;
            }
        }
    }

    // Where the last index has the order's file of that kind, without listing the folder. Null when unknown.
    public string? KnownPath(int order, OrderDocumentKind kind)
    {
        lock (_gate) return _index?.Pick(order, kind)?.Path;
    }

    // The order's document: its list, else its BS list, else its BS drawings.
    public Task<OrderDocumentLookup> FindAsync(int order, CancellationToken ct = default) => FindAsync(order, null, ct);

    // With a kind, only a file of that kind (the newest) is found.
    public async Task<OrderDocumentLookup> FindAsync(int order, OrderDocumentKind? kind, CancellationToken ct = default)
    {
        if (Folder is null) return new(order, OrderDocumentStatus.Off);

        var now = _time.GetUtcNow();
        Index? index;
        bool down, listing;
        string? lastError;
        lock (_gate) (index, down, listing, lastError) = (_index, Down(now), _listing is { IsCompleted: false }, _lastError);

        if (index is not null && now - index.At < RefreshAfter)
        {
            if (index.Pick(order, kind) is { } hit) return Found(order, hit);
            if (now - index.At < MissRefreshAfter) return new(order, OrderDocumentStatus.NotFound);
        }

        var known = index?.Pick(order, kind);
        // The share failed or hung a moment ago: don't wait for it again, the last index answers until DownFor is up.
        if (down) return known is not null ? Found(order, known) : new(order, OrderDocumentStatus.FolderUnavailable, Error: lastError);
        // A listing is under way and the last index knows the order: no need to wait for it.
        if (known is not null && listing) return Found(order, known);

        var (fresh, error) = await ListAsync(ct).ConfigureAwait(false);
        if (fresh is not null)
            return fresh.Pick(order, kind) is { } e ? Found(order, e) : new(order, OrderDocumentStatus.NotFound);

        // No new listing in time: the last one still says where the file was, if it knew.
        return known is not null ? Found(order, known) : new(order, OrderDocumentStatus.FolderUnavailable, Error: error);
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

    // Whether the share failed or hung less than DownFor ago, so the folder isn't asked now.
    public bool IsDown { get { lock (_gate) return Down(_time.GetUtcNow()); } }

    // The share failed or hung elsewhere (a file read): don't ask it again for DownFor.
    public void ShareDown(string error)
    {
        lock (_gate) MarkDown(error);
    }

    // The share answered after all (a slow read got through): ask it again from the next lookup.
    public void ShareAnswered()
    {
        lock (_gate) _downUntil = null;
    }

    bool Down(DateTimeOffset now) => _downUntil is { } until && now < until;

    // Under the lock.
    void MarkDown(string error)
    {
        _lastError = error;
        _downUntil = _time.GetUtcNow() + DownFor;
    }

    async Task<(Index? Index, string? Error)> ListAsync(CancellationToken ct)
    {
        Task<Index> listing;
        lock (_gate)
        {
            if (_listing is not { IsCompleted: false })
            {
                var folder = Folder!;
                _listing = Task.Run(() => Build(folder), CancellationToken.None);
            }
            listing = _listing;
        }

        try
        {
            return (await listing.WaitAsync(Timeout, _time, ct).ConfigureAwait(false), null);
        }
        catch (TimeoutException)
        {
            // The listing hangs: the share is down until it gets through or DownFor is up.
            const string error = "Mappen svarer ikke";
            lock (_gate) if (!listing.IsCompleted) MarkDown(error);
            return (null, error);
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

    // The index, the error and the down time are set here, before the listing task completes, so a
    // caller that awaited it sees them at once.
    Index Build(string folder)
    {
        try
        {
            var files = _list(folder, CancellationToken.None);
            var best = new Dictionary<int, Entry>();
            var parts = new Dictionary<(int, OrderDocumentKind), Entry>();
            foreach (var f in files)
            {
                if (!best.TryGetValue(f.Order, out var have) || Newer(f, have)) best[f.Order] = f;
                if (!parts.TryGetValue((f.Order, f.Kind), out var part) || Newer(f, part)) parts[(f.Order, f.Kind)] = f;
            }
            var index = new Index(best, parts, files, _time.GetUtcNow());
            lock (_gate) (_index, _lastError, _downUntil) = (index, null, null);
            return index;
        }
        catch (Exception ex)
        {
            // An unreadable folder keeps the last good index (and its time): the share is often only
            // gone for a few minutes, and the documents read from it are kept as copies.
            lock (_gate) MarkDown(Describe(ex));
            throw;
        }
    }

    public string? LastError { get { lock (_gate) return _lastError; } }

    static bool Newer(Entry a, Entry b) => Ranks(a.Kind, a.Date, b.Kind, b.Date) switch
    {
        > 0 => true,
        < 0 => false,
        _ => a.WriteTimeUtc > b.WriteTimeUtc,
    };

    // Above 0 when a goes before b as the order's document: the list before the BS files
    // (OrderDocumentKind), then the newer date in the name. 0 when that doesn't tell them apart.
    public static int Ranks(OrderDocumentKind aKind, DateOnly? aDate, OrderDocumentKind bKind, DateOnly? bDate) =>
        aKind != bKind ? (bKind - aKind) : (aDate ?? DateOnly.MinValue).CompareTo(bDate ?? DateOnly.MinValue);

    static OrderDocumentLookup Found(int order, Entry e) => new(order, OrderDocumentStatus.Found, e.Path);

    static string Describe(Exception ex) => ex switch
    {
        DirectoryNotFoundException => "Mappen findes ikke",
        UnauthorizedAccessException => "Ingen adgang til mappen",
        _ => "Mappen kan ikke læses",
    };

    // The name is parts split by "_". The last part is the print date, the part before it the order
    // (all digits), and any parts before that a prefix that must hold a letter: "58721_20261022.pdf" and
    // "BE_58721_20261022.pdf" (or TE_, RKK_ ...) both give order 58721 and 22 October 2026, while
    // "2_58721_20261022.pdf" is no order document (which number would be the order?).
    // A last part that isn't a date still counts, with no date.
    // A BS label ("BS", "B S", "BS tegninger", any case) makes it a BS file (OrderDocumentKind): after the
    // date ("58931_20261127BS.pdf", "58931_20261127 BS tegninger.pdf", "58931_20261127_BS.pdf"), before
    // the order ("B S tegninger 58931_20261112.pdf") or as a prefix part of its own ("BS_58931_20261127.pdf").
    // Text after a label that follows the date ("58931_20261127BS (1).pdf", "... - Kopi") keeps the kind:
    // such a name is never the list.
    public static bool TryParseFileName(string fileName, out int order, out DateOnly? date)
    {
        var ok = TryParseFileName(fileName, out OrderFileName name);
        (order, date) = (name.Order, name.Date);
        return ok;
    }

    public static bool TryParseFileName(string fileName, out OrderFileName name)
    {
        name = default;
        var m = FileNameRegex().Match(fileName);
        if (!m.Success) return false;
        var stem = m.Groups[1].Value.Trim();
        OrderDocumentKind? kind = null;

        var tail = TrailingLabelRegex().Match(stem);
        if (!tail.Success) tail = LabelAfterDateRegex().Match(stem);
        if (tail.Success)
        {
            kind = KindOf(tail.Groups["label"].Value);
            stem = tail.Groups["rest"].Value;
        }

        var found = OrderAndLastRegex().Match(stem);
        if (!found.Success) return false;
        var head = found.Groups["head"].Value;
        var orderPart = found.Groups["order"].Value;
        foreach (Match lead in LeadingLabelRegex().Matches(head))
            kind = Strongest(kind, KindOf(lead.Groups["label"].Value));
        // What is left of the head is the prefix parts, each ending in "_" and holding a letter.
        var rest = LeadingLabelRegex().Replace(head, "").TrimEnd();
        if (rest.Length > 0 && !rest.EndsWith('_')) return false;
        string[] prefixes = rest.Length == 0 ? [] : rest[..^1].Split('_');
        if (prefixes.Any(p => !p.Any(char.IsLetter))) return false;
        if (!OrderPartRegex().IsMatch(orderPart)) return false;
        if (!int.TryParse(orderPart, NumberStyles.None, CultureInfo.InvariantCulture, out var number)) return false;
        DateOnly? d = DateOnly.TryParseExact(found.Groups["last"].Value.Trim(), "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var parsed) ? parsed : null;
        name = new OrderFileName(number, d, kind ?? OrderDocumentKind.List, string.Join('_', prefixes));
        return true;
    }

    static OrderDocumentKind KindOf(string label) =>
        label.Contains("tegning", StringComparison.OrdinalIgnoreCase) ? OrderDocumentKind.BsDrawings : OrderDocumentKind.BsList;

    // Two labels in one name ("BS_58931_20261127BS tegninger.pdf"): the drawings say more.
    static OrderDocumentKind Strongest(OrderDocumentKind? a, OrderDocumentKind b) => a is { } k && k > b ? k : b;

    // Every "[prefix_]<order>_*.pdf" in the folder and the folders below it, skipping what can't be read.
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
            if (TryParseFileName(f.Name, out OrderFileName name))
                result.Add(new Entry(f.FullName, name.Order, name.Date, f.LastWriteTimeUtc, name.Kind));
        }
        return result;
    }

    [GeneratedRegex(@"^([^\\/]+)\.pdf$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FileNameRegex();

    [GeneratedRegex(@"^0*\d{1,9}$", RegexOptions.CultureInvariant)]
    private static partial Regex OrderPartRegex();

    // "B S", "BS", "BS tegninger", "BS-tegning", "B_S_tegninger" ...: spaces, "_" and "-" may stand between
    // B, S and "tegning(er)", any number of them.
    const string Label = @"B[ _\-]*S(?:[ _\-]*tegning(?:er)?)?";

    // A label that ends the name: "58931_20261127BS", "58931_20261127 BS tegninger", "58931_20261127_BS".
    [GeneratedRegex(@"^(?<rest>.*\d)[ _\-]*(?<label>" + Label + @")$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TrailingLabelRegex();

    // A label right after the date with more behind it: "58931_20261127BS (1)", "58931_20261127BS - Kopi",
    // "58931_20261127BS tegninger rev2". Whatever follows, the file is a BS file and never the list.
    [GeneratedRegex(@"^(?<rest>.*_\d{8})[ _\-]*(?<label>" + Label + @")", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LabelAfterDateRegex();

    // The order and what stands around it: "<head><order>_<last>", where the last part has no "_".
    [GeneratedRegex(@"^(?<head>.*?)(?<order>\d+)\s*_(?<last>[^_]*)$", RegexOptions.CultureInvariant)]
    private static partial Regex OrderAndLastRegex();

    // A label before the order: a prefix part of its own ("BS_", "BS_tegninger_", "B_S_") or the text right
    // before the number ("B S tegninger 58931", "B  S 58931", "BS-58931"). Not the end of another prefix ("ABS_").
    [GeneratedRegex(@"(?<=^|_) *(?<label>" + Label + @")(?:[ _\-]*_|[ \-]+$)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LeadingLabelRegex();
}
