using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.Core.Cloud;

// Puts the order PDFs of the documents folder in OptiCloud: the list VentisolOrderDocuments, one row
// per file name with the file in a Blob column, so the web and tablets can show them. Made on first
// use, with any missing column added.
// Every Interval the folder is listed (by the locator) and each order document not in the list yet is
// uploaded, newest first: those printed in the last MaxAge, and written at least Settled ago, so a file
// 3E is still writing is left for the next round. Nothing is asked of OptiCloud while every such file
// is known to be there.
// Several PCs see the same folder. The unique FileName decides between them: the row is made first,
// without the file, and only the PC whose row got in uploads. A PC that finds another at work ends
// its round and looks again after Interval. A row left without a file (the PC stopped, or the upload
// failed) is finished by the PC named in its Device column, or by any PC once its ClaimedAt is
// TakeOverAfter old: that PC writes its own name and the time, waits a little, and goes on only if the
// row still names it.
// A file stored but never put in a row can't be deleted from OptiCloud, hence the order of things;
// one stored whose row then could not be updated is remembered (on disk too) and used on the next try.
// A file OptiCloud refuses RefusalsBeforeAside times, or that isn't a whole PDF, or is bigger than
// OrderDocuments.MaxPdfBytes (never read), is left alone until it is written again, so one bad file
// never holds up the others or is read every round.
// An upload that fails without OptiCloud refusing it (no answer, a broken connection, a 500) may
// have stored the file all the same, and every new try may store it once more: after
// MaxUploadTries such tries the file is left alone too, until it is written again or the app starts.
// Not handled: a file that changes under the same name keeps its first upload.
public sealed class OrderDocumentUpload
{
    public const string Name = "VentisolOrderDocuments";
    public const string FriendlyName = "Ventisol ordredokumenter";
    public const int PageSize = 500;
    public const int MaxPages = 50;
    public const int MaxUploadTries = 5;

    public static readonly IReadOnlyList<ColumnSpec> Columns =
    [
        new("FileName", "Filnavn", ColumnType.String, IsRequired: true, IsUnique: true, IsKey: true),
        new("OrderNo", "Ordre", ColumnType.Int),
        new("Prefix", "Præfiks", ColumnType.String),
        new("PrintDate", "Udskriftsdato", ColumnType.DateTime),
        new("File", "Fil", ColumnType.Blob),
        new("SizeBytes", "Størrelse (bytes)", ColumnType.Int),
        new("Sha256", "SHA-256", ColumnType.String),
        new("Device", "Enhed", ColumnType.String),
        new("ClaimedAt", "Taget", ColumnType.DateTime),
    ];

    enum Outcome { Done, Skipped, Lost }

    sealed record Row(Guid? Id, string FileName, bool HasFile, string Device, DateTimeOffset? Claimed);

    sealed record Candidate(string Name, OrderDocumentLocator.Entry Entry);

    sealed record Kept(string Name, string ContentType, string Reference, string Sha);

    readonly OptiCloudClient _client;
    readonly OrderDocumentLocator _locator;
    readonly Guid _accountId;
    readonly Action<string> _log;
    readonly string _device;
    readonly Func<DateTimeOffset> _clock;
    readonly Func<TimeSpan, CancellationToken, Task> _delay;
    readonly Func<string, byte[]> _readFile;
    readonly Func<double> _random;
    readonly string? _statePath;
    // File names known to be in the list with their file.
    readonly HashSet<string> _done = new(StringComparer.OrdinalIgnoreCase);
    // A file stored whose row could not be given it: used again, not stored a second time.
    readonly Dictionary<string, Kept> _stored = new(StringComparer.OrdinalIgnoreCase);
    // Files left alone until they are written again (by write time): not a whole PDF, refused, unreadable.
    readonly Dictionary<string, DateTime> _skip = new(StringComparer.OrdinalIgnoreCase);
    // Those of them that only could not be read: tried again now and then.
    readonly HashSet<string> _unread = new(StringComparer.OrdinalIgnoreCase);
    readonly Dictionary<string, (DateTime Written, int Count)> _refused = new(StringComparer.OrdinalIgnoreCase);
    // Uploads of a file (by its content) that failed with no refusal, in a row.
    readonly Dictionary<string, (string Sha, int Count)> _tries = new(StringComparer.OrdinalIgnoreCase);
    Guid? _tableId;
    string? _problem;
    int _rounds;

