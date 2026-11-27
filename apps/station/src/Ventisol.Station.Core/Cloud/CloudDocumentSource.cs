using System.Globalization;
using System.Text.Json;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.Core.Cloud;

// An order document in the OptiCloud list VentisolOrderDocuments (see OrderDocumentUpload).
public sealed record CloudDocument(string FileName, int Order, DateOnly? Date, string Reference, string? Sha256, DateTimeOffset? Created,
    OrderDocumentKind Kind = OrderDocumentKind.List)
{
    // Changes when the file in the row changes: a key for the parsed and rendered caches.
    public string Key => $"opticloud|{FileName}|{Sha256 ?? Reference}";
}

public enum CloudDocumentStatus { Found, NotFound, Unavailable }

// Document is the order's document: its list, else its BS list, else its BS drawings. Parts holds the
// order's newest file of each kind, Document first.
public sealed record CloudDocumentLookup(CloudDocumentStatus Status, CloudDocument? Document = null, string? Error = null)
{
    public IReadOnlyList<CloudDocument> Parts { get; init; } = [];

    // The order's newest file of that kind, or null when it has none.
    public CloudDocument? Part(OrderDocumentKind kind) => Parts.FirstOrDefault(p => p.Kind == kind);
}

// Reads the order PDFs from OptiCloud instead of the documents folder, for a PC that can't reach the
// share. The scan PCs put every new PDF in the list (OrderDocumentUpload); this only reads it.
// It uses the app's own connection (CloudSync.Connection), so there is no second login: until that
// is up, a lookup answers Unavailable ("Ikke forbundet til OptiCloud endnu").
// A lookup asks OptiCloud's keyword search for the order and keeps rows whose file name gives that
// order and that have a file; the order's list wins over its BS files, then the newest date in the
// name, then the newest row. The newest BS list and BS drawings are kept beside it (Parts). Answers are
// kept for RefreshAfter (30 s), a miss for MissRefreshAfter (5 s). The list is never made here.
public sealed class CloudDocumentSource(Func<(OptiCloudClient Client, Guid AccountId)?> connection)
{
    public static readonly TimeSpan RefreshAfter = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan MissRefreshAfter = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan FullReadEvery = TimeSpan.FromMinutes(2);
    public const int SearchPageSize = 50;

    readonly object _gate = new();
    // Per order, its newest file of each kind, the order's document first. No files: a miss.
    (IReadOnlyDictionary<int, IReadOnlyList<CloudDocument>> Parts, DateTimeOffset At)? _all;
    Task<IReadOnlyDictionary<int, IReadOnlyList<CloudDocument>>>? _reading;
    readonly Dictionary<int, Task<CloudDocumentLookup>> _finding = [];
    readonly Dictionary<int, (IReadOnlyList<CloudDocument> Parts, DateTimeOffset At)> _known = [];
    Guid? _tableId;
    Guid _tableAccount;

    public Func<DateTimeOffset> Clock { get; init; } = () => DateTimeOffset.UtcNow;

    public async Task<CloudDocumentLookup> FindAsync(int order, CancellationToken ct = default)
    {
        var now = Clock();
        lock (_gate)
        {
            if (_known.TryGetValue(order, out var k) && now - k.At < (k.Parts.Count == 0 ? MissRefreshAfter : RefreshAfter))
                return Answer(k.Parts);
        }

        if (connection() is not { } c) return new(CloudDocumentStatus.Unavailable, Error: "Ikke forbundet til OptiCloud endnu");
        // The prefetch at scan-in, the document and a widget ask for the same order at once: one lookup answers them all.
        Task<CloudDocumentLookup> lookup;
        lock (_gate)
        {
            if (!_finding.TryGetValue(order, out lookup!))
            {
                lookup = Task.Run(() => LookUpAsync(c, order, now), CancellationToken.None);
                _finding[order] = lookup;
                _ = lookup.ContinueWith(_ => { lock (_gate) _finding.Remove(order); }, TaskScheduler.Default);
            }
        }
        return await lookup.WaitAsync(ct);
    }

    async Task<CloudDocumentLookup> LookUpAsync((OptiCloudClient Client, Guid AccountId) c, int order, DateTimeOffset now)
    {
        var ct = CancellationToken.None;
        try
        {
            if (await TableAsync(c.Client, c.AccountId, ct) is not { } table)
                return Remember(order, [], now);
            var page = await c.Client.GetRowsPagedAsync(table, 1, SearchPageSize, "PrintDate", ascending: false,
                keyword: order.ToString(CultureInfo.InvariantCulture), ct: ct);
            var parts = Newest(page.Rows.Select(ToDocument).Where(d => d is not null && d.Order == order)!);
            // What the keyword search matches on is not documented: on a miss the whole list answers,
            // read at most every FullReadEvery.
            if (parts.Count == 0) parts = (await AllAsync(c.Client, table, now)).GetValueOrDefault(order) ?? [];
            return Remember(order, parts, now);
        }
        catch (OptiCloudException x)
        {
            return new(CloudDocumentStatus.Unavailable, Error: x.Message);
        }
        catch (Exception x) when (x is HttpRequestException or IOException or ObjectDisposedException or JsonException or OperationCanceledException)
        {
            return new(CloudDocumentStatus.Unavailable, Error: OptiCloudException.Unreachable);
        }
    }

