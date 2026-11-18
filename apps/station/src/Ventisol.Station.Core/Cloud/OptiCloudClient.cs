using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.Core.Cloud;

public sealed record CloudUser(Guid Id, string Email, string Name, Guid AccountId, string AccountName, string PermissionName);

public sealed record CloudMachine(Guid Id, string Name);

public sealed record CloudTable(Guid Id, string Name, string? FriendlyName);

// The numbers are OptiCloud's MasterDataColumnType.
// Link holds { name, url }, Blob a file: { name, contentType, reference } as UploadFileAsync gives it.
public enum ColumnType { String = 0, Decimal = 1, Int = 2, DateTime = 3, Bool = 4, Long = 5, Lookup = 6, Link = 7, Blob = 8 }

public sealed record CloudColumn(Guid Id, string Name, ColumnType? Type);

public sealed record ColumnSpec(string Name, string FriendlyName, ColumnType Type, bool IsRequired = false, bool IsUnique = false, bool IsKey = false);

// Values keyed by column name, case-insensitively (the API may camelCase them), as text.
public sealed record CloudRow(Guid? Id, DateTimeOffset? Created, IReadOnlyDictionary<string, string?> Values);

// A file kept in OptiCloud's storage for a list. Reference is its path there.
public sealed record CloudFile(string Name, string ContentType, string Reference);

public sealed record RowsPage(IReadOnlyList<CloudRow> Rows, int? Count, int? TotalPages, int Page);