    // statePath: a file on this PC that remembers a file stored whose row is still to be updated, over a restart.
    public OrderDocumentUpload(OptiCloudClient client, OrderDocumentLocator locator, Guid accountId, Action<string> log, string? device = null,
        Func<DateTimeOffset>? clock = null, Func<TimeSpan, CancellationToken, Task>? delay = null, Func<string, byte[]>? readFile = null, Func<double>? random = null,
        string? statePath = null)
    {
        _client = client;
        _locator = locator;
        _accountId = accountId;
        _log = log;
        _device = device ?? Environment.MachineName;
        _clock = clock ?? (() => DateTimeOffset.Now);
        _delay = delay ?? Task.Delay;
        _readFile = readFile ?? OrderDocuments.ReadPdf;
        _random = random ?? Random.Shared.NextDouble;
        _statePath = statePath;
        LoadStored();
    }

    public TimeSpan Interval { get; init; } = TimeSpan.FromMinutes(5);
    public TimeSpan StartDelay { get; init; } = TimeSpan.FromSeconds(30);
    // Only files printed (the date in the name, else the write time) this long ago or less.
    public TimeSpan MaxAge { get; init; } = TimeSpan.FromDays(60);
    public TimeSpan Settled { get; init; } = TimeSpan.FromMinutes(2);
    public TimeSpan ReadTimeout { get; init; } = TimeSpan.FromSeconds(15);
    public TimeSpan TakeOverAfter { get; init; } = TimeSpan.FromHours(1);
    public TimeSpan Pause { get; init; } = TimeSpan.FromSeconds(1);
    // A file that could not be read is tried again every this many rounds.
    public int RereadEvery { get; init; } = 12;
    // After a wrong password. The scans' own loops try it every Outbox.LoginBackoff already, and
    // every try counts towards locking the user out, so this one adds few.
    public static readonly TimeSpan LoginWait = TimeSpan.FromHours(1);

