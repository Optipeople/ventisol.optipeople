using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using Ventisol.Station.Core.Documents;

namespace Ventisol.Station.Tests;

public sealed class OrderDocumentUploadTests : IDisposable
{
    // The files are printed on 22 October; today is a week later.
    static readonly DateTimeOffset Now = new(2026, 10, 29, 12, 0, 0, TimeSpan.Zero);
    static readonly DateTime Written = new(2026, 10, 22, 9, 0, 0, DateTimeKind.Utc);
    const string Me = "PC-1", Other = "PC-2";

    readonly string _root = TestScans.TempFolder();
    readonly List<string> _log = [];
    readonly List<TimeSpan> _waits = [];

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    static byte[] Pdf(string text) => Encoding.ASCII.GetBytes($"%PDF-1.4\n{text}\n%%EOF\n");

    string Put(string relative, byte[]? bytes = null, DateTime? written = null)
    {
        var path = Path.Combine(_root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, bytes ?? Pdf(relative));
        File.SetLastWriteTimeUtc(path, written ?? Written);
        return path;
    }

    Task Fast(TimeSpan t, CancellationToken ct)
    {
        lock (_waits) _waits.Add(t);
        return Task.CompletedTask;
    }

    OrderDocumentUpload Upload(FakeOptiCloud api, OptiCloudClient client, string device = Me, Func<string, byte[]>? readFile = null, string? statePath = null) =>
        new(client, new OrderDocumentLocator(_root), FakeOptiCloud.Account, m => { lock (_log) _log.Add(m); }, device, () => Now, Fast, readFile, () => 0.5, statePath);

    static FakeOptiCloud.Table List(FakeOptiCloud api) => api.Tables.Single(t => t.Name == OrderDocumentUpload.Name);

    // The list as it is in OptiCloud already, with the rows given.
    static FakeOptiCloud.Table Existing(FakeOptiCloud api, params (string Name, string? Reference, string Device)[] rows)
    {
        var t = new FakeOptiCloud.Table(Guid.NewGuid(), OrderDocumentUpload.Name);
        foreach (var c in OrderDocumentUpload.Columns) t.Columns.Add((c.Name, (int)c.Type));
        foreach (var (name, reference, device) in rows)
        {
            var row = new JsonObject { ["FileName"] = name, ["Device"] = device };
            if (reference is not null) row["File"] = new JsonObject { ["name"] = name, ["contentType"] = "application/pdf", ["reference"] = reference };
            t.Rows.Add(row);
            t.Ids[row] = Guid.NewGuid();
        }
        api.Tables.Add(t);
        return t;
    }

    static string? Reference(JsonObject row) => (string?)row["File"]?["reference"];

