namespace Ventisol.Station.Core.Cloud;

// The VentisolScans master-data table in the account: made on first connect, with any
// missing column added, then written to and read from. Safe to use from the sender and the
// poll at once.
public sealed class ScanTable(OptiCloudClient client, Action<string>? log = null)
{
    public const string Name = "VentisolScans";
    public const string FriendlyName = "Ventisol scanninger";
    public const int PageSize = 500;
    public const int MaxPages = 50;

    readonly Lock _gate = new();
    // One at a time: the sender and the poll both asking must not make the table twice.
    readonly SemaphoreSlim _ensuring = new(1, 1);
    Guid? _tableId;
    Guid _accountId;
    bool _unsortedLogged, _cappedLogged, _unknownEventLogged;

    public Guid? TableId { get { lock (_gate) return _tableId; } }

    public Task<Guid> EnsureAsync(Guid accountId, CancellationToken ct = default) => EnsureAsync(accountId, null, ct);

    // stale: an id OptiCloud no longer knows (a 404). It is kept until the table is found or made
    // again, so a failure here leaves something to try with, and nothing ever finds no id at all.
    async Task<Guid> EnsureAsync(Guid accountId, Guid? stale, CancellationToken ct)
    {
        await _ensuring.WaitAsync(ct);
        try
        {
            lock (_gate)
            {
                // Another account: its table is another one. Remembered at once, so a first try
                // that fails can be made again by whoever needs the table next.
                if (_accountId != accountId)
                {
                    _accountId = accountId;
                    _tableId = null;
                }
                // Also when someone else made it again while this one waited.
                if (_tableId is { } known && known != stale) return known;
            }

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

            lock (_gate) if (_accountId == accountId) _tableId = table.Id;
            return table.Id;
        }
        finally { _ensuring.Release(); }
    }

    // The table's id. Not known yet (the first EnsureAsync failed): found or made now.
    async Task<Guid> TableAsync(CancellationToken ct)
    {
        Guid account;
        lock (_gate)
        {
            if (_tableId is { } id) return id;
            account = _accountId;
        }
        if (account == Guid.Empty) throw new InvalidOperationException("Call EnsureAsync first");
        return await EnsureAsync(account, null, ct);
    }

    // A refused row may be a re-send of one that got in (the app stopped between sending and
    // crossing it off): if a row with this ScanId is there, it counts as sent.
    public async Task AddAsync(ScanEvent e, CancellationToken ct = default)
    {
        try { await CreateAsync(e, ct); }
        catch (OptiCloudException x) when (x.IsRejected && TableId is not null)
        {
            if (!await ExistsAsync(e, ct)) throw;
            log?.Invoke($"OptiCloud: scanningen {e.ScanId} var der allerede");
        }
    }

    // A 404 means the table is gone (deleted in OptiCloud): make it again and try once more.
    // If that fails too it is a passing failure, never a reason to give up on the scan.
    async Task CreateAsync(ScanEvent e, CancellationToken ct)
    {
        var table = await TableAsync(ct);
        try
        {
            await client.CreateRowAsync(table, e.ToValues(), ct);
            return;
        }
        catch (OptiCloudException x) when (x.Status == 404)
        {
            log?.Invoke($"OptiCloud: tabellen {Name} findes ikke mere, laves igen");
        }

        Guid account;
        lock (_gate) account = _accountId;
        try { table = await EnsureAsync(account, table, ct); }
        // Whatever OptiCloud has against making the table is not about this scan.
        catch (OptiCloudException x) when (x.IsRejected)
        {
            throw new OptiCloudException(x.Message, x.Status);
        }

        try { await client.CreateRowAsync(table, e.ToValues(), ct); }
        catch (OptiCloudException x) when (x.Status == 404)
        {
            throw new OptiCloudException(x.Message, x.Status);
        }
    }

    // Keyword search first. It may be fuzzy or skip this column, so a match must have the exact
    // ScanId, and without one the rows around the scan's time are read as well.
    public async Task<bool> ExistsAsync(ScanEvent e, CancellationToken ct = default)
    {
        var found = await client.GetRowsPagedAsync(await TableAsync(ct), 1, 20, "ScanTime", ascending: false, keyword: e.ScanId.ToString(), ct: ct);
        if (found.Rows.Any(r => IsScan(r, e.ScanId))) return true;
        return (await ReadSinceAsync(e.At - TimeSpan.FromMinutes(1), ct)).Any(s => s.ScanId == e.ScanId);
    }

    static bool IsScan(CloudRow r, Guid id) => r.Values.TryGetValue("ScanId", out var v) && Guid.TryParse(v, out var g) && g == id;