    // Runs until cancelled. A failure is logged once and tried again after Interval.
    public async Task RunAsync(CancellationToken ct)
    {
        await _delay(StartDelay + Jitter(TimeSpan.FromMinutes(1)), ct);
        while (true)
        {
            var wait = Interval;
            try
            {
                await SyncOnceAsync(ct);
                Problem(null);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (OptiCloudException x)
            {
                Problem(x.Message);
                if (x.IsBadLogin) wait = LoginWait;
            }
            catch (TimeoutException) { Problem("mappen svarer ikke"); }
            // Whatever it is, the loop goes on: a stopped loop would only show in the log.
            catch (Exception x) { Problem(x.Message); }
            await _delay(wait + Jitter(TimeSpan.FromMinutes(1)), ct);
        }
    }

    // One round. Gives how many files were put in the list. Throws when the folder or OptiCloud can't be reached.
    public async Task<int> SyncOnceAsync(CancellationToken ct = default)
    {
        if (_locator.Folder is null) return 0;
        if (++_rounds % RereadEvery == 0)
        {
            foreach (var name in _unread) _skip.Remove(name);
            _unread.Clear();
        }

        var now = _clock();
        var files = Candidates(await ListAsync(now, ct), now);
        if (files.All(f => _done.Contains(f.Name))) return 0;

        try
        {
            var table = await EnsureAsync(ct);
            var rows = await ReadRowsAsync(table, ct);
            foreach (var r in rows.Values.Where(r => r.HasFile)) _done.Add(r.FileName);

            var uploaded = 0;
            var unreadable = 0;
            foreach (var f in files)
            {
                if (_done.Contains(f.Name)) continue;
                rows.TryGetValue(f.Name, out var row);
                // Another PC made (or took) the row a while ago at most and is at it.
                if (row is not null && !Mine(row) && Fresh(row)) continue;
                // Without the row's id it can't be given its file.
                if (row is { Id: null }) { Skip(f); continue; }

                var bytes = await ReadAsync(f, ct);
                if (bytes is null)
                {
                    // The folder itself seems gone: no point in asking for every file.
                    if (_unread.Contains(f.Name) && ++unreadable >= 3) break;
                    continue;
                }
                unreadable = 0;

                Outcome outcome;
                try
                {
                    outcome = row is null ? await NewAsync(table, f, bytes, ct)
                        : Mine(row) ? await AttachAsync(table, row.Id!.Value, f.Name, bytes, ct)
                        : await TakeOverAsync(table, row, f, bytes, ct);
                }
                catch (OptiCloudException x) when (x.IsRejected && x.Status != 404)
                {
                    // OptiCloud won't take this file as it is: the others still go up.
                    Refused(f, x);
                    continue;
                }
                catch (OptiCloudException x) when (!x.IsRejected && _tries.TryGetValue(f.Name, out var tried) && tried.Count >= MaxUploadTries)
                {
                    // Each try may have left a file in OptiCloud that no row points to: no more of them.
                    Skip(f);
                    _tries.Remove(f.Name);
                    _log($"Ordredokumenter: {f.Name} kunne ikke lægges op i {tried.Count} forsøg ({x.Message}) og prøves ikke igen");
                    continue;
                }
                if (outcome == Outcome.Lost) break;
                _refused.Remove(f.Name);
                if (outcome == Outcome.Done) uploaded++;
                await _delay(Pause, ct);
            }
            return uploaded;
        }
        catch (OptiCloudException x) when (x.Status == 404)
        {
            // The list (or a row) is gone in OptiCloud: start over next round, making it again.
            _tableId = null;
            _done.Clear();
            throw;
        }
    }

    // The files in the folder. A listing the scans made less than Interval ago is used as it is, so the
    // share isn't listed more than needed. A listing that doesn't come in time answers from the last one
    // if that is recent: on a slow share the listing goes on in the background and is there next round.
    async Task<IReadOnlyList<OrderDocumentLocator.Entry>> ListAsync(DateTimeOffset now, CancellationToken ct)
    {
        // A listing from "after now" (the PC's clock was set back) counts as old.
        bool Within(TimeSpan age) => _locator.IndexedAt is { } at && now.ToUniversalTime() - at is var old && old >= TimeSpan.Zero && old <= age;
        if (!Within(Interval))
        {
            var status = _locator.IsDown ? null : await _locator.RefreshAsync(ct);
            if (status is not { Available: true } && !Within(Interval * 2))
                throw new IOException(status?.Error ?? _locator.LastError ?? "Mappen kan ikke læses");
        }
        return _locator.IndexedFiles ?? [];
    }

    bool Mine(Row row) => string.Equals(row.Device, _device, StringComparison.OrdinalIgnoreCase);

    // Whether the row was made or taken less than TakeOverAfter ago, by OptiCloud's clock.
    bool Fresh(Row row) => row.Claimed is { } at && CloudNow() - at <= TakeOverAfter;

    // Now as OptiCloud has it: PCs with a clock that is off still agree on how old a row is.
    DateTimeOffset CloudNow() => _clock().ToUniversalTime() - (_client.ClockSkew ?? TimeSpan.Zero);

    // One per file name (the newest written, when two folders hold the same name), newest print first.
    List<Candidate> Candidates(IReadOnlyList<OrderDocumentLocator.Entry> entries, DateTimeOffset now)
    {
        var oldest = now.UtcDateTime - MaxAge;
        var settled = now.UtcDateTime - Settled;
        return [.. entries
            .Where(e => e.WriteTimeUtc <= settled && (e.Date is { } d ? d.ToDateTime(TimeOnly.MaxValue) : e.WriteTimeUtc) >= oldest)
            .GroupBy(e => Path.GetFileName(e.Path), StringComparer.OrdinalIgnoreCase)
            .Select(g => new Candidate(g.Key, g.MaxBy(e => e.WriteTimeUtc)!))
            .Where(c => !(_skip.TryGetValue(c.Name, out var written) && written == c.Entry.WriteTimeUtc))
            .OrderByDescending(c => c.Entry.Date ?? DateOnly.FromDateTime(c.Entry.WriteTimeUtc))
            .ThenByDescending(c => c.Entry.WriteTimeUtc)
            .ThenBy(c => c.Name, StringComparer.OrdinalIgnoreCase)];
    }

    void Skip(Candidate f) => _skip[f.Name] = f.Entry.WriteTimeUtc;

    // The file's bytes, or null when it isn't there to read or isn't a whole PDF: left alone then
    // until it is written again (one that could not be read also every RereadEvery rounds).
    // A read that hangs throws TimeoutException: the share is slow or gone, so the round ends.
    async Task<byte[]?> ReadAsync(Candidate f, CancellationToken ct)
    {
        byte[] bytes;
        try { bytes = await Task.Run(() => _readFile(f.Entry.Path), CancellationToken.None).WaitAsync(ReadTimeout, ct); }
        catch (OrderDocumentTooLargeException x)
        {
            // Not one of 3E's order documents, whatever its name: not read again until it is written again.
            Skip(f);
            _log($"Ordredokumenter: {x.Message}, lægges ikke op");
            return null;
        }
        catch (Exception x) when (x is IOException or UnauthorizedAccessException)
        {
            Skip(f);
            _unread.Add(f.Name);
            return null;
        }

        if (IsWholePdf(bytes)) return bytes;
        Skip(f);
        _log($"Ordredokumenter: {f.Name} ligner ikke en færdig PDF og lægges ikke op");
        return null;
    }

    // Starts as a PDF and ends as one: a file cut short (still being written, a copy that broke) has no end mark.
    public static bool IsWholePdf(byte[] bytes)
    {
        if (bytes.Length < 16 || !bytes.AsSpan(0, 5).SequenceEqual("%PDF-"u8)) return false;
        return bytes.AsSpan(Math.Max(0, bytes.Length - 1024)).IndexOf("%%EOF"u8) >= 0;
    }

    // One refusal may be a passing fault: the file is tried again next round, and left alone after
    // Outbox.RefusalsBeforeAside in a row.
    void Refused(Candidate f, OptiCloudException x)
    {
        var count = _refused.TryGetValue(f.Name, out var before) && before.Written == f.Entry.WriteTimeUtc ? before.Count + 1 : 1;
        _refused[f.Name] = (f.Entry.WriteTimeUtc, count);
        if (count == 1) _log($"Ordredokumenter: {f.Name} blev afvist af OptiCloud: {x.Message}");
        if (count < Outbox.RefusalsBeforeAside) return;
        Skip(f);
        _refused.Remove(f.Name);
        _log($"Ordredokumenter: {f.Name} er afvist {count} gange og lægges ikke op");
    }

    async Task<Outcome> NewAsync(Guid table, Candidate f, byte[] bytes, CancellationToken ct)
    {
        Guid? id;
        try { id = await _client.CreateRowAsync(table, Describe(f, bytes), ct); }
        catch (OptiCloudException x) when (x.IsRejected && x.Status != 404)
        {
            // Refused because the name is there already? Then another PC got in first.
            if (await FindAsync(table, f.Name, ct) is not { } theirs) throw;
            if (!theirs.HasFile) return Outcome.Lost;
            // It even has its file: nothing to do, and no other PC is at work.
            _done.Add(f.Name);
            return Outcome.Skipped;
        }
        id ??= (await FindAsync(table, f.Name, ct))?.Id ?? throw new OptiCloudException(OptiCloudException.Unexpected);
        return await AttachAsync(table, id.Value, f.Name, bytes, ct);
    }

    // Takes a row another PC left without its file. Two PCs may try at once: each looks at the row
    // again, writes its name and the time, waits a little (not the same for both) and goes on only
    // if the row still names it. The new time keeps the others off it for TakeOverAfter.
    async Task<Outcome> TakeOverAsync(Guid table, Row row, Candidate f, byte[] bytes, CancellationToken ct)
    {
        var id = row.Id!.Value;
        if (ToRow(await _client.GetRowAsync(id, ct)) is not { } before) return Outcome.Skipped;
        if (before.HasFile) { _done.Add(f.Name); return Outcome.Skipped; }
        if (!Mine(before) && Fresh(before)) return Outcome.Skipped;

        await _client.UpdateRowAsync(id, new Dictionary<string, object?> { ["Device"] = _device, ["ClaimedAt"] = Stamp(CloudNow()) }, ct);
        await _delay(TimeSpan.FromSeconds(2) + Jitter(TimeSpan.FromSeconds(8)), ct);
        var again = ToRow(await _client.GetRowAsync(id, ct));
        if (again is null || again.HasFile || !Mine(again)) return Outcome.Lost;
        _log($"Ordredokumenter: {f.Name} manglede sin fil (fra {(row.Device.Length > 0 ? row.Device : "en anden PC")}), lægges op herfra");
        return await AttachAsync(table, id, f.Name, bytes, ct);
    }

    async Task<Outcome> AttachAsync(Guid table, Guid rowId, string name, byte[] bytes, CancellationToken ct)
    {
        var sha = Sha(bytes);
        if (!_stored.TryGetValue(name, out var kept) || kept.Sha != sha)
        {
            CloudFile file;
            try { file = await _client.UploadFileAsync(table, name, bytes, "application/pdf", ct); }
            catch (OptiCloudException x) when (!x.IsRejected && !x.IsAuth)
            {
                // The file may be stored though the answer never came: counted, see MaxUploadTries.
                _tries[name] = (sha, _tries.TryGetValue(name, out var before) && before.Sha == sha ? before.Count + 1 : 1);
                throw;
            }
            _tries.Remove(name);
            kept = new Kept(file.Name, file.ContentType, file.Reference, sha);
            _stored[name] = kept;
            SaveStored();
        }
        await _client.UpdateRowAsync(rowId, new Dictionary<string, object?>
        {
            ["File"] = new { name = kept.Name, contentType = kept.ContentType, reference = kept.Reference },
            ["SizeBytes"] = bytes.Length,
            ["Sha256"] = sha,
        }, ct);
        _stored.Remove(name);
        SaveStored();
        _done.Add(name);
        _log($"Ordredokumenter: {name} er lagt i OptiCloud");
        return Outcome.Done;
    }

    static string Sha(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    static string Stamp(DateTimeOffset at) => at.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    // Everything but the file itself, so a value OptiCloud won't take is refused before anything is stored.
    Dictionary<string, object?> Describe(Candidate f, byte[] bytes)
    {
        // The prefix and the BS label, "BE", "BS", "BE_BS tegninger" ... The web reads the kind from the file name.
        OrderDocumentLocator.TryParseFileName(f.Name, out OrderFileName name);
        var prefix = string.Join('_', new[] { name.Prefix, name.KindLabel }.Where(p => p.Length > 0));
        var values = new Dictionary<string, object?>
        {
            ["FileName"] = f.Name,
            ["OrderNo"] = f.Entry.Order,
            ["Prefix"] = prefix,
            ["SizeBytes"] = bytes.Length,
            ["Sha256"] = Sha(bytes),
            ["Device"] = _device,
            ["ClaimedAt"] = Stamp(CloudNow()),
        };
        // Left out when the name has no date, not sent as null.
        if (f.Entry.Date is { } d) values["PrintDate"] = d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) + "T00:00:00Z";
        return values;
    }

    void LoadStored()
    {
        if (_statePath is null) return;
        try
        {
            if (!File.Exists(_statePath)) return;
            foreach (var k in JsonSerializer.Deserialize<List<Kept>>(File.ReadAllText(_statePath)) ?? [])
                if (k is { Name.Length: > 0, Reference.Length: > 0, Sha.Length: > 0 }) _stored[k.Name] = k;
        }
        catch (Exception x) when (x is IOException or UnauthorizedAccessException or JsonException or NullReferenceException) { }
    }

    // A failed save only means a restart right now would store that one file again.
    void SaveStored()
    {
        if (_statePath is null) return;
        try
        {
            if (_stored.Count == 0) { File.Delete(_statePath); return; }
            Directory.CreateDirectory(Path.GetDirectoryName(_statePath)!);
            var temp = _statePath + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(_stored.Values.ToList()));
            File.Move(temp, _statePath, overwrite: true);
        }
        catch (Exception x) when (x is IOException or UnauthorizedAccessException) { }
    }

