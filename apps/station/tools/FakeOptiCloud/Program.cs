// A local stand-in for the OptiPeople API: the calls the station app and the reports site make,
// shaped like the real API (docs/opticloud-scans.md). The login answer is not enveloped; every
// other answer is {data, errors, meta}, and refusals (bad login, a duplicate key) come as errors
// with HTTP 200. Row values come back camelCased, as the real API may do.
// One user (demo@ventisol.dk / demo), one account (Ventisol), seven machines named like the stations.
// Tables, rows and tokens are kept in a JSON file next to the exe, so a restart keeps them.
//
//   FakeOptiCloud [url | port] [--reset] [--forbid-writes]       default http://localhost:5099
//   env FAKE_OPTICLOUD_URL, FAKE_OPTICLOUD_DATA (the data file), FAKE_FORBID_WRITES=1
// GET /fake/state shows everything held, without a login.

using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using FakeOptiCloud;

var url = args.FirstOrDefault(a => a.StartsWith("http", StringComparison.OrdinalIgnoreCase))
    ?? (args.FirstOrDefault(a => int.TryParse(a, out _)) is { } port ? $"http://localhost:{port}" : null)
    ?? (Environment.GetEnvironmentVariable("FAKE_OPTICLOUD_URL") is { Length: > 0 } envUrl ? envUrl : null)
    ?? "http://localhost:5099";
var dataFile = Environment.GetEnvironmentVariable("FAKE_OPTICLOUD_DATA") is { Length: > 0 } f ? f : Path.Combine(AppContext.BaseDirectory, "fakeopticloud-data.json");
if (args.Contains("--reset") && File.Exists(dataFile)) File.Delete(dataFile);
// --forbid-writes (or FAKE_FORBID_WRITES=1): CreateRow answers 403, as for a user who may read but not write.
var forbidWrites = args.Contains("--forbid-writes") || Environment.GetEnvironmentVariable("FAKE_FORBID_WRITES") == "1";

var builder = WebApplication.CreateSlimBuilder();
builder.Logging.ClearProviders();
var app = builder.Build();
app.Urls.Add(url);

var store = new Store(dataFile);

// One line per request.
app.Use(async (ctx, next) =>
{
    var watch = Stopwatch.StartNew();
    await next();
    Console.WriteLine($"{DateTime.Now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture)}  {ctx.Request.Method,-4} {ctx.Request.Path}{ctx.Request.QueryString}  -> {ctx.Response.StatusCode}  {watch.ElapsedMilliseconds} ms{(ctx.Items["note"] is string n ? "  " + n : "")}");
});

// Everything under /api but the login needs a live token, else a bare 401 as the real API.
app.Use(async (ctx, next) =>
{
    var path = ctx.Request.Path.Value ?? "";
    var open = path.StartsWith("/api/Authentication/login", StringComparison.OrdinalIgnoreCase)
        || path.StartsWith("/api/IncomacAuthentication/", StringComparison.OrdinalIgnoreCase)
        || path.StartsWith("/api/User/SetNewForgottenPassword", StringComparison.OrdinalIgnoreCase);
    if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase) && !open)
    {
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (!auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) || !store.IsValidToken(auth[7..].Trim()))
        {
            ctx.Response.StatusCode = 401;
            return;
        }
    }
    await next();
});

app.MapPost("/api/Authentication/login", async (HttpRequest request) =>
{
    var body = await ReadBody(request);
    string? Get(string name) => body.TryGetValue(name, out var v) ? v : null;
    var answer = Get("grant_type") switch
    {
        "password" => store.PasswordLogin(Get("username"), Get("password")),
        "refresh_token" => store.Refresh(Get("username"), Get("refresh_token")),
        _ => null,
    };
    request.HttpContext.Items["note"] = $"{Get("grant_type")} {Get("username")} {(answer is null ? "refused" : "ok")}";
    return answer is { } t
        ? Results.Json(new { access_token = t.Access, token_type = "bearer", expires_in = (int)Store.TokenLife.TotalSeconds, refresh_token = t.Refresh, user_name = Store.User })
        : Results.Json(new { errors = new[] { new { title = "Login", message = "Invalid username or password" } } });
});