// The OptiPeople API, the few calls the station needs. Logs in on first use and keeps the
// token fresh: on a 401 it refreshes once (one refresh for all callers at a time) and tries
// again once; when the refresh fails it logs in with the password. Never logs anything, so
// the password and tokens can't end up in a log. Every failure is an OptiCloudException.
// A password OptiCloud turned down is not sent again for Outbox.LoginBackoff, whoever asks: every
// caller gets the same failure back (with RetryAfter) without the server hearing of it, so the
// loops using one client make one login between them, not one each. A new password means a new
// client (CloudSync makes one per settings), which starts afresh.
public sealed class OptiCloudClient : IDisposable, IMachineOrderApi
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan UploadTimeout = TimeSpan.FromSeconds(60);

    readonly HttpClient _http;
    readonly bool _ownsHttp;
    readonly string _username, _password;
    readonly SemaphoreSlim _auth = new(1, 1);
    volatile string? _token;
    string? _refreshToken;
    // When the token runs out, as UTC ticks; 0: not known. Read outside _auth, so not a struct.
    long _expiresTicks;
    // The wrong password's failure and when it came (on Clock). Under _auth.
    OptiCloudException? _badLogin;
    DateTimeOffset _badLoginAt;

    public OptiCloudClient(string baseUrl, string username, string password, HttpMessageHandler? handler = null)
        : this(new HttpClient(handler ?? new HttpClientHandler(), disposeHandler: handler is null) { BaseAddress = BaseUri(baseUrl), Timeout = System.Threading.Timeout.InfiniteTimeSpan },
               username, password, ownsHttp: true) { }

    public OptiCloudClient(HttpClient http, string username, string password, bool ownsHttp = false)
    {
        _http = http;
        _ownsHttp = ownsHttp;
        _username = username;
        _password = password;
    }

    static Uri BaseUri(string baseUrl) => new((string.IsNullOrWhiteSpace(baseUrl) ? StationSettings.DefaultApiBaseUrl : baseUrl.Trim()).TrimEnd('/') + "/");

    public bool IsLoggedIn => _token is not null;

    // Times the wait after a wrong password. Monotonic unless given: the PC's clock may be set.
    public Func<DateTimeOffset> Clock { get; init; } = Monotonic();

    static Func<DateTimeOffset> Monotonic()
    {
        var start = DateTimeOffset.UtcNow;
        var ticks = System.Diagnostics.Stopwatch.GetTimestamp();
        return () => start + System.Diagnostics.Stopwatch.GetElapsedTime(ticks);
    }

    // How far the PC's clock is ahead of OptiCloud's (negative: behind), from the Date header of
    // the last answer that had one; null before. To a second or so: the header has whole seconds.
    public TimeSpan? ClockSkew
    {
        get { var t = Interlocked.Read(ref _skewTicks); return t == long.MinValue ? null : TimeSpan.FromTicks(t); }
    }

    long _skewTicks = long.MinValue;

    public async Task LoginAsync(CancellationToken ct = default)
    {
        await _auth.WaitAsync(ct);
        try { await PasswordLoginAsync(ct); }
        finally { _auth.Release(); }
    }

    public async Task<CloudUser> GetCurrentUserAsync(CancellationToken ct = default)
    {
        var d = await GetAsync("api/User/GetCurrentUser", ct);
        return new CloudUser(
            d.Guid("id") ?? Guid.Empty,
            d.Str("email") ?? "",
            d.Str("name") ?? "",
            d.Guid("accountId") ?? throw new OptiCloudException("Brugeren hører ikke til en konto i OptiCloud"),
            d.Str("accountName") ?? "",
            d.Str("permissionName") ?? "");
    }

    public async Task<IReadOnlyList<CloudMachine>> GetMachinesAsync(Guid accountId, CancellationToken ct = default)
    {
        var d = await GetAsync($"api/Machine/GetByAccountId/{accountId}", ct);
        return [.. JsonRead.List(d).Where(m => m.Guid("id") is not null).Select(m => new CloudMachine(m.Guid("id")!.Value, m.Str("name") ?? ""))];
    }

    public async Task<IReadOnlyList<CloudTable>> GetTablesAsync(Guid accountId, CancellationToken ct = default)
    {
        var d = await GetAsync($"api/MasterData/GetTables/{accountId}", ct);
        return [.. JsonRead.List(d).Select(Table).OfType<CloudTable>()];
    }

    public async Task<CloudTable> CreateTableAsync(Guid accountId, string name, string friendlyName, string description, CancellationToken ct = default)
    {
        var d = await SendAsync(HttpMethod.Post, $"api/MasterData/CreateTable/{accountId}", new { name, friendlyName, description }, ct);
        return Table(d) ?? throw new OptiCloudException(OptiCloudException.Unexpected);
    }

    public async Task<IReadOnlyList<CloudColumn>> GetColumnsAsync(Guid tableId, CancellationToken ct = default)
    {
        var d = await GetAsync($"api/MasterData/GetColumns/{tableId}", ct);
        return [.. JsonRead.List(d).Where(c => c.Str("name") is { Length: > 0 })
            .Select(c => new CloudColumn(c.Guid("id") ?? Guid.Empty, c.Str("name")!, Type(c.Str("dataType"))))];
    }

    public Task AddColumnAsync(Guid tableId, ColumnSpec c, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, $"api/MasterData/AddColumn/{tableId}",
            new { name = c.Name, friendlyName = c.FriendlyName, dataType = (int)c.Type, isRequired = c.IsRequired, isUnique = c.IsUnique, isKey = c.IsKey }, ct);

    // The new row's id, when the answer has one.
    public async Task<Guid?> CreateRowAsync(Guid tableId, IReadOnlyDictionary<string, object?> values, CancellationToken ct = default)
    {
        var d = await SendAsync(HttpMethod.Post, $"api/MasterData/CreateRow/{tableId}", new { values }, ct);
        return d.ValueKind == JsonValueKind.Object ? d.Guid("id") : null;
    }

    // Changes the values given and leaves the row's other values as they are.
    public Task UpdateRowAsync(Guid rowId, IReadOnlyDictionary<string, object?> values, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Put, $"api/MasterData/UpdateRow/{rowId}", new { values }, ct);

    public async Task<CloudRow> GetRowAsync(Guid rowId, CancellationToken ct = default) =>
        Row(await GetAsync($"api/MasterData/GetRow/{rowId}", ct));

    // Stores a file for the list. It makes no row: put the answer in a Blob column of one, at once.
    // A file no row points to stays in OptiCloud's storage and can't be deleted from here.
    public async Task<CloudFile> UploadFileAsync(Guid tableId, string fileName, byte[] bytes, string contentType, CancellationToken ct = default)
    {
        var d = await SendAsync(HttpMethod.Post, $"api/MasterDataBlob/Upload/{tableId}", () =>
        {
            var part = new ByteArrayContent(bytes);
            part.Headers.ContentType = new MediaTypeHeaderValue(contentType);
            return new MultipartFormDataContent { { part, "file", fileName } };
        }, UploadTimeout, ct);
        if (d.ValueKind != JsonValueKind.Object || d.Str("reference") is not { Length: > 0 } reference) throw new OptiCloudException(OptiCloudException.Unexpected);
        return new CloudFile(d.Str("name") is { Length: > 0 } n ? n : fileName, d.Str("contentType") is { Length: > 0 } c ? c : contentType, reference);
    }

    // A file stored for a list (the reference from a Blob column), as bytes. At most maxBytes: a
    // bigger answer is not read whole into memory (OrderDocumentTooLargeException). Needs the bearer token.
    public async Task<byte[]> DownloadFileAsync(string reference, long maxBytes, CancellationToken ct = default)
    {
        await EnsureTokenAsync(ct);
        var used = _token;
        var (status, bytes) = await RawBytesAsync(reference, used, maxBytes, ct);
        if (status == 401)
        {
            await RenewAsync(used, ct);
            (status, bytes) = await RawBytesAsync(reference, _token, maxBytes, ct);
        }
        if (status is >= 200 and < 300 && bytes is not null) return bytes;
        if (status == 404) throw new OptiCloudException("Filen findes ikke i OptiCloud", status, rejected: true);
        throw StatusError(status);
    }

    async Task<(int Status, byte[]? Bytes)> RawBytesAsync(string reference, string? token, long maxBytes, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(UploadTimeout);
        using var request = new HttpRequestMessage(HttpMethod.Get, $"api/MasterDataBlob/Get?path={Uri.EscapeDataString(reference)}");
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        try
        {
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            var status = (int)response.StatusCode;
            if (status is < 200 or >= 300) return (status, null);
            if (response.Content.Headers.ContentLength is { } length && length > maxBytes)
                throw new OrderDocumentTooLargeException(reference, length);
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            using var memory = new MemoryStream();
            var buffer = new byte[81920];
            int read;
            while ((read = await stream.ReadAsync(buffer, timeout.Token)) > 0)
            {
                if (memory.Length + read > maxBytes) throw new OrderDocumentTooLargeException(reference, memory.Length + read);
                memory.Write(buffer, 0, read);
            }
            return (status, memory.ToArray());
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new OptiCloudException(OptiCloudException.Unreachable + " (intet svar)");
        }
        // A connection lost while the body is read.
        catch (Exception x) when (x is HttpRequestException or IOException and not OrderDocumentTooLargeException)
        {
            throw new OptiCloudException(OptiCloudException.Unreachable);
        }
    }

    // The machine's current order ("" for none). None comes two ways: a machine never given an
    // order has all-zero ids and number null; a cleared one runs a hidden default order
    // (isDefaultPartInfo true, number ""). Both are objects: an answer with no data at all says
    // nothing about the machine and comes back as null (not known). Reading it as "no order" would
    // end the element at its station; failing on it could keep an order from ever being set
    // (see MachineOrders for what is done with it).
    public async Task<string?> GetCurrentOrderAsync(Guid machineId, CancellationToken ct = default)
    {
        var d = await GetAsync($"api/RealtimeDashboard/GetCurrentOrderActiveByMachineId?machineId={machineId}", ct);
        if (d.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        if (d.ValueKind != JsonValueKind.Object) throw new OptiCloudException(OptiCloudException.Unexpected);
        if (d.Str("isDefaultPartInfo") == "true" || d.Prop("partOrderNumberId") is not null && d.Guid("partOrderNumberId") is null) return "";
        return d.Str("number")?.Trim() ?? "";
    }

    // Makes order.Number the machine's current order (the server's time), ending the run before; ""
    // clears it (a hidden default order). Not idempotent: the same number again starts a new run, so
    // only send what differs from what the machine has. It ignores custom fields: SetOrderFieldsAsync.
    public Task SetOrderToMachineAsync(Guid machineId, MachineOrder order, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, "api/RealtimeDashboard/SetOrderToMachine", new { machineId, number = order.Number, expectedSpeed = 0 }, ct);

    // Gives the order order.Number its Fields as the order's own custom fields (customFieldItems,
    // text), in the machine's factory. Upserts by label, so safe to repeat, and leaves the machine's
    // run alone. Nothing to do for no order or no fields.
    public async Task SetOrderFieldsAsync(Guid machineId, MachineOrder order, CancellationToken ct = default)
    {
        if (order.Number.Length == 0 || order.Fields.Count == 0) return;
        var factoryId = await GetFactoryIdAsync(machineId, ct);
        await SendAsync(HttpMethod.Post, "api/PartOrderNumber/ExternalSetPartOrder",
            new { factoryId, partOrderNumber = order.Number, customFields = order.Fields.Select(f => new { label = f.Name, text = f.Value }).ToList() }, ct);
    }

    // The factory a machine is in, asked once per machine and kept: orders live per factory.
    public async Task<Guid> GetFactoryIdAsync(Guid machineId, CancellationToken ct = default)
    {
        lock (_factories) if (_factories.TryGetValue(machineId, out var known)) return known;
        var d = await GetAsync($"api/Machine/Get/{machineId}", ct);
        var id = d.ValueKind == JsonValueKind.Object ? d.Guid("factoryId") : null;
        if (id is null) throw new OptiCloudException(OptiCloudException.Unexpected);
        lock (_factories) _factories[machineId] = id.Value;
        return id.Value;
    }

    readonly Dictionary<Guid, Guid> _factories = [];

    // keyword is OptiCloud's free-text search; what it matches on is not documented.
    public async Task<RowsPage> GetRowsPagedAsync(Guid tableId, int page, int pageSize, string orderBy, bool ascending, string? keyword = null, CancellationToken ct = default)
    {
        var search = string.IsNullOrEmpty(keyword) ? "" : $"&keyword={Uri.EscapeDataString(keyword)}";
        var d = await GetAsync(
            $"api/MasterData/GetRowsPaged/{tableId}?page={page}&pageSize={pageSize}&Orderby={Uri.EscapeDataString(orderBy)}&IsAscending={(ascending ? "true" : "false")}{search}", ct);
        var rows = (d.Prop("rows") is { ValueKind: JsonValueKind.Array } a ? a.EnumerateArray() : JsonRead.List(d)).Select(Row).ToList();
        return new RowsPage(rows, d.Int("count"), d.Int("totalPage") ?? d.Int("totalPages"), d.Int("page") ?? page);
    }

    static CloudTable? Table(JsonElement t) =>
        t.Guid("id") is { } id && t.Str("name") is { Length: > 0 } name ? new CloudTable(id, name, t.Str("friendlyName")) : null;

    static ColumnType? Type(string? text) =>
        JsonRead.ToInt(text) is { } n ? Enum.IsDefined((ColumnType)n) ? (ColumnType)n : null
        : Enum.TryParse<ColumnType>(text, ignoreCase: true, out var t) ? t : null;

    static CloudRow Row(JsonElement r)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var v = r.Prop("values");
        // Some endpoints hand values over as a JSON string.
        if (v is { ValueKind: JsonValueKind.String } s)
        {
            try { v = JsonDocument.Parse(s.GetString() ?? "{}").RootElement.Clone(); }
            catch (JsonException) { v = null; }
        }
        if (v is { ValueKind: JsonValueKind.Object } o)
            foreach (var p in o.EnumerateObject()) values[p.Name] = JsonRead.Text(p.Value);

        DateTimeOffset? created = DateTimeOffset.TryParse(r.Str("createdDate"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var c) ? c : null;
        return new CloudRow(r.Guid("id"), created, values);
    }

    Task<JsonElement> GetAsync(string path, CancellationToken ct) => SendAsync(HttpMethod.Get, path, null, ct);

    Task<JsonElement> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct) =>
        SendAsync(method, path, body is null ? null : () => new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"), Timeout, ct);

    // content makes the body anew for each try: a request's content is sent once.
    async Task<JsonElement> SendAsync(HttpMethod method, string path, Func<HttpContent>? content, TimeSpan wait, CancellationToken ct)
    {
        await EnsureTokenAsync(ct);
        var used = _token;
        var (status, text) = await RawAsync(method, path, content, used, wait, ct);
        if (status == 401)
        {
            await RenewAsync(used, ct);
            (status, text) = await RawAsync(method, path, content, _token, wait, ct);
            if (status == 401) throw StatusError(401);
        }
        return Envelope(status, text);
    }

    // {data, errors, meta}. Errors may come with a 200, so they are always looked at.
    static JsonElement Envelope(int status, string text)
    {
        var ok = status is >= 200 and < 300;
        JsonElement root;
        try { root = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "null" : text).RootElement.Clone(); }
        catch (JsonException) { throw ok ? new OptiCloudException(OptiCloudException.Unexpected, status) : StatusError(status); }

        if (status is 401 or 403) throw StatusError(status);
        if (FirstError(root) is { } error)
            throw new OptiCloudException($"OptiCloud svarede: {error}", status, rejected: ok || OptiCloudException.IsRejectedStatus(status));
        if (!ok) throw StatusError(status);
        return root.Prop("data") ?? default;
    }

    static string? FirstError(JsonElement root)
    {
        if (root.Prop("errors") is not { ValueKind: JsonValueKind.Array } errors) return null;
        foreach (var e in errors.EnumerateArray())
        {
            var text = e.ValueKind == JsonValueKind.String ? e.GetString() : e.Str("message") is { Length: > 0 } m ? m : e.Str("title");
            return string.IsNullOrWhiteSpace(text) ? "ukendt fejl" : text.Trim();
        }
        return null;
    }

    static OptiCloudException StatusError(int status) => status switch
    {
        // A user without access is the setup's fault, not the request's: retried, never given up on.
        401 or 403 => new(OptiCloudException.Forbidden, status, auth: true),
        404 => new("OptiCloud kender ikke adressen (404)", status, rejected: true),
        >= 500 => new($"OptiCloud har en fejl ({status})", status),
        _ => new($"OptiCloud svarede {status}", status, rejected: OptiCloudException.IsRejectedStatus(status)),
    };

    async Task<(int Status, string Text)> RawAsync(HttpMethod method, string path, Func<HttpContent>? content, string? token, TimeSpan wait, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(wait);
        using var request = new HttpRequestMessage(method, path);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (content is not null) request.Content = content();
        try
        {
            using var response = await _http.SendAsync(request, timeout.Token);
            if (response.Headers.Date is { } date) Interlocked.Exchange(ref _skewTicks, (DateTimeOffset.UtcNow - date).Ticks);
            return ((int)response.StatusCode, await response.Content.ReadAsStringAsync(timeout.Token));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new OptiCloudException(OptiCloudException.Unreachable + " (intet svar)");
        }
        catch (HttpRequestException)
        {
            throw new OptiCloudException(OptiCloudException.Unreachable);
        }
    }

    async Task EnsureTokenAsync(CancellationToken ct)
    {
        if (_token is not null && !Expiring) return;
        await _auth.WaitAsync(ct);
        try
        {
            if (_token is null) await PasswordLoginAsync(ct);
            else if (Expiring) await RefreshOrLoginAsync(ct);
        }
        finally { _auth.Release(); }
    }

    bool Expiring => Volatile.Read(ref _expiresTicks) is var e and not 0 && DateTimeOffset.UtcNow.Ticks > e - TimeSpan.TicksPerMinute;

    // Single flight: whoever comes second finds the token already renewed and goes on with it.
    async Task RenewAsync(string? failed, CancellationToken ct)
    {
        await _auth.WaitAsync(ct);
        try
        {
            if (_token is not null && _token != failed) return;
            await RefreshOrLoginAsync(ct);
        }
        finally { _auth.Release(); }
    }

    async Task RefreshOrLoginAsync(CancellationToken ct)
    {
        if (_refreshToken is not null)
        {
            try
            {
                await TokenAsync(new { grant_type = "refresh_token", username = _username, refresh_token = _refreshToken }, ct);
                return;
            }
            // A refused refresh token falls back to the password; no network is no network either way.
            catch (OptiCloudException e) when (e.Status is not null) { }
        }
        await PasswordLoginAsync(ct);
    }

    // Under _auth. A password turned down less than Outbox.LoginBackoff ago is not tried: tried
    // often it can get the user locked out, and each loop would try it on a timer of its own.
    async Task PasswordLoginAsync(CancellationToken ct)
    {
        if (_badLogin is { } bad)
        {
            var left = Outbox.LoginBackoff - (Clock() - _badLoginAt);
            // A clock that went back counts as the whole wait over, not as a longer one.
            if (left > TimeSpan.Zero && left <= Outbox.LoginBackoff)
                throw new OptiCloudException(bad.Message, bad.Status, auth: true) { RetryAfter = left < MinRetry ? MinRetry : left };
            _badLogin = null;
        }

        try { await TokenAsync(new { grant_type = "password", username = _username, password = _password }, ct); }
        catch (OptiCloudException x) when (x.IsBadLogin)
        {
            _badLogin = x;
            _badLoginAt = Clock();
            throw;
        }
    }

    // A caller woken a moment early waits this at least, so it can't spin.
    static readonly TimeSpan MinRetry = TimeSpan.FromSeconds(1);

    // The login answer is not in the envelope. Bad credentials can be a 400, a 401, or a 200
    // with errors and no token: it only worked if there is a token. A 200 with neither (the
    // login page of a guest network, a proxy's answer) says nothing about the password, so it
    // is an unexpected answer with the usual short waits, not a quarter of an hour.
    async Task TokenAsync(object body, CancellationToken ct)
    {
        var (status, text) = await RawAsync(HttpMethod.Post, "api/Authentication/login", () => new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"), null, Timeout, ct);
        JsonElement root = default;
        try { if (!string.IsNullOrWhiteSpace(text)) root = JsonDocument.Parse(text).RootElement.Clone(); }
        catch (JsonException) { }

        var ok = status is >= 200 and < 300;
        if (ok && root.Str("access_token") is { Length: > 0 } token)
        {
            _token = token;
            _refreshToken = root.Str("refresh_token") is { Length: > 0 } r ? r : null;
            var seconds = root.Int("expires_in");
            Volatile.Write(ref _expiresTicks, seconds > 0 ? DateTimeOffset.UtcNow.AddSeconds(seconds.Value).Ticks : 0);
            return;
        }

        _token = null;
        if (status is 400 or 401 || ok && FirstError(root) is not null) throw new OptiCloudException(OptiCloudException.BadLogin, status, auth: true);
        if (ok) throw new OptiCloudException(OptiCloudException.Unexpected, status);
        throw StatusError(status);
    }

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
        _auth.Dispose();
    }
}