    public async Task<Guid> EnsureAsync(CancellationToken ct = default)
    {
        if (_tableId is { } known) return known;

        var tables = await _client.GetTablesAsync(_accountId, ct);
        var table = tables.FirstOrDefault(t => string.Equals(t.Name, Name, StringComparison.OrdinalIgnoreCase));
        if (table is null)
        {
            table = await _client.CreateTableAsync(_accountId, Name, FriendlyName, "Produktionslister (PDF) fra 3E, en række pr. fil. Lægges op af MES-skærmen.", ct);
            _log($"OptiCloud: tabellen {Name} er oprettet");
        }

        var have = (await _client.GetColumnsAsync(table.Id, ct)).Select(c => c.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var c in Columns.Where(c => !have.Contains(c.Name)))
        {
            await _client.AddColumnAsync(table.Id, c, ct);
            _log($"OptiCloud: kolonnen {c.Name} er tilføjet til {Name}");
        }

        _tableId = table.Id;
        return table.Id;
    }

    async Task<Dictionary<string, Row>> ReadRowsAsync(Guid table, CancellationToken ct)
    {
        var rows = new Dictionary<string, Row>(StringComparer.OrdinalIgnoreCase);
        for (var page = 1; page <= MaxPages; page++)
        {
            var result = await _client.GetRowsPagedAsync(table, page, PageSize, "FileName", ascending: true, ct: ct);
            foreach (var r in result.Rows)
                if (ToRow(r) is { } row && (!rows.TryGetValue(row.FileName, out var have) || row.HasFile && !have.HasFile)) rows[row.FileName] = row;

            if (result.Rows.Count == 0) break;
            if (result.TotalPages is { } total ? page >= total : result.Rows.Count < PageSize) break;
            if (page == MaxPages) _log($"OptiCloud: stoppede efter {MaxPages} sider i {Name}");
        }
        return rows;
    }