    [Fact(Timeout = 10000)]
    public async Task A_new_pdf_becomes_a_row_with_its_file()
    {
        var path = Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        using var client = api.Client();

        Assert.Equal(1, await Upload(api, client).SyncOnceAsync());

        var bytes = File.ReadAllBytes(path);
        var stored = Assert.Single(api.Stored);
        Assert.Equal("58721_20261022.pdf", stored.Name);
        Assert.Equal(bytes, stored.Bytes);
        var row = Assert.Single(List(api).Rows);
        Assert.Equal("58721_20261022.pdf", (string?)row["FileName"]);
        Assert.Equal(58721, (int?)row["OrderNo"]);
        Assert.Equal("", (string?)row["Prefix"]);
        Assert.Equal("2026-10-22T00:00:00Z", (string?)row["PrintDate"]);
        Assert.Equal(Me, (string?)row["Device"]);
        Assert.Equal("2026-10-29T12:00:00Z", (string?)row["ClaimedAt"]);
        Assert.Equal(bytes.Length, (int?)row["SizeBytes"]);
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(bytes)), (string?)row["Sha256"]);
        Assert.Equal(stored.Reference, Reference(row));
        Assert.Equal("58721_20261022.pdf", (string?)row["File"]!["name"]);
        Assert.Equal("application/pdf", (string?)row["File"]!["contentType"]);
    }

    [Fact(Timeout = 10000)]
    public async Task The_list_is_made_with_its_columns_and_a_missing_column_is_added()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        using var client = api.Client();
        await Upload(api, client).SyncOnceAsync();
        Assert.Equal(OrderDocumentUpload.Columns.Select(c => (c.Name, (int)c.Type)), List(api).Columns);
        Assert.Contains(List(api).Columns, c => c is ("File", 8));

        // The list as it was first made by hand: no Device column.
        var old = new FakeOptiCloud();
        var t = Existing(old);
        t.Columns.RemoveAll(c => c.Name == "Device");
        using var client2 = old.Client();
        await Upload(old, client2).SyncOnceAsync();
        Assert.Contains(t.Columns, c => c.Name == "Device");
        Assert.Single(old.Tables);
    }

    [Fact(Timeout = 10000)]
    public async Task A_prefix_and_a_subfolder_are_kept_apart_by_file_name()
    {
        Put("58721_20261022.pdf");
        Put(@"be\BE_58721_20261023.pdf");
        // The same name in two folders is one file in the list: the one written last.
        var newer = Put(@"kopi\58721_20261022.pdf", Pdf("newer"), Written.AddHours(1));
        var api = new FakeOptiCloud();
        using var client = api.Client();

        Assert.Equal(2, await Upload(api, client).SyncOnceAsync());

        var rows = List(api).Rows;
        // Newest print first.
        Assert.Equal(["BE_58721_20261023.pdf", "58721_20261022.pdf"], rows.Select(r => (string?)r["FileName"]));
        Assert.Equal("BE", (string?)rows[0]["Prefix"]);
        Assert.Equal(File.ReadAllBytes(newer), api.Stored.Single(s => s.Name == "58721_20261022.pdf").Bytes);
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_in_the_list_is_not_uploaded_again_and_a_quiet_round_asks_nothing()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        Existing(api, ("58721_20261022.pdf", "masterdata/x/y/z.pdf", Other));
        using var client = api.Client();
        var upload = Upload(api, client);

        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Empty(api.Stored);
        Assert.Single(List(api).Rows);

        var asked = api.Snapshot().Count;
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(asked, api.Snapshot().Count);

        // A new file, and the list is asked again.
        Put("58731_20261022.pdf");
        Assert.Equal(1, await upload.SyncOnceAsync());
        Assert.Equal("58731_20261022.pdf", Assert.Single(api.Stored).Name);
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_still_being_written_too_old_or_cut_short_is_left()
    {
        Put("58721_20261022.pdf", written: Now.UtcDateTime.AddSeconds(-30));
        Put("50001_20260701.pdf");
        Put("58731_20261022.pdf", Encoding.ASCII.GetBytes("%PDF-1.4\nhalf of a file, no end mark yet"));
        Put("58741_20261022.pdf", Encoding.ASCII.GetBytes("not a pdf at all, but long enough"));
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var upload = Upload(api, client);

        Assert.Equal(0, await upload.SyncOnceAsync());
        // Neither bad file is read or asked about again while it stays as it is.
        var asked = api.Snapshot().Count;
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(asked, api.Snapshot().Count);

        Assert.Empty(api.Stored);
        Assert.Empty(List(api).Rows);
        Assert.Equal(2, _log.Count(m => m.Contains("ligner ikke en færdig PDF")));

        // Two minutes on it has settled.
        File.SetLastWriteTimeUtc(Path.Combine(_root, "58721_20261022.pdf"), Now.UtcDateTime.AddMinutes(-3));
        Assert.Equal(1, await upload.SyncOnceAsync());
    }

    [Fact(Timeout = 10000)]
    public async Task A_row_another_pc_just_made_is_left_to_it()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        Existing(api, ("58721_20261022.pdf", null, Other));
        using var client = api.Client();

        Assert.Equal(0, await Upload(api, client).SyncOnceAsync());

        Assert.Empty(api.Stored);
        Assert.Null(Reference(List(api).Rows[0]));
        Assert.Equal(0, api.Count("UpdateRow"));
    }

    [Fact(Timeout = 10000)]
    public async Task Its_own_row_without_a_file_is_finished()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        Existing(api, ("58721_20261022.pdf", null, Me.ToLowerInvariant()));
        using var client = api.Client();

        Assert.Equal(1, await Upload(api, client).SyncOnceAsync());

        var row = Assert.Single(List(api).Rows);
        Assert.Equal(Assert.Single(api.Stored).Reference, Reference(row));
        Assert.Equal(0, api.Count("CreateRow"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_row_left_without_a_file_for_an_hour_is_taken_over()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        var t = Existing(api, ("58721_20261022.pdf", null, Other));
        api.CreatedAt[t.Rows[0]] = Now - TimeSpan.FromHours(2);
        using var client = api.Client();

        Assert.Equal(1, await Upload(api, client).SyncOnceAsync());

        Assert.Equal(Me, (string?)t.Rows[0]["Device"]);
        Assert.Equal(Assert.Single(api.Stored).Reference, Reference(t.Rows[0]));
        Assert.Contains(_log, m => m.Contains("manglede sin fil (fra PC-2)"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_take_over_another_pc_also_made_is_given_up_without_an_upload()
    {
        Put("58721_20261022.pdf");
        Put("58731_20261022.pdf");
        var api = new FakeOptiCloud();
        var t = Existing(api, ("58721_20261022.pdf", null, Other), ("58731_20261022.pdf", null, Other));
        foreach (var r in t.Rows) api.CreatedAt[r] = Now - TimeSpan.FromHours(2);
        // A third PC writes its name just after ours.
        api.Override = (_, path, _) =>
        {
            if (path.Contains("GetRow/")) foreach (var r in t.Rows) r["Device"] = "PC-3";
            return null;
        };
        using var client = api.Client();

        Assert.Equal(0, await Upload(api, client).SyncOnceAsync());

        Assert.Empty(api.Stored);
        // The round ended there: the second file was not tried.
        Assert.Equal(1, api.Count("UpdateRow"));
    }

    [Fact(Timeout = 10000)]
    public async Task Losing_the_row_to_another_pc_uploads_nothing_and_ends_the_round()
    {
        Put("58721_20261022.pdf");
        Put("58731_20261022.pdf");
        var api = new FakeOptiCloud();
        var t = Existing(api);
        // The other PC's row gets in between our read of the list and our own row.
        api.Override = (_, path, _) =>
        {
            if (path.Contains("CreateRow") && t.Rows.Count == 0)
            {
                var row = new JsonObject { ["FileName"] = "58721_20261022.pdf", ["Device"] = Other };
                t.Rows.Add(row);
                t.Ids[row] = Guid.NewGuid();
            }
            return null;
        };
        using var client = api.Client();
        var upload = Upload(api, client);

        Assert.Equal(0, await upload.SyncOnceAsync());

        Assert.Empty(api.Stored);
        Assert.Single(t.Rows);
        Assert.Equal(1, api.Count("CreateRow"));

        // Next round the other PC's fresh row is left alone and the file nobody has is uploaded.
        api.Override = null;
        Assert.Equal(1, await upload.SyncOnceAsync());
        Assert.Equal("58731_20261022.pdf", Assert.Single(api.Stored).Name);
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_opticloud_refuses_is_set_aside_after_three_tries_and_the_others_go_up()
    {
        Put("58721_20261023.pdf");
        Put("58731_20261022.pdf");
        var api = new FakeOptiCloud();
        Existing(api);
        api.Override = (_, path, body) => path.Contains("CreateRow") && body!.Contains("58721_")
            ? FakeOptiCloud.Json(new { data = (object?)null, errors = new[] { new { title = "Row", message = "Column 'OrderNo' is not valid" } } })
            : null;
        using var client = api.Client();
        var upload = Upload(api, client);

        // The newest file is refused; the older one still goes up in the same round.
        Assert.Equal(1, await upload.SyncOnceAsync());
        Assert.Equal("58731_20261022.pdf", Assert.Single(api.Stored).Name);
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(4, api.Count("CreateRow"));

        // Set aside: not tried, and nothing asked, until the file is written again.
        var asked = api.Snapshot().Count;
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(asked, api.Snapshot().Count);
        Assert.Equal(1, _log.Count(m => m.Contains("blev afvist af OptiCloud") && m.Contains("OrderNo")));
        Assert.Contains(_log, m => m.Contains("er afvist 3 gange"));
        Assert.Single(api.Stored);

        api.Override = null;
        File.SetLastWriteTimeUtc(Path.Combine(_root, "58721_20261023.pdf"), Written.AddHours(2));
        Assert.Equal(1, await upload.SyncOnceAsync());
    }

    [Fact(Timeout = 10000)]
    public async Task A_name_refused_because_its_row_already_has_the_file_is_done_and_the_round_goes_on()
    {
        Put("58721_20261023.pdf");
        Put("58731_20261022.pdf");
        var api = new FakeOptiCloud();
        var t = Existing(api);
        // The row with its file gets in between our read of the list and our own row.
        api.Override = (_, path, _) =>
        {
            if (path.Contains("CreateRow") && t.Rows.Count == 0)
            {
                var row = new JsonObject { ["FileName"] = "58721_20261023.pdf", ["Device"] = Other, ["File"] = new JsonObject { ["reference"] = "masterdata/x/y/z.pdf" } };
                t.Rows.Add(row);
                t.Ids[row] = Guid.NewGuid();
            }
            return null;
        };
        using var client = api.Client();

        Assert.Equal(1, await Upload(api, client).SyncOnceAsync());

        Assert.Equal("58731_20261022.pdf", Assert.Single(api.Stored).Name);
        Assert.Equal(2, t.Rows.Count);
    }

    [Fact(Timeout = 10000)]
    public async Task A_row_taken_over_a_moment_ago_is_left_though_it_was_made_long_ago()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        var t = Existing(api, ("58721_20261022.pdf", null, Other));
        api.CreatedAt[t.Rows[0]] = Now - TimeSpan.FromHours(5);
        t.Rows[0]["ClaimedAt"] = "2026-10-29T11:50:00Z";
        using var client = api.Client();

        Assert.Equal(0, await Upload(api, client).SyncOnceAsync());

        Assert.Empty(api.Stored);
        Assert.Equal(0, api.Count("UpdateRow"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_stored_file_is_remembered_over_a_restart()
    {
        Put("58721_20261022.pdf");
        var state = Path.Combine(_root, "state", "document-uploads.json");
        var api = new FakeOptiCloud();
        api.Override = (_, path, _) => path.Contains("UpdateRow") ? new HttpResponseMessage(System.Net.HttpStatusCode.InternalServerError) : null;
        using var client = api.Client();
        await Assert.ThrowsAsync<OptiCloudException>(() => Upload(api, client, statePath: state).SyncOnceAsync());
        Assert.True(File.Exists(state));

        // The app starts again: its own row has no file yet, and the file stored before is used.
        api.Override = null;
        Assert.Equal(1, await Upload(api, client, statePath: state).SyncOnceAsync());

        Assert.Equal(api.Stored.Single().Reference, Reference(Assert.Single(List(api).Rows)));
        Assert.False(File.Exists(state));
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_stored_whose_row_could_not_be_updated_is_not_stored_twice()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        api.Override = (_, path, _) => path.Contains("UpdateRow") ? new HttpResponseMessage(System.Net.HttpStatusCode.InternalServerError) : null;
        using var client = api.Client();
        var upload = Upload(api, client);

        await Assert.ThrowsAsync<OptiCloudException>(() => upload.SyncOnceAsync());
        Assert.Single(api.Stored);
        Assert.Null(Reference(List(api).Rows[0]));

        api.Override = null;
        Assert.Equal(1, await upload.SyncOnceAsync());

        Assert.Single(api.Stored);
        Assert.Equal(api.Stored[0].Reference, Reference(Assert.Single(List(api).Rows)));
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_that_cant_be_read_is_skipped_and_the_others_go_up()
    {
        var locked = Put("58721_20261022.pdf");
        Put("58731_20261021.pdf");
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var upload = Upload(api, client, readFile: p => p == locked ? throw new IOException("in use") : File.ReadAllBytes(p));

        Assert.Equal(1, await upload.SyncOnceAsync());

        Assert.Equal("58731_20261021.pdf", Assert.Single(List(api).Rows)["FileName"]!.GetValue<string>());
    }

    [Fact(Timeout = 10000)]
    public async Task A_list_deleted_in_opticloud_is_made_again_next_round()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var upload = Upload(api, client);
        Assert.Equal(1, await upload.SyncOnceAsync());

        api.Tables.Clear();
        Put("58731_20261022.pdf");
        var x = await Assert.ThrowsAsync<OptiCloudException>(() => upload.SyncOnceAsync());
        Assert.Equal(404, x.Status);

        Assert.Equal(2, await upload.SyncOnceAsync());
        Assert.Equal(2, List(api).Rows.Count);
    }

    [Fact(Timeout = 10000)]
    public async Task No_folder_or_a_folder_that_is_gone_asks_opticloud_nothing()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var log = new List<string>();

        Assert.Equal(0, await new OrderDocumentUpload(client, new OrderDocumentLocator(null), FakeOptiCloud.Account, log.Add).SyncOnceAsync());
        var x = await Assert.ThrowsAsync<IOException>(() => new OrderDocumentUpload(client, new OrderDocumentLocator(Path.Combine(_root, "nope")), FakeOptiCloud.Account, log.Add).SyncOnceAsync());
        Assert.Equal("Mappen findes ikke", x.Message);

        Assert.Empty(api.Snapshot());
    }

    [Fact(Timeout = 10000)]
    public async Task The_loop_goes_on_after_a_failure_and_says_it_once()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud { Down = true };
        using var client = api.Client();
        using var stop = new CancellationTokenSource();
        var rounds = 0;
        var upload = new OrderDocumentUpload(client, new OrderDocumentLocator(_root), FakeOptiCloud.Account, m => { lock (_log) _log.Add(m); }, Me, () => Now,
            (t, ct) =>
            {
                lock (_waits) _waits.Add(t);
                if (++rounds == 4) api.Down = false;
                if (rounds == 6) stop.Cancel();
                return Task.Delay(1, ct);
            }, random: () => 0);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => upload.RunAsync(stop.Token));

        Assert.Single(api.Stored);
        lock (_log)
        {
            Assert.Equal(1, _log.Count(m => m.Contains("kan ikke lægges op") && m.Contains(OptiCloudException.Unreachable)));
            Assert.Contains(_log, m => m.Contains("lægges op til OptiCloud igen"));
        }
        // The start delay first, then the interval between rounds.
        Assert.Equal(upload.StartDelay, _waits[0]);
        Assert.Equal(upload.Interval, _waits[1]);
    }

    [Fact(Timeout = 10000)]
    public async Task An_upload_is_sent_again_with_its_file_after_the_token_ran_out()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        await client.LoginAsync();
        var t = Existing(api);
        api.ExpireToken();
        var bytes = Pdf("whole file");

        var file = await client.UploadFileAsync(t.Id, "58721_20261022.pdf", bytes, "application/pdf");

        var stored = Assert.Single(api.Stored);
        Assert.Equal(bytes, stored.Bytes);
        Assert.Equal(new CloudFile("58721_20261022.pdf", "application/pdf", stored.Reference), file);
        Assert.Equal(2, api.Count("MasterDataBlob/Upload"));
    }

    [Fact(Timeout = 10000)]
    public async Task Rows_are_made_updated_in_part_and_read_back()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        await client.LoginAsync();
        var t = Existing(api);

        var id = await client.CreateRowAsync(t.Id, new Dictionary<string, object?> { ["FileName"] = "a.pdf", ["Device"] = Me });
        Assert.NotNull(id);
        await client.UpdateRowAsync(id.Value, new Dictionary<string, object?> { ["Device"] = Other });
        var row = await client.GetRowAsync(id.Value);

        Assert.Equal(id, row.Id);
        Assert.Equal("a.pdf", row.Values["FileName"]);
        Assert.Equal(Other, row.Values["Device"]);
        // No file yet: an object of nulls, as the real API gives it.
        using var blob = JsonDocument.Parse(row.Values["File"]!);
        Assert.Equal(JsonValueKind.Null, blob.RootElement.GetProperty("reference").ValueKind);
    }

    [Fact(Timeout = 15000)]
    public async Task CloudSync_uploads_the_documents_folder_in_the_background()
    {
        Put("58721_20261022.pdf", written: DateTime.UtcNow.AddMinutes(-10));
        Put($"58731_{DateTime.Today:yyyyMMdd}.pdf", written: DateTime.UtcNow.AddMinutes(-10));
        var api = new FakeOptiCloud();
        var data = TestScans.TempFolder();
        try
        {
            using var sync = new CloudSync(FakeOptiCloud.Settings(StationMode.Viewer), FakeOptiCloud.Password, data, _ => { }, handler: api,
                delay: (_, ct) => Task.Delay(5, ct))
            { Documents = new OrderDocumentLocator(_root) };
            sync.Start();

            while (api.Stored.Length < 1) await Task.Delay(20);
        }
        finally
        {
            try { Directory.Delete(data, recursive: true); } catch (IOException) { }
        }

        Assert.Contains(api.Stored, s => s.Name.StartsWith("58731_"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_listing_made_a_moment_ago_is_used_and_an_old_one_is_made_again()
    {
        Put("58721_20261022.pdf");
        var lists = 0;
        var time = new FakeTime(Now);
        var locator = new OrderDocumentLocator(_root, time, (folder, ct) => { lists++; return OrderDocumentLocator.ListFolder(folder, ct); });
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var upload = new OrderDocumentUpload(client, locator, FakeOptiCloud.Account, _ => { }, Me, () => time.Now, Fast, random: () => 0);

        Assert.Equal(1, await upload.SyncOnceAsync());
        Put("58731_20261022.pdf");
        time.Now += TimeSpan.FromMinutes(2);
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(1, lists);

        time.Now += TimeSpan.FromMinutes(4);
        Assert.Equal(1, await upload.SyncOnceAsync());
        Assert.Equal(2, lists);
    }

    sealed class FakeTime(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Fact]
    public async Task The_locator_lists_every_file_older_versions_too()
    {
        Put("58721_20261022.pdf");
        Put("58721_20261101.pdf");
        Put("readme.txt");
        var locator = new OrderDocumentLocator(_root);
        Assert.Null(locator.IndexedFiles);

        var status = await locator.RefreshAsync();

        Assert.Equal(1, status.Orders);
        Assert.Equal(2, status.Files);
        Assert.Equal(["58721_20261022.pdf", "58721_20261101.pdf"], locator.IndexedFiles!.Select(e => Path.GetFileName(e.Path)).Order());
    }

    [Fact(Timeout = 10000)]
    public async Task An_upload_that_keeps_failing_is_given_up_so_it_leaves_no_more_files_behind()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        // The file may be stored each time, but the answer never says so.
        api.Override = (_, path, _) => path.Contains("MasterDataBlob/Upload") ? new HttpResponseMessage(System.Net.HttpStatusCode.BadGateway) : null;
        using var client = api.Client();
        var upload = Upload(api, client);

        for (var round = 1; round < OrderDocumentUpload.MaxUploadTries; round++)
            await Assert.ThrowsAsync<OptiCloudException>(() => upload.SyncOnceAsync());
        // The last try: the file is left alone from now on, and the round goes on.
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(OrderDocumentUpload.MaxUploadTries, api.Count("MasterDataBlob/Upload"));
        lock (_log) Assert.Single(_log, l => l.Contains("prøves ikke igen"));

        // OptiCloud is fine again, but this file is not sent a sixth time.
        api.Override = null;
        Assert.Equal(0, await upload.SyncOnceAsync());
        Assert.Equal(OrderDocumentUpload.MaxUploadTries, api.Count("MasterDataBlob/Upload"));

        // Written again, it is a new file: it goes up.
        Put("58721_20261022.pdf", Pdf("again"), Written.AddHours(1));
        Assert.Equal(1, await upload.SyncOnceAsync());
        Assert.Single(api.Stored);
    }

    [Fact(Timeout = 10000)]
    public async Task An_upload_that_fails_a_few_times_and_then_works_starts_counting_afresh()
    {
        Put("58721_20261022.pdf");
        var api = new FakeOptiCloud();
        api.Override = (_, path, _) => path.Contains("MasterDataBlob/Upload") ? new HttpResponseMessage(System.Net.HttpStatusCode.BadGateway) : null;
        using var client = api.Client();
        var upload = Upload(api, client);
        for (var round = 1; round < OrderDocumentUpload.MaxUploadTries; round++)
            await Assert.ThrowsAsync<OptiCloudException>(() => upload.SyncOnceAsync());

        api.Override = null;

        Assert.Equal(1, await upload.SyncOnceAsync());
        Assert.Single(api.Stored);
    }

    [Fact(Timeout = 10000)]
    public async Task A_file_too_big_to_be_an_order_document_is_not_read_or_put_in_opticloud()
    {
        var big = Put("58721_20261022.pdf");
        Put("58722_20261021.pdf");
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var reads = 0;
        var upload = Upload(api, client, readFile: path =>
        {
            if (path != big) return File.ReadAllBytes(path);
            reads++;
            throw new OrderDocumentTooLargeException(path, OrderDocuments.MaxPdfBytes + 1);
        });

        Assert.Equal(1, await upload.SyncOnceAsync());
        await upload.SyncOnceAsync();

        Assert.Equal("58722_20261021.pdf", Assert.Single(api.Stored).Name);
        Assert.Equal(1, reads);
        lock (_log) Assert.Single(_log, l => l.Contains("for stor"));
    }
}