    // The scans at or after since, oldest first, each once. There is no date filter, so pages are
    // read newest first until the first row older than since (MaxPages at most).
    // If the server ignores the order asked for, the newest rows may be anywhere, and the first
    // MaxPages pages need not hold them. Then the rest is read from the last page backwards: rows
    // mostly lie as they were made, so that is where the newest are. It stops at a row older than
    // since only while every row read backwards was in time order; else it reads on, MaxPages
    // pages at most. With no page count there is no last page to start from: then it reads on
    // from where it was, to the last page or MaxPages more (a server that ignores the page asked
    // for never comes to a last one). Hitting the cap is logged once.
    public async Task<IReadOnlyList<ScanEvent>> ReadSinceAsync(DateTimeOffset since, CancellationToken ct = default)
    {
        var table = await TableAsync(ct);
        var found = new Dictionary<Guid, ScanEvent>();
        var skipped = 0;

        // Keeps a page's scans from since on. First and Last: the times of its first and last
        // scan; Rising and Falling: whether a scan was later, or earlier, than the one before it.
        (DateTimeOffset? First, DateTimeOffset? Last, bool Older, bool Rising, bool Falling) Take(RowsPage result)
        {
            DateTimeOffset? first = null, last = null;
            bool older = false, rising = false, falling = false;
            foreach (var row in result.Rows)
            {
                if (!ScanEvent.TryFromValues(row.Values, out var e)) { skipped++; continue; }
                if (ScanEvent.UnknownEvent(row.Values) is { } unknown) UnknownEvent(unknown);
                if (last is { } p)
                {
                    rising |= e.At > p;
                    falling |= e.At < p;
                }
                first ??= e.At;
                last = e.At;
                if (e.At < since) { older = true; continue; }
                found.TryAdd(e.ScanId, e);
            }
            return (first, last, older, rising, falling);
        }

        Task<RowsPage> PageAsync(int page) => client.GetRowsPagedAsync(table, page, PageSize, "ScanTime", ascending: false, ct: ct);
        static bool IsLast(RowsPage result, int page) =>
            result.Rows.Count == 0 || (result.TotalPages is { } total ? page >= total : result.Rows.Count < PageSize);

        var descending = true;
        var done = false;
        var next = 1;
        int? pages = null;
        DateTimeOffset? previous = null;
        while (descending && !done)
        {
            var result = await PageAsync(next);
            var p = Take(result);
            if (p.Rising || previous is { } before && p.First > before) descending = false;
            previous = p.Last ?? previous;
            pages = result.TotalPages;
            done = descending && p.Older || IsLast(result, next);
            if (descending && !done && next == MaxPages)
            {
                Capped();
                done = true;
            }
            next++;
        }

        if (!done)
        {
            bool tell;
            lock (_gate) (tell, _unsortedLogged) = (!_unsortedLogged, true);
            if (tell) log?.Invoke($"OptiCloud: {Name} kommer ikke sorteret efter tid, så den læses bagfra");

            if (pages is { } last)
            {
                var inOrder = true;
                DateTimeOffset? after = null;
                for (var page = last; page >= next; page--)
                {
                    if (last - page == MaxPages) { Capped(); break; }
                    var p = Take(await PageAsync(page));
                    if (p.Falling || after is { } a && p.Last > a) inOrder = false;
                    after = p.First ?? after;
                    if (inOrder && p.Older) break;
                }
            }
            // No page count to start from the end with: on from here, to the last page.
            else
            {
                for (var page = next; ; page++)
                {
                    if (page - next == MaxPages) { Capped(); break; }
                    var result = await PageAsync(page);
                    Take(result);
                    if (IsLast(result, page)) break;
                }
            }
        }

        if (skipped > 0) log?.Invoke($"OptiCloud: {skipped} rækker i {Name} kunne ikke læses som scanninger");
        return [.. found.Values.OrderBy(e => e.At).ThenBy(e => e.Direction)];

        // Said once: a newer app's Event value, read as an ordinary scan.
        void UnknownEvent(string text)
        {
            bool tell;
            lock (_gate) (tell, _unknownEventLogged) = (!_unknownEventLogged, true);
            if (tell) log?.Invoke($"OptiCloud: ukendt hændelse \"{text}\" i {Name} læses som en scanning");
        }

        // Said once: the poll comes here every few seconds.
        void Capped()
        {
            bool tell;
            lock (_gate) (tell, _cappedLogged) = (!_cappedLogged, true);
            if (tell) log?.Invoke($"OptiCloud: stoppede efter {MaxPages} sider i {Name}, ældre rækker er ikke læst");
        }
    }
}