    // The row with that file name. The keyword search first; it may be fuzzy, so the name must match,
    // and when it finds nothing the whole list is read.
    async Task<Row?> FindAsync(Guid table, string name, CancellationToken ct)
    {
        var found = await _client.GetRowsPagedAsync(table, 1, 20, "FileName", ascending: true, keyword: name, ct: ct);
        var hit = found.Rows.Select(ToRow).FirstOrDefault(r => r is not null && string.Equals(r.FileName, name, StringComparison.OrdinalIgnoreCase));
        return hit ?? (await ReadRowsAsync(table, ct)).GetValueOrDefault(name);
    }

    static Row? ToRow(CloudRow r)
    {
        if (!r.Values.TryGetValue("FileName", out var name) || string.IsNullOrWhiteSpace(name)) return null;
        r.Values.TryGetValue("File", out var file);
        r.Values.TryGetValue("Device", out var device);
        r.Values.TryGetValue("ClaimedAt", out var claimed);
        // Rows from before the ClaimedAt column count from when they were made.
        DateTimeOffset? at = DateTimeOffset.TryParse(claimed, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var c) ? c : r.Created;
        return new Row(r.Id, name.Trim(), HasReference(file), device?.Trim() ?? "", at);
    }

    // A Blob value reads back as { contentType, name, reference }, all null when the row has no file.
    static bool HasReference(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (!value.TrimStart().StartsWith('{')) return true;
        try
        {
            using var doc = JsonDocument.Parse(value);
            return doc.RootElement.Str("reference") is { Length: > 0 };
        }
        catch (JsonException) { return false; }
    }

    TimeSpan Jitter(TimeSpan most) => most * _random();

    // The same failure on every round is logged once, until a round works again.
    void Problem(string? message)
    {
        if (message == _problem) return;
        _problem = message;
        _log(message is null ? "Ordredokumenter: lægges op til OptiCloud igen" : $"Ordredokumenter: kan ikke lægges op til OptiCloud: {message}");
    }
}
