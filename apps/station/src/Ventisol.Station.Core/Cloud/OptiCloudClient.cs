using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace Ventisol.Station.Core.Cloud;

public sealed record CloudUser(Guid Id, string Email, string Name, Guid AccountId, string AccountName, string PermissionName);

public sealed record CloudMachine(Guid Id, string Name);

public sealed record CloudTable(Guid Id, string Name, string? FriendlyName);

// The numbers are OptiCloud's MasterDataColumnType.
public enum ColumnType { String = 0, Decimal = 1, Int = 2, DateTime = 3, Bool = 4, Long = 5, Lookup = 6 }

public sealed record CloudColumn(Guid Id, string Name, ColumnType? Type);

public sealed record ColumnSpec(string Name, string FriendlyName, ColumnType Type, bool IsRequired = false, bool IsUnique = false, bool IsKey = false);

// Values keyed by column name, case-insensitively (the API may camelCase them), as text.
public sealed record CloudRow(Guid? Id, DateTimeOffset? Created, IReadOnlyDictionary<string, string?> Values);

public sealed record RowsPage(IReadOnlyList<CloudRow> Rows, int? Count, int? TotalPages, int Page);

// The OptiPeople API, the few calls the station needs. Logs in on first use and keeps the
// token fresh: on a 401 it refreshes once (one refresh for all callers at a time) and tries
// again once; when the refresh fails it logs in with the password. Never logs anything, so
// the password and tokens can't end up in a log. Every failure is an OptiCloudException.
public sealed class OptiCloudClient : IDisposable
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    readonly HttpClient _http;
    readonly bool _ownsHttp;
    readonly string _username, _password;
    readonly SemaphoreSlim _auth = new(1, 1);
    string? _token, _refreshToken;
    DateTimeOffset? _expires;

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

    public Task CreateRowAsync(Guid tableId, IReadOnlyDictionary<string, object?> values, CancellationToken ct = default) =>
        SendAsync(HttpMethod.Post, $"api/MasterData/CreateRow/{tableId}", new { values }, ct);

    public async Task<RowsPage> GetRowsPagedAsync(Guid tableId, int page, int pageSize, string orderBy, bool ascending, CancellationToken ct = default)
    {
        var d = await GetAsync(
            $"api/MasterData/GetRowsPaged/{tableId}?page={page}&pageSize={pageSize}&Orderby={Uri.EscapeDataString(orderBy)}&IsAscending={(ascending ? "true" : "false")}", ct);
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

    async Task<JsonElement> SendAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        await EnsureTokenAsync(ct);
        var used = _token;
        var (status, text) = await RawAsync(method, path, body, used, ct);
        if (status == 401)
        {
            await RenewAsync(used, ct);
            (status, text) = await RawAsync(method, path, body, _token, ct);
            if (status == 401) throw new OptiCloudException("OptiCloud afviste login", 401, auth: true);
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
        403 => new("Brugeren har ikke adgang til det i OptiCloud", status, rejected: true),
        404 => new("OptiCloud kender ikke adressen (404)", status, rejected: true),
        >= 500 => new($"OptiCloud har en fejl ({status})", status),
        _ => new($"OptiCloud svarede {status}", status, rejected: OptiCloudException.IsRejectedStatus(status)),
    };

    async Task<(int Status, string Text)> RawAsync(HttpMethod method, string path, object? body, string? token, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(Timeout);
        using var request = new HttpRequestMessage(method, path);
        if (token is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        try
        {
            using var response = await _http.SendAsync(request, timeout.Token);
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

    bool Expiring => _expires is { } e && DateTimeOffset.UtcNow > e - TimeSpan.FromMinutes(1);

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

    Task PasswordLoginAsync(CancellationToken ct) => TokenAsync(new { grant_type = "password", username = _username, password = _password }, ct);

    // The login answer is not in the envelope. Bad credentials can be a 400, a 401, or a 200
    // with errors and no token: it only worked if there is a token.
    async Task TokenAsync(object body, CancellationToken ct)
    {
        var (status, text) = await RawAsync(HttpMethod.Post, "api/Authentication/login", body, null, ct);
        JsonElement root = default;
        try { if (!string.IsNullOrWhiteSpace(text)) root = JsonDocument.Parse(text).RootElement.Clone(); }
        catch (JsonException) { }

        var ok = status is >= 200 and < 300;
        if (ok && root.Str("access_token") is { Length: > 0 } token)
        {
            _token = token;
            _refreshToken = root.Str("refresh_token") is { Length: > 0 } r ? r : null;
            var seconds = root.Int("expires_in");
            _expires = seconds > 0 ? DateTimeOffset.UtcNow.AddSeconds(seconds.Value) : null;
            return;
        }

        _token = null;
        if (ok || status is 400 or 401) throw new OptiCloudException(OptiCloudException.BadLogin, status, auth: true);
        throw StatusError(status);
    }

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
        _auth.Dispose();
    }
}