app.MapGet("/api/User/GetCurrentUser", () => Data(new
{
    id = Store.UserId,
    email = Store.User,
    name = "Demo Ventisol",
    roleName = "Administrator",
    permissionName = "Administrator",
    accountId = Store.Account,
    accountName = Store.AccountName,
}));

app.MapPost("/api/IncomacAuthentication/ForgotPassword", () => Data(true));
app.MapPost("/api/User/SetNewForgottenPassword", () => Data(true));

app.MapGet("/api/Machine/GetByAccountId/{accountId:guid}", (Guid accountId) =>
    accountId != Store.Account ? Results.StatusCode(403) : Data(Store.Machines.Select(m => new { id = m.Id, name = m.Name, accountId = Store.Account, factoryId = Store.Factory })));

app.MapGet("/api/Machine/Get/{id:guid}", (Guid id) =>
    Store.Machines.Any(m => m.Id == id)
        ? Data(new { id, name = Store.Machines.First(m => m.Id == id).Name, accountId = Store.Account, factoryId = Store.Factory })
        : Error("Machine not found"));

app.MapGet("/api/MasterData/GetTables/{accountId:guid}", (Guid accountId) =>
    accountId != Store.Account ? Results.StatusCode(403) : Data(store.Read(d => d.Tables.Select(TableJson).ToList())));

