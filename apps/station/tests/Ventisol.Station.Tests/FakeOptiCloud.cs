using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;

namespace Ventisol.Station.Tests;

// OptiCloud in memory, just the calls the station makes, shaped like the real API: login not
// enveloped, everything else {data, errors, meta}, value keys camelCased on the way back.
public sealed class FakeOptiCloud : HttpMessageHandler
{
    public static readonly Guid Account = Guid.Parse("4d1f0c4e-2b8a-4c39-9a51-6c0f6f2b7e11");
    public const string User = "ventisol", Password = "hemmelig";

    public sealed class Table(Guid id, string name)
    {
        public Guid Id { get; } = id;
        public string Name { get; } = name;
        public List<(string Name, int Type)> Columns { get; } = [];
        public List<JsonObject> Rows { get; } = [];
        // The ids of the rows made through CreateRow.
        public Dictionary<JsonObject, Guid> Ids { get; } = new(ReferenceEqualityComparer.Instance);
    }

    readonly Lock _gate = new();
    int _tokens;
    string? _token, _refresh;

    public List<Table> Tables { get; } = [];
    public List<(Guid Id, string Name)> Machines { get; } = [(Guid.NewGuid(), "Pakning"), (Guid.NewGuid(), "Station 10"), (Guid.NewGuid(), "montagebord 1")];
    public List<(string Method, string Path, string? Body, string? Auth)> Requests { get; } = [];
    // Each machine's current order as SetOrderToMachine left it ("" a cleared one), and every set in order.
    public Dictionary<Guid, string> Orders { get; } = [];
    public List<(Guid Machine, string Number)> OrderSets { get; } = [];
    public (Guid Machine, string Number)[] Sets { get { lock (_gate) return [.. OrderSets]; } }
    // The one factory every machine is in, and each order's custom fields as ExternalSetPartOrder left them.
    public Guid Factory { get; } = Guid.NewGuid();
    public Dictionary<string, Dictionary<string, string>> OrderFields { get; } = [];
    public Dictionary<string, string>? FieldsOf(string number) { lock (_gate) return OrderFields.TryGetValue(number, out var f) ? new(f) : null; }

    // Every file stored through MasterDataBlob/Upload, in order.
    public List<(Guid Table, string Name, byte[] Bytes, string Reference)> Uploads { get; } = [];
    public (Guid Table, string Name, byte[] Bytes, string Reference)[] Stored { get { lock (_gate) return [.. Uploads]; } }

    public bool RefreshWorks { get; set; } = true;
    public bool IgnoreOrder { get; set; }
    public bool Down { get; set; }
    public int MaxPageSize { get; set; } = 500;
    public TimeSpan LoginDelay { get; set; }

    // How GetRowsPaged treats keyword: searches every value, finds nothing, or is not heard at all.
    public enum Search { Works, FindsNothing, Ignored }
    public Search Keyword { get; set; } = Search.Works;

    // Return a response here to take over a call; null lets the fake answer.
    public Func<string, string, string?, HttpResponseMessage?>? Override { get; set; }

    public int Count(string pathPart) { lock (_gate) return Requests.Count(r => r.Path.Contains(pathPart, StringComparison.OrdinalIgnoreCase)); }

    public int LoginCount(string grant) { lock (_gate) return Requests.Count(r => r.Path.EndsWith("Authentication/login") && r.Body!.Contains(grant)); }
    public List<(string Method, string Path, string? Body, string? Auth)> Snapshot() { lock (_gate) return [.. Requests]; }

    // Makes the current token stale, as when it runs out.
    public void ExpireToken() { lock (_gate) _token = "expired-" + _token; }

    public Table Scans => Tables.Single(t => t.Name == ScanTable.Name);

    public void AddRow(ScanEvent e)
    {
        lock (_gate)
        {
            if (!Tables.Any(t => t.Name == ScanTable.Name)) Tables.Add(new Table(Guid.NewGuid(), ScanTable.Name));
            Scans.Rows.Add(Row(e.ToValues()));
        }
    }

    public int RowCount { get { lock (_gate) return Tables.FirstOrDefault(t => t.Name == ScanTable.Name)?.Rows.Count ?? 0; } }

    static JsonObject Row(IDictionary<string, object?> values) =>
        JsonSerializer.SerializeToNode(values)!.AsObject();

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        // A file upload is multipart, not JSON: its parts are read, and the log gets no body.
        var file = request.Content is MultipartFormDataContent form ? form.First() : null;
        var bytes = file is null ? null : await file.ReadAsByteArrayAsync(ct);
        var body = request.Content is null || file is not null ? null : await request.Content.ReadAsStringAsync(ct);
        var path = request.RequestUri!.PathAndQuery.TrimStart('/');
        var auth = request.Headers.Authorization?.ToString();
        lock (_gate) Requests.Add((request.Method.Method, path, body, auth));

        if (Down) throw new HttpRequestException("no route to host");
        if (Override?.Invoke(request.Method.Method, path, body) is { } over) return over;

