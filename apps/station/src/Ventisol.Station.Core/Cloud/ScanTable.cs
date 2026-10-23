namespace Ventisol.Station.Core.Cloud;

// The VentisolScans master-data table in the account: made on first connect, with any
// missing column added, then written to and read from.
public sealed class ScanTable(OptiCloudClient client, Action<string>? log = null)
{
    public const string Name = "VentisolScans";
    public const string FriendlyName = "Ventisol scanninger";
    public const int PageSize = 500;
    public const int MaxPages = 50;

    Guid? _tableId;
    Guid _accountId;

    public Guid? TableId => _tableId;

    public async Task<Guid> EnsureAsync(Guid accountId, CancellationToken ct = default)
    {
        if (_tableId is { } known && _accountId == accountId) return known;

        var tables = await client.GetTablesAsync(accountId, ct);
        var table = tables.FirstOrDefault(t => string.Equals(t.Name, Name, StringComparison.OrdinalIgnoreCase));
        if (table is null)
        {
            table = await client.CreateTableAsync(accountId, Name, FriendlyName, "Scan ind og ud på Ventisols stationer. Skrives af MES-skærmen.", ct);
            log?.Invoke($"OptiCloud: tabellen {Name} er oprettet");
        }

        var have = (await client.GetColumnsAsync(table.Id, ct)).Select(c => c.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var c in ScanEvent.Columns.Where(c => !have.Contains(c.Name)))
        {
            await client.AddColumnAsync(table.Id, c, ct);
            log?.Invoke($"OptiCloud: kolonnen {c.Name} er tilføjet til {Name}");
        }

        _accountId = accountId;
        _tableId = table.Id;
        return table.Id;
    }

    public Task AddAsync(ScanEvent e, CancellationToken ct = default) => client.CreateRowAsync(Table, e.ToValues(), ct);

    // The scans at or after since, oldest first, each once. There is no date filter, so pages are
    // read newest first until the first row older than since. If the server ignores the order,
    // every page is read (up to MaxPages).
    public async Task<IReadOnlyList<ScanEvent>> ReadSinceAsync(DateTimeOffset since, CancellationToken ct = default)
    {
        var table = Table;
        var found = new Dictionary<Guid, ScanEvent>();
        var descending = true;
        DateTimeOffset? previous = null;
        var skipped = 0;

        for (var page = 1; page <= MaxPages; page++)
        {
            var result = await client.GetRowsPagedAsync(table, page, PageSize, "ScanTime", ascending: false, ct);
            var reachedOlder = false;
            foreach (var row in result.Rows)
            {
                if (!ScanEvent.TryFromValues(row.Values, out var e)) { skipped++; continue; }
                if (previous is { } p && e.At > p) descending = false;
                previous = e.At;
                if (e.At < since) { reachedOlder = true; continue; }
                found.TryAdd(e.ScanId, e);
            }

            if (descending && reachedOlder) break;
            if (result.Rows.Count == 0) break;
            if (result.TotalPages is { } total ? page >= total : result.Rows.Count < PageSize) break;
            if (page == MaxPages) log?.Invoke($"OptiCloud: stoppede efter {MaxPages} sider i {Name}");
        }

        if (skipped > 0) log?.Invoke($"OptiCloud: {skipped} rækker i {Name} kunne ikke læses som scanninger");
        return [.. found.Values.OrderBy(e => e.At).ThenBy(e => e.Direction)];
    }

    Guid Table => _tableId ?? throw new InvalidOperationException("Call EnsureAsync first");
}