app.MapPost("/api/MasterData/CreateTable/{accountId:guid}", async (Guid accountId, HttpRequest request) =>
{
    if (accountId != Store.Account) return Results.StatusCode(403);
    var b = await JsonBody(request);
    var name = (string?)b?["name"];
    if (string.IsNullOrWhiteSpace(name)) return Error("Name is required", 400);
    return store.Write(d =>
    {
        if (d.Tables.Any(t => t.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) return Error($"A table named {name} already exists");
        var t = new TableData { Id = Guid.NewGuid(), Name = name, FriendlyName = (string?)b!["friendlyName"], Description = (string?)b["description"] };
        d.Tables.Add(t);
        request.HttpContext.Items["note"] = $"table {name} created";
        return Data(TableJson(t));
    });
});

app.MapGet("/api/MasterData/GetColumns/{tableId:guid}", (Guid tableId) => store.Read(d =>
    d.Find(tableId) is { } t ? Data(t.Columns.Select(c => new { id = c.Id, name = c.Name, friendlyName = c.FriendlyName, dataType = c.DataType, c.IsRequired, c.IsUnique, c.IsKey })) : NotFound()));

app.MapPost("/api/MasterData/AddColumn/{tableId:guid}", async (Guid tableId, HttpRequest request) =>
{
    var b = await JsonBody(request);
    var name = (string?)b?["name"];
    if (string.IsNullOrWhiteSpace(name)) return Error("Name is required", 400);
    if (b!["dataType"] is not JsonValue v || !v.TryGetValue<int>(out var type) || type is < 0 or > 8) return Error("dataType must be 0 to 8", 400);
    return store.Write(d =>
    {
        if (d.Find(tableId) is not { } t) return NotFound();
        if (t.Columns.Any(c => c.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) return Error($"Column {name} already exists");
        t.Columns.Add(new ColumnData
        {
            Id = Guid.NewGuid(), Name = name, FriendlyName = (string?)b["friendlyName"], DataType = type,
            IsRequired = (bool?)b["isRequired"] ?? false, IsUnique = (bool?)b["isUnique"] ?? false, IsKey = (bool?)b["isKey"] ?? false,
        });
        request.HttpContext.Items["note"] = $"column {t.Name}.{name} ({type})";
        return Data(true);
    });
});

app.MapPost("/api/MasterData/CreateRow/{tableId:guid}", async (Guid tableId, HttpRequest request) =>
{
    // As a user without write access: every new row refused with a bare 403.
    if (forbidWrites) return Results.StatusCode(403);
    var b = await JsonBody(request);
    if (b?["values"] is not JsonObject values) return Error("values is required", 400);
    return store.Write(d =>
    {
        if (d.Find(tableId) is not { } t) return NotFound();
        var row = new Dictionary<string, JsonElement>();
        foreach (var (key, value) in values)
        {
            var column = t.Columns.FirstOrDefault(c => c.Name.Equals(key, StringComparison.OrdinalIgnoreCase));
            if (column is null) return Error($"Unknown column {key}", 400);
            if (value is null) continue;
            if (!Store.Fits(column.DataType, value)) return Error($"{column.Name}: {value.ToJsonString()} is not a {Store.TypeName(column.DataType)}", 400);
            row[column.Name] = JsonSerializer.SerializeToElement(value);
        }
        foreach (var c in t.Columns.Where(c => c.IsRequired && !row.ContainsKey(c.Name))) return Error($"{c.Name} is required", 400);
        foreach (var c in t.Columns.Where(c => (c.IsUnique || c.IsKey) && row.ContainsKey(c.Name)))
        {
            var text = Store.Text(row[c.Name]);
            if (t.Rows.Any(r => r.Values.TryGetValue(c.Name, out var have) && Store.Text(have) == text))
            {
                request.HttpContext.Items["note"] = $"duplicate {c.Name} {text}";
                return Error($"The value of {c.Name} must be unique");
            }
        }
        var id = Guid.NewGuid();
        t.Rows.Add(new RowData { Id = id, CreatedDate = DateTimeOffset.UtcNow, Values = row });
        request.HttpContext.Items["note"] = string.Join(" ", new[] { "Barcode", "Direction", "ScanTime", "DurationSec" }
            .Where(row.ContainsKey).Select(k => $"{k}={Store.Text(row[k])}"));
        return Data(new { id });
    });
});

app.MapGet("/api/MasterData/GetRowsPaged/{tableId:guid}", (Guid tableId, HttpRequest request) =>
{
    var q = request.Query; // Keys match case-insensitively, as in ASP.NET.
    var page = Math.Max(1, int.TryParse(q["page"], out var p) ? p : 1);
    var size = Math.Clamp(int.TryParse(q["pageSize"], out var s) ? s : 10, 1, 500);
    var ascending = !bool.TryParse(q["IsAscending"], out var asc) || asc;
    var orderBy = q["Orderby"].ToString();
    var keyword = q["keyword"].ToString();
    return store.Read(d =>
    {
        if (d.Find(tableId) is not { } t) return NotFound();
        IEnumerable<RowData> rows = t.Rows;
        if (keyword.Length > 0)
            rows = rows.Where(r => r.Values.Values.Any(v => Store.Text(v)?.Contains(keyword, StringComparison.OrdinalIgnoreCase) == true));
        var column = t.Columns.FirstOrDefault(c => c.Name.Equals(orderBy, StringComparison.OrdinalIgnoreCase));
        var sorted = column is null
            ? (ascending ? rows.OrderBy(r => r.CreatedDate) : rows.OrderByDescending(r => r.CreatedDate)).ToList()
            : Store.Sort(rows, column, ascending);
        var slice = sorted.Skip((page - 1) * size).Take(size).Select(r => new
        {
            id = r.Id,
            createdDate = r.CreatedDate,
            values = r.Values.ToDictionary(v => char.ToLowerInvariant(v.Key[0]) + v.Key[1..], v => v.Value),
        });
        return Data(new { rows = slice, count = sorted.Count, totalPage = (sorted.Count + size - 1) / size, page, pageSize = size });
    });
});

// Each machine's current order, held in memory only (a restart forgets it). As the live API:
// a set always starts a new run, "" (or null) switches to a hidden default order, and a machine
// never given one answers with all-zero ids and number null.
var orders = new System.Collections.Concurrent.ConcurrentDictionary<Guid, (Guid PartInformationId, Guid PartOrderNumberId, string Number, DateTime Start)>();

app.MapPost("/api/RealtimeDashboard/SetOrderToMachine", async (HttpContext ctx) =>
{
    var b = await JsonBody(ctx.Request);
    if (!Guid.TryParse((string?)b?["machineId"], out var machine) || !Store.Machines.Any(m => m.Id == machine)) return Error("Machine not found");
    var number = ((string?)b?["number"])?.Trim() ?? "";
    var run = (Guid.NewGuid(), number.Length == 0 ? Guid.Empty : Guid.NewGuid(), number, DateTime.Now);
    orders[machine] = run;
    ctx.Items["note"] = number.Length == 0 ? "cleared" : $"order {number}";
    return Data(new { partInformationId = run.Item1, partOrderNumberId = run.Item2, number, startDate = run.Item4, endDate = (DateTime?)null, expectedSpeed = 0 });
});

app.MapGet("/api/RealtimeDashboard/GetCurrentOrderActiveByMachineId", (Guid machineId) =>
    orders.TryGetValue(machineId, out var run)
        ? Data(new { partInformationId = run.PartInformationId, partOrderNumberId = run.PartOrderNumberId, number = run.Number, startDate = run.Start, isDefaultPartInfo = run.Number.Length == 0 })
        : Data(new { partInformationId = Guid.Empty, partOrderNumberId = Guid.Empty, number = (string?)null, startDate = DateTime.MinValue, isDefaultPartInfo = false }));

// Each order's custom fields as ExternalSetPartOrder left them, by number, in memory only. As live:
// upserts by label, and leaves the machine's run alone.
var orderFields = new System.Collections.Concurrent.ConcurrentDictionary<string, Dictionary<string, string?>>();

app.MapPost("/api/PartOrderNumber/ExternalSetPartOrder", async (HttpContext ctx) =>
{
    var b = await JsonBody(ctx.Request);
    if (!Guid.TryParse((string?)b?["factoryId"], out var factory) || factory != Store.Factory) return Error("Factory not found");
    var number = ((string?)b?["partOrderNumber"])?.Trim() ?? "";
    if (number.Length == 0) return Error("Part order number is required");
    var fields = orderFields.GetOrAdd(number, _ => []);
    lock (fields)
        foreach (var f in b?["customFields"]?.AsArray() ?? [])
            if ((string?)f?["label"] is { } label) fields[label] = (string?)f?["text"];
    ctx.Items["note"] = $"fields of {number}";
    return Data(null);
});

app.MapGet("/fake/state", () => Results.Json(store.Read(d => new
{
    account = Store.Account, accountName = Store.AccountName, user = Store.User,
    machines = Store.Machines.Select(m => new { id = m.Id, name = m.Name }),
    machineOrders = orders.ToDictionary(o => o.Key, o => o.Value.Number),
    orderFields = orderFields.ToDictionary(o => o.Key, o => { lock (o.Value) return new Dictionary<string, string?>(o.Value); }),
    tables = d.Tables.Select(t => new { t.Id, t.Name, columns = t.Columns.Select(c => $"{c.Name}:{c.DataType}"), rowCount = t.Rows.Count, rows = t.Rows }).ToList(),
}), new JsonSerializerOptions { WriteIndented = true }));

app.MapFallback((HttpContext ctx) => Results.NotFound());

Console.WriteLine($"Fake OptiCloud on {url}  user {Store.User} / {Store.Password}  account {Store.AccountName} {Store.Account}");
Console.WriteLine($"Data in {dataFile}{(forbidWrites ? "  (CreateRow answers 403)" : "")}");
app.Run();

static IResult Data(object? data) => Results.Json(new { data, errors = Array.Empty<object>(), meta = (object?)null });

static IResult Error(string message, int status = 200) =>
    Results.Json(new { data = (object?)null, errors = new[] { new { title = "Error", message } }, meta = (object?)null }, statusCode: status);

static IResult NotFound() => Results.StatusCode(404);

static object TableJson(TableData t) => new { id = t.Id, name = t.Name, friendlyName = t.FriendlyName, description = t.Description, accountId = Store.Account };

static async Task<JsonNode?> JsonBody(HttpRequest request)
{
    try { return await JsonNode.ParseAsync(request.Body); }
    catch (JsonException) { return null; }
}

// The login takes JSON, or a form as OAuth clients send it.
static async Task<Dictionary<string, string?>> ReadBody(HttpRequest request)
{
    if (request.HasFormContentType)
        return (await request.ReadFormAsync()).ToDictionary(k => k.Key, k => (string?)k.Value.ToString());
    return await JsonBody(request) is JsonObject o
        ? o.ToDictionary(k => k.Key, k => k.Value is JsonValue v && v.TryGetValue<string>(out var s) ? s : k.Value?.ToJsonString())
        : [];
}

namespace FakeOptiCloud
{
    sealed class TableData
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string? FriendlyName { get; set; }
        public string? Description { get; set; }
        public List<ColumnData> Columns { get; set; } = [];
        public List<RowData> Rows { get; set; } = [];
    }

    sealed class ColumnData
    {
        public Guid Id { get; set; }
        public string Name { get; set; } = "";
        public string? FriendlyName { get; set; }
        public int DataType { get; set; }
        public bool IsRequired { get; set; }
        public bool IsUnique { get; set; }
        public bool IsKey { get; set; }
    }

    sealed class RowData
    {
        public Guid Id { get; set; }
        public DateTimeOffset CreatedDate { get; set; }
        public Dictionary<string, JsonElement> Values { get; set; } = [];
    }

    sealed class TokenData
    {
        public string Access { get; set; } = "";
        public string Refresh { get; set; } = "";
        public DateTimeOffset Expires { get; set; }
    }

    sealed class StoreData
    {
        public List<TableData> Tables { get; set; } = [];
        public List<TokenData> Tokens { get; set; } = [];

        public TableData? Find(Guid id) => Tables.FirstOrDefault(t => t.Id == id);
    }

    sealed class Store
    {
        public const string User = "demo@ventisol.dk", Password = "demo", AccountName = "Ventisol";
        public static readonly Guid Account = Guid.Parse("7e3c2a10-5b4d-4f6e-9a21-0c8d7b6e5f40");
        public static readonly Guid UserId = Guid.Parse("1a2b3c4d-0000-4000-8000-00000000d3e0");
        public static readonly Guid Factory = Guid.Parse("f1000000-0000-4000-8000-0000000000f1");
        public static readonly TimeSpan TokenLife = TimeSpan.FromHours(1);

        public static readonly (Guid Id, string Name)[] Machines =
        [
            (Guid.Parse("a1000000-0000-4000-8000-000000000010"), "Station 10"),
            (Guid.Parse("a1000000-0000-4000-8000-000000000020"), "Station 20"),
            (Guid.Parse("a1000000-0000-4000-8000-000000000030"), "Station 30"),
            (Guid.Parse("a1000000-0000-4000-8000-000000000040"), "Station 40"),
            (Guid.Parse("a1000000-0000-4000-8000-000000000051"), "Montagebord 1"),
            (Guid.Parse("a1000000-0000-4000-8000-000000000052"), "Montagebord 2"),
            (Guid.Parse("a1000000-0000-4000-8000-000000000070"), "Pakning"),
        ];

        static readonly JsonSerializerOptions FileOptions = new() { WriteIndented = true };

        readonly string _file;
        readonly Lock _gate = new();
        readonly StoreData _data;

        public Store(string file)
        {
            _file = file;
            try { _data = File.Exists(file) ? JsonSerializer.Deserialize<StoreData>(File.ReadAllText(file)) ?? new() : new(); }
            catch (JsonException) { _data = new(); }
        }

        public T Read<T>(Func<StoreData, T> read) { lock (_gate) return read(_data); }

        public T Write<T>(Func<StoreData, T> write)
        {
            lock (_gate)
            {
                var result = write(_data);
                Save();
                return result;
            }
        }

        void Save()
        {
            _data.Tokens.RemoveAll(t => t.Expires < DateTimeOffset.UtcNow - TimeSpan.FromDays(1));
            var tmp = _file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_data, FileOptions));
            File.Move(tmp, _file, overwrite: true);
        }

        public bool IsValidToken(string token) => Read(d => d.Tokens.Any(t => t.Access == token && t.Expires > DateTimeOffset.UtcNow));

        public TokenData? PasswordLogin(string? user, string? password) =>
            string.Equals(user?.Trim(), User, StringComparison.OrdinalIgnoreCase) && password == Password ? Issue() : null;

        // A refresh token works once, for the user it was given to.
        public TokenData? Refresh(string? user, string? refresh) => Write(d =>
        {
            if (!string.Equals(user?.Trim(), User, StringComparison.OrdinalIgnoreCase) || d.Tokens.FirstOrDefault(t => t.Refresh == refresh) is not { } old) return null;
            d.Tokens.Remove(old);
            return IssueLocked(d);
        });

        TokenData Issue() => Write(IssueLocked);

        static TokenData IssueLocked(StoreData d)
        {
            var t = new TokenData { Access = "fake-" + Guid.NewGuid().ToString("N"), Refresh = "fake-refresh-" + Guid.NewGuid().ToString("N"), Expires = DateTimeOffset.UtcNow + TokenLife };
            d.Tokens.Add(t);
            return t;
        }

        public static string TypeName(int type) => type switch
        {
            0 => "String", 1 => "Decimal", 2 => "Int", 3 => "DateTime", 4 => "Bool", 5 => "Long", 6 => "Lookup", _ => $"type {type}",
        };

        // What OptiCloud would take for a column of this type; strings that read as the type are fine too.
        public static bool Fits(int type, JsonNode value)
        {
            if (value is not JsonValue v) return false;
            var kind = v.GetValueKind();
            var text = kind == JsonValueKind.String ? v.GetValue<string>() : v.ToJsonString();
            return type switch
            {
                0 or 6 => kind == JsonValueKind.String,
                1 => decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out _),
                2 => int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
                5 => long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out _),
                3 => kind == JsonValueKind.String && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _),
                4 => kind is JsonValueKind.True or JsonValueKind.False || bool.TryParse(text, out _),
                _ => true,
            };
        }

        public static string? Text(JsonElement v) => v.ValueKind switch
        {
            JsonValueKind.String => v.GetString(),
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            _ => v.GetRawText(),
        };

        // By the column's type: dates as dates, numbers as numbers, the rest as text. Empty last.
        public static List<RowData> Sort(IEnumerable<RowData> rows, ColumnData column, bool ascending)
        {
            IComparable? Key(RowData r)
            {
                if (!r.Values.TryGetValue(column.Name, out var v) || Text(v) is not { Length: > 0 } text) return null;
                return column.DataType switch
                {
                    3 => DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null,
                    1 or 2 or 5 => decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out var n) ? n : null,
                    _ => text.ToUpperInvariant(),
                };
            }
            var keyed = rows.Select(r => (Row: r, Key: Key(r))).ToList();
            var withKey = keyed.Where(k => k.Key is not null);
            var ordered = ascending ? withKey.OrderBy(k => k.Key) : withKey.OrderByDescending(k => k.Key);
            return [.. ordered.Concat(keyed.Where(k => k.Key is null)).Select(k => k.Row)];
        }
    }
}