        if (path.StartsWith("api/Authentication/login"))
        {
            if (LoginDelay > TimeSpan.Zero) await Task.Delay(LoginDelay, ct);
            return Login(JsonNode.Parse(body!)!);
        }

        lock (_gate)
        {
            if (auth != $"Bearer {_token}" || _token is null) return new HttpResponseMessage(HttpStatusCode.Unauthorized);
            if (file is not null && path.StartsWith("api/MasterDataBlob/Upload/"))
            {
                var table = Guid.Parse(path.Split('?')[0].Split('/')[^1]);
                if (!Tables.Any(t => t.Id == table)) return new HttpResponseMessage(HttpStatusCode.NotFound);
                var name = file.Headers.ContentDisposition?.FileName?.Trim('"') ?? "";
                var reference = $"masterdata/{Account}/{table}/{Guid.NewGuid()}.pdf";
                Uploads.Add((table, name, bytes!, reference));
                return Data(new { name, contentType = file.Headers.ContentType?.MediaType, reference });
            }
            try { return Route(request.Method.Method, path, body is null ? null : JsonNode.Parse(body)); }
            catch (InvalidOperationException) { return new HttpResponseMessage(HttpStatusCode.NotFound); } // no such table
        }
    }

    HttpResponseMessage Login(JsonNode b)
    {
        lock (_gate)
        {
            var ok = (string?)b["grant_type"] switch
            {
                "password" => (string?)b["username"] == User && (string?)b["password"] == Password,
                "refresh_token" => RefreshWorks && (string?)b["username"] == User && _refresh is not null && (string?)b["refresh_token"] == _refresh,
                _ => false,
            };
            if (!ok) return Json(new { errors = new[] { new { title = "Login", message = "Invalid credentials" } } });
            _tokens++;
            _token = $"token-{_tokens}";
            _refresh = $"refresh-{_tokens}";
            return Json(new { access_token = _token, refresh_token = _refresh, user_name = User, expires_in = 3600 });
        }
    }

    HttpResponseMessage Route(string method, string path, JsonNode? b)
    {
        var parts = path.Split('?')[0].Split('/');
        var query = path.Contains('?') ? path.Split('?')[1].Split('&').Select(p => p.Split('=')).ToDictionary(p => p[0], p => p[1], StringComparer.OrdinalIgnoreCase) : [];
        var last = parts[^1];
        var action = parts.Length > 3 ? parts[2] : parts[^1];

        switch (parts[1], action)
        {
            case ("User", "GetCurrentUser"):
                return Data(new { id = Guid.NewGuid(), email = "v@ventisol.dk", name = "Ventisol station", accountId = Account, accountName = "Ventisol", permissionName = "User" });
            case ("Machine", "GetByAccountId"):
                return Data(Machines.Select(m => new { id = m.Id, name = m.Name }));
            case ("MasterData", "GetTables"):
                return Data(Tables.Select(t => new { id = t.Id, name = t.Name, friendlyName = t.Name }));
            case ("MasterData", "CreateTable"):
            {
                var t = new Table(Guid.NewGuid(), (string)b!["name"]!);
                Tables.Add(t);
                return Data(new { id = t.Id, name = t.Name, friendlyName = (string?)b["friendlyName"] });
            }
            case ("MasterData", "GetColumns"):
                // Types as numbers and as names, as the real API is not consistent.
                return Data(Find(last).Columns.Select((c, i) => new { id = Guid.NewGuid(), name = c.Name, dataType = i % 2 == 0 ? (object)c.Type : ((ColumnType)c.Type).ToString() }));
            case ("MasterData", "AddColumn"):
                Find(last).Columns.Add(((string)b!["name"]!, (int)b["dataType"]!));
                return Data(new { });
            case ("MasterData", "CreateRow"):
            {
                var t = Find(last);
                var values = b!["values"]!.AsObject();
                // The unique column: ScanId in the scans, FileName in the order documents.
                var key = values.ContainsKey("FileName") ? "FileName" : "ScanId";
                var id = (string?)values[key];
                if (t.Rows.Any(r => (string?)r[key] == id)) return Json(new { data = (object?)null, errors = new[] { new { title = "Unique", message = $"{key} findes allerede" } } });
                var row = values.DeepClone().AsObject();
                t.Rows.Add(row);
                t.Ids[row] = Guid.NewGuid();
                return Data(new { id = t.Ids[row] });
            }
            case ("MasterData", "UpdateRow"):
            {
                var (_, row) = FindRow(last);
                foreach (var p in b!["values"]!.AsObject()) row[p.Key] = p.Value?.DeepClone();
                return Data(new { });
            }
            case ("MasterData", "GetRow"):
            {
                var (t, row) = FindRow(last);
                return Data(new { id = t.Ids[row], createdDate = Created(row), values = Values(t, row) });
            }
            case ("RealtimeDashboard", "SetOrderToMachine"):
            {
                var machine = Guid.Parse((string)b!["machineId"]!);
                var number = (string?)b["number"] ?? "";
                Orders[machine] = number;
                OrderSets.Add((machine, number));
                return Data(new { partInformationId = Guid.NewGuid(), partOrderNumberId = Guid.NewGuid(), number, startDate = "2026-11-10T08:00:00", endDate = (string?)null });
            }
            case ("Machine", "Get"):
            {
                var id = Guid.Parse(last);
                if (!Machines.Any(m => m.Id == id)) return Json(new { data = (object?)null, errors = new[] { new { title = "NotFound", message = "Machine not found" } } });
                return Data(new { id, name = Machines.First(m => m.Id == id).Name, factoryId = Factory });
            }
            case ("PartOrderNumber", "ExternalSetPartOrder"):
            {
                if ((string?)b!["factoryId"] != Factory.ToString()) return Json(new { data = (object?)null, errors = new[] { new { title = "NotFound", message = "Factory not found" } } });
                var number = (string)b["partOrderNumber"]!;
                if (!OrderFields.TryGetValue(number, out var fields)) OrderFields[number] = fields = [];
                foreach (var f in b["customFields"]!.AsArray()) fields[(string)f!["label"]!] = (string)f["text"]!;
                return Json(new { data = (object?)null, errors = Array.Empty<object>(), meta = new { } });
            }
            case ("RealtimeDashboard", "GetCurrentOrderActiveByMachineId"):
            {
                // As live: never set has all-zero ids and number null; cleared runs a hidden default order.
                if (!Orders.TryGetValue(Guid.Parse(query["machineId"]), out var number))
                    return Data(new { partInformationId = Guid.Empty, partOrderNumberId = Guid.Empty, number = (string?)null, startDate = "0001-01-01T00:00:00", isDefaultPartInfo = false });
                return Data(new { partInformationId = Guid.NewGuid(), partOrderNumberId = Guid.NewGuid(), number, startDate = "2026-11-10T08:00:00", isDefaultPartInfo = number.Length == 0 });
            }
            case ("MasterData", "GetRowsPaged"):
            {
                var t = Find(last);
                var page = int.Parse(query["page"]);
                var size = Math.Min(int.Parse(query["pageSize"]), MaxPageSize);
                var rows = IgnoreOrder || t.Rows.Any(r => !r.ContainsKey("ScanTime")) ? t.Rows.ToList() : [.. t.Rows.OrderByDescending(r => DateTimeOffset.Parse((string)r["ScanTime"]!))];
                if (query.TryGetValue("keyword", out var keyword) && Keyword != Search.Ignored)
                    rows = Keyword == Search.FindsNothing ? [] : [.. rows.Where(r => r.Any(p => p.Value?.ToString().Contains(Uri.UnescapeDataString(keyword)) == true))];
                var slice = rows.Skip((page - 1) * size).Take(size).Select(r => new
                {
                    id = t.Ids.TryGetValue(r, out var rowId) ? rowId : Guid.NewGuid(),
                    createdDate = Created(r),
                    values = Values(t, r),
                });
                return Data(new { rows = slice, count = rows.Count, totalPage = (rows.Count + size - 1) / size, page });
            }
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
    }

    Table Find(string id) => Tables.Single(t => t.Id == Guid.Parse(id));

    // Throws InvalidOperationException (a 404) when no table has a row with that id.
    (Table Table, JsonObject Row) FindRow(string id)
    {
        var rowId = Guid.Parse(id);
        var t = Tables.First(t => t.Ids.ContainsValue(rowId));
        return (t, t.Ids.First(p => p.Value == rowId).Key);
    }

    // When a row was made, for a test to set: rows made here are new unless given a time.
    public Dictionary<JsonObject, DateTimeOffset> CreatedAt { get; } = new(ReferenceEqualityComparer.Instance);

    DateTimeOffset Created(JsonObject row) => CreatedAt.TryGetValue(row, out var at) ? at : DateTimeOffset.UtcNow;

    // Keys camelCased as the real API does, and a Blob column the row has no file in comes back as an object of nulls.
    static Dictionary<string, JsonNode?> Values(Table t, JsonObject row)
    {
        var values = row.ToDictionary(p => char.ToLowerInvariant(p.Key[0]) + p.Key[1..], p => p.Value?.DeepClone());
        foreach (var c in t.Columns.Where(c => c.Type == (int)ColumnType.Blob && !row.ContainsKey(c.Name)))
            values[char.ToLowerInvariant(c.Name[0]) + c.Name[1..]] = JsonSerializer.SerializeToNode(new { contentType = (string?)null, name = (string?)null, reference = (string?)null });
        return values;
    }

    static HttpResponseMessage Data(object data) => Json(new { data, errors = Array.Empty<object>(), meta = (object?)null });

    public static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    public static StationSettings Settings(StationMode mode = StationMode.Scan) => StationSettings.Default with
    {
        Mode = mode,
        ApiBaseUrl = "https://fake.opticloud.test",
        AccountId = Account,
        Username = User,
    };

    public OptiCloudClient Client(string password = Password) => new("https://fake.opticloud.test", User, password, this);
}