    // The file's bytes, at most OrderDocuments.MaxPdfBytes. Throws OptiCloudException when OptiCloud
    // can't be reached or won't give it, IOException when it is too big.
    public async Task<byte[]> ReadAsync(CloudDocument document, CancellationToken ct = default)
    {
        if (connection() is not { } c) throw new OptiCloudException("Ikke forbundet til OptiCloud endnu");
        return await c.Client.DownloadFileAsync(document.Reference, OrderDocuments.MaxPdfBytes, ct);
    }

    // A file that couldn't be read is looked up again next time, not taken from what was kept.
    public void Forget(int order)
    {
        lock (_gate)
        {
            _known.Remove(order);
            // The full list may hold the same row: read it again too.
            _all = null;
        }
    }

    CloudDocumentLookup Remember(int order, IReadOnlyList<CloudDocument> parts, DateTimeOffset now)
    {
        lock (_gate)
        {
            _known[order] = (parts, now);
            // Kept small: a viewer looks at the orders of the day.
            if (_known.Count > 500)
                foreach (var old in _known.Where(p => now - p.Value.At > RefreshAfter).Select(p => p.Key).ToList()) _known.Remove(old);
        }
        return Answer(parts);
    }

    static CloudDocumentLookup Answer(IReadOnlyList<CloudDocument> parts) =>
        parts.Count == 0 ? new(CloudDocumentStatus.NotFound) : new(CloudDocumentStatus.Found, parts[0]) { Parts = parts };

    // The newest file of each kind, the list first, then the BS list, then the BS drawings.
    static IReadOnlyList<CloudDocument> Newest(IEnumerable<CloudDocument> documents)
    {
        var newest = new SortedDictionary<OrderDocumentKind, CloudDocument>();
        foreach (var d in documents)
            if (!newest.TryGetValue(d.Kind, out var have) || Newer(d, have)) newest[d.Kind] = d;
        return [.. newest.Values];
    }

    // One full read at a time, shared by every lookup that missed.
    Task<IReadOnlyDictionary<int, IReadOnlyList<CloudDocument>>> AllAsync(OptiCloudClient client, Guid table, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_all is { } all && now - all.At < FullReadEvery) return Task.FromResult(all.Parts);
            if (_reading is { IsCompleted: false } reading) return reading;
            return _reading = ReadAllAsync(client, table, now);
        }
    }

    async Task<IReadOnlyDictionary<int, IReadOnlyList<CloudDocument>>> ReadAllAsync(OptiCloudClient client, Guid table, DateTimeOffset now)
    {
        var ct = CancellationToken.None;
        var found = new Dictionary<int, List<CloudDocument>>();
        for (var p = 1; p <= OrderDocumentUpload.MaxPages; p++)
        {
            var page = await client.GetRowsPagedAsync(table, p, OrderDocumentUpload.PageSize, "FileName", ascending: true, ct: ct);
            foreach (var row in page.Rows)
            {
                if (ToDocument(row) is not { } d) continue;
                if (!found.TryGetValue(d.Order, out var have)) found[d.Order] = have = [];
                have.Add(d);
            }
            if (page.Rows.Count == 0) break;
            if (page.TotalPages is { } total ? p >= total : page.Rows.Count < OrderDocumentUpload.PageSize) break;
        }
        IReadOnlyDictionary<int, IReadOnlyList<CloudDocument>> best = found.ToDictionary(p => p.Key, p => Newest(p.Value));
        lock (_gate) _all = (best, now);
        return best;
    }

    async Task<Guid?> TableAsync(OptiCloudClient client, Guid account, CancellationToken ct)
    {
        lock (_gate) if (_tableId is { } id && _tableAccount == account) return id;
        var tables = await client.GetTablesAsync(account, ct);
        var table = tables.FirstOrDefault(t => string.Equals(t.Name, OrderDocumentUpload.Name, StringComparison.OrdinalIgnoreCase));
        if (table is null) return null;
        lock (_gate) (_tableId, _tableAccount) = (table.Id, account);
        return table.Id;
    }

    static bool Newer(CloudDocument a, CloudDocument b) =>
        OrderDocumentLocator.Ranks(a.Kind, a.Date, b.Kind, b.Date) switch
        {
            > 0 => true,
            < 0 => false,
            _ => (a.Created ?? DateTimeOffset.MinValue) > (b.Created ?? DateTimeOffset.MinValue),
        };

    // A row with a file name that gives an order, and a file. Rows still waiting for their file are skipped.
    public static CloudDocument? ToDocument(CloudRow row)
    {
        if (!row.Values.TryGetValue("FileName", out var name) || string.IsNullOrWhiteSpace(name)) return null;
        name = name.Trim();
        if (!OrderDocumentLocator.TryParseFileName(name, out OrderFileName parsed)) return null;
        row.Values.TryGetValue("File", out var file);
        if (Reference(file) is not { } reference) return null;
        row.Values.TryGetValue("Sha256", out var sha);
        return new CloudDocument(name, parsed.Order, parsed.Date, reference, string.IsNullOrWhiteSpace(sha) ? null : sha.Trim(), row.Created, parsed.Kind);
    }

    // A Blob value reads back as { contentType, name, reference }, all null when the row has no file;
    // a plain string is the reference.
    static string? Reference(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!value.TrimStart().StartsWith('{')) return value.Trim();
        try
        {
            using var doc = JsonDocument.Parse(value);
            return doc.RootElement.Str("reference") is { Length: > 0 } r ? r : null;
        }
        catch (JsonException) { return null; }
    }
}
