using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public class ScanTableTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 6, 0, 0, TimeSpan.Zero);

    [Fact(Timeout = 10000)]
    public async Task Creates_the_table_with_every_column()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var table = new ScanTable(client);

        var id = await table.EnsureAsync(FakeOptiCloud.Account);

        Assert.Equal(api.Scans.Id, id);
        Assert.Equal(ScanEvent.Columns.Select(c => (c.Name, (int)c.Type)), api.Scans.Columns);
        Assert.Equal(1, api.Count("CreateTable"));
    }

    [Fact(Timeout = 10000)]
    public async Task An_existing_table_only_gets_the_missing_columns()
    {
        var api = new FakeOptiCloud();
        api.Tables.Add(new FakeOptiCloud.Table(Guid.NewGuid(), "ventisolscans"));
        api.Tables[0].Columns.AddRange([("scanId", 0), ("Barcode", 0), ("ScanTime", 3)]);
        using var client = api.Client();
        var table = new ScanTable(client);

        await table.EnsureAsync(FakeOptiCloud.Account);

        Assert.Equal(0, api.Count("CreateTable"));
        Assert.Equal(ScanEvent.Columns.Count - 3, api.Count("AddColumn"));
        Assert.DoesNotContain(api.Requests, r => r.Path.Contains("AddColumn") && r.Body!.Contains("\"ScanTime\""));
    }

    [Fact(Timeout = 10000)]
    public async Task Ensure_is_done_once()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var table = new ScanTable(client);

        await table.EnsureAsync(FakeOptiCloud.Account);
        var before = api.Requests.Count;
        await table.EnsureAsync(FakeOptiCloud.Account);

        Assert.Equal(before, api.Requests.Count);
    }

    [Fact(Timeout = 10000)]
    public async Task Added_scans_read_back()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var table = new ScanTable(client);
        await table.EnsureAsync(FakeOptiCloud.Account);
        var e = In("058556050103", 1, T0);

        await table.AddAsync(e);
        var back = await table.ReadSinceAsync(T0.AddHours(-1));

        Assert.Equal([e], back);
    }

    [Fact(Timeout = 10000)]
    public async Task Reading_stops_at_the_first_page_older_than_since()
    {
        var api = new FakeOptiCloud { MaxPageSize = 10 };
        for (var i = 0; i < 50; i++) api.AddRow(In("058556050103", 1, T0.AddMinutes(i)));
        using var client = api.Client();
        var table = new ScanTable(client);
        await table.EnsureAsync(FakeOptiCloud.Account);

        var back = await table.ReadSinceAsync(T0.AddMinutes(35));

        Assert.Equal(15, back.Count);
        Assert.Equal(2, api.Count("GetRowsPaged"));
        Assert.Equal(back.OrderBy(e => e.At), back);
    }

    [Fact(Timeout = 10000)]
    public async Task When_the_order_is_ignored_it_is_read_from_the_last_page_backwards()
    {
        // The rows lie as they were made, oldest first.
        var api = new FakeOptiCloud { MaxPageSize = 10, IgnoreOrder = true };
        for (var i = 0; i < 50; i++) api.AddRow(In("058556050103", 1, T0.AddMinutes(i)));
        var log = new List<string>();
        using var client = api.Client();
        var table = new ScanTable(client, log.Add);
        await table.EnsureAsync(FakeOptiCloud.Account);

        var back = await table.ReadSinceAsync(T0.AddMinutes(35));

        Assert.Equal(15, back.Count);
        // The first page, then the last two: the second of them holds a row older than since.
        Assert.Equal(3, api.Count("GetRowsPaged"));
        Assert.Equal(T0.AddMinutes(35), back[0].At);
        Assert.Equal(T0.AddMinutes(49), back[^1].At);

        // Said once, however often it is read.
        await table.ReadSinceAsync(T0.AddMinutes(35));
        Assert.Single(log, l => l.Contains("sorteret"));
    }

    [Fact(Timeout = 20000)]
    public async Task When_the_order_is_ignored_the_newest_scans_are_found_beyond_the_page_cap()
    {
        // More pages than MaxPages, oldest first: the newest rows are on pages the cap never reached.
        var api = new FakeOptiCloud { MaxPageSize = 2, IgnoreOrder = true };
        var rows = 2 * ScanTable.MaxPages + 20;
        for (var i = 0; i < rows; i++) api.AddRow(In("058556050103", 1, T0.AddMinutes(i)));
        using var client = api.Client();
        var table = new ScanTable(client);
        await table.EnsureAsync(FakeOptiCloud.Account);
        var newest = In("058556050102", 2, T0.AddMinutes(rows));
        await table.AddAsync(newest);

        var back = await table.ReadSinceAsync(T0.AddMinutes(rows - 2));

        Assert.Equal(3, back.Count);
        Assert.Equal(newest, back[^1]);
        Assert.True(api.Count("GetRowsPaged") < 10);
        Assert.True(await table.ExistsAsync(newest));
    }

    [Fact(Timeout = 10000)]
    public async Task When_the_rows_come_in_no_order_at_all_every_page_is_read()
    {
        var api = new FakeOptiCloud { MaxPageSize = 10, IgnoreOrder = true };
        // 0, 7, 14 ... : every minute once, neither rising nor falling.
        for (var i = 0; i < 50; i++) api.AddRow(In("058556050103", 1, T0.AddMinutes(i * 7 % 50)));
        using var client = api.Client();
        var table = new ScanTable(client);
        await table.EnsureAsync(FakeOptiCloud.Account);

        var back = await table.ReadSinceAsync(T0.AddMinutes(35));

        Assert.Equal(15, back.Count);
        Assert.Equal(5, api.Count("GetRowsPaged"));
        Assert.Equal(back.OrderBy(e => e.At), back);
    }

    [Fact(Timeout = 20000)]
    public async Task Rows_in_no_order_are_read_backwards_for_a_set_number_of_pages_only()
    {
        // One row a page, neither rising nor falling, and far more pages than the cap.
        var api = new FakeOptiCloud { MaxPageSize = 1, IgnoreOrder = true };
        var rows = 3 * ScanTable.MaxPages;
        for (var i = 0; i < rows; i++) api.AddRow(In("058556050103", 1, T0.AddMinutes(i * 7 % rows)));
        using var client = api.Client();
        var log = new List<string>();
        var table = new ScanTable(client, log.Add);
        await table.EnsureAsync(FakeOptiCloud.Account);

        await table.ReadSinceAsync(T0);
        var first = api.Count("GetRowsPaged");
        await table.ReadSinceAsync(T0);

        // The pages it took to see there is no order, then the cap.
        Assert.InRange(first, ScanTable.MaxPages + 1, ScanTable.MaxPages + 3);
        Assert.Equal(2 * first, api.Count("GetRowsPaged"));
        Assert.Single(log, l => l.Contains("stoppede"));
    }

    [Fact(Timeout = 30000)]
    public async Task A_server_that_gives_no_page_count_and_ignores_the_page_does_not_loop_for_ever()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var log = new List<string>();
        var table = new ScanTable(client, log.Add);
        await table.EnsureAsync(FakeOptiCloud.Account);
        // The same full page whatever page is asked for, oldest first, and no totalPage.
        var page = FakePage([.. Enumerable.Range(0, ScanTable.PageSize).Select(i => In("058556050103", 1, T0.AddSeconds(i)))]);
        var asked = 0;
        api.Override = (_, path, _) =>
        {
            if (!path.Contains("GetRowsPaged")) return null;
            Interlocked.Increment(ref asked);
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(page, System.Text.Encoding.UTF8, "application/json") };
        };

        var back = await table.ReadSinceAsync(T0);
        await table.ReadSinceAsync(T0);

        Assert.Equal(ScanTable.PageSize, back.Count);
        // The first page, then the cap, both times.
        Assert.Equal(2 * (1 + ScanTable.MaxPages), asked);
        Assert.Single(log, l => l.Contains("stoppede"));
    }

    static string FakePage(IReadOnlyList<ScanEvent> scans) => System.Text.Json.JsonSerializer.Serialize(new
    {
        data = new
        {
            rows = scans.Select(e => new
            {
                id = Guid.NewGuid(),
                createdDate = e.At,
                values = e.ToValues().ToDictionary(p => char.ToLowerInvariant(p.Key[0]) + p.Key[1..], p => p.Value),
            }),
        },
        errors = Array.Empty<object>(),
    });

    [Fact(Timeout = 10000)]
    public async Task The_same_scan_twice_is_read_once_and_odd_rows_are_skipped()
    {
        var api = new FakeOptiCloud();
        var e = In("058556050103", 1, T0);
        api.AddRow(e);
        api.AddRow(e);
        api.AddRow(Out("058556050103", 1, T0.AddMinutes(5)));
        api.Scans.Rows.Add(new System.Text.Json.Nodes.JsonObject { ["ScanTime"] = T0.AddMinutes(1).ToString("o"), ["Barcode"] = "rubbish" });
        using var client = api.Client();
        var table = new ScanTable(client);
        await table.EnsureAsync(FakeOptiCloud.Account);

        var back = await table.ReadSinceAsync(T0);

        Assert.Equal(2, back.Count);
        Assert.Equal([ScanDirection.In, ScanDirection.Out], back.Select(b => b.Direction));
    }
}

public class ScanTableRecoveryTests
{
    static readonly DateTimeOffset T0 = new(2026, 10, 21, 6, 0, 0, TimeSpan.Zero);

    static async Task<(FakeOptiCloud Api, OptiCloudClient Client, ScanTable Table)> Ready(Action<FakeOptiCloud>? setup = null)
    {
        var api = new FakeOptiCloud();
        setup?.Invoke(api);
        var client = api.Client();
        var table = new ScanTable(client);
        await table.EnsureAsync(FakeOptiCloud.Account);
        return (api, client, table);
    }

    [Fact(Timeout = 10000)]
    public async Task A_table_deleted_in_opticloud_is_made_again_and_the_scan_goes_in()
    {
        var (api, client, table) = await Ready();
        using var _ = client;
        var old = api.Scans.Id;
        api.Tables.Clear();

        await table.AddAsync(In("058556050103", 1, T0));

        Assert.NotEqual(old, api.Scans.Id);
        Assert.Equal(ScanEvent.Columns.Count, api.Scans.Columns.Count);
        Assert.Equal(1, api.RowCount);
    }

    [Fact(Timeout = 10000)]
    public async Task A_404_that_stays_is_a_passing_failure_not_a_refusal()
    {
        var (api, client, table) = await Ready();
        using var _ = client;
        api.Override = (_, path, _) => path.Contains("CreateRow") ? new HttpResponseMessage(System.Net.HttpStatusCode.NotFound) : null;

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => table.AddAsync(In("058556050103", 1, T0)));

        Assert.False(e.IsRejected);
        Assert.Equal(2, api.Count("CreateRow"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_404_that_stays_keeps_the_scan_in_the_outbox()
    {
        var (api, client, table) = await Ready();
        using var _ = client;
        api.Override = (_, path, _) => path.Contains("CreateRow") ? new HttpResponseMessage(System.Net.HttpStatusCode.NotFound) : null;
        var folder = TempFolder();
        var box = new Outbox(folder);
        box.Add(In("058556050103", 1, T0));
        using var stop = new CancellationTokenSource();
        var waits = 0;

        var run = box.RunAsync(table.AddAsync, stop.Token, async (_, ct) => { Interlocked.Increment(ref waits); await Task.Delay(1, ct); });
        await Until(() => Volatile.Read(ref waits) >= 2);
        stop.Cancel();
        await run.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(1, box.Pending);
        Assert.False(Directory.Exists(Path.Combine(folder, "failed")));
    }

    [Theory(Timeout = 10000)]
    [InlineData(FakeOptiCloud.Search.Works)]
    [InlineData(FakeOptiCloud.Search.FindsNothing)]
    [InlineData(FakeOptiCloud.Search.Ignored)]
    public async Task A_resend_of_a_scan_that_got_in_counts_as_sent(FakeOptiCloud.Search search)
    {
        var (api, client, table) = await Ready(a => a.Keyword = search);
        using var _ = client;
        var e = In("058556050103", 1, T0);
        for (var i = 0; i < 30; i++) api.AddRow(In("058556050102", 2, T0.AddMinutes(i - 15)));
        await table.AddAsync(e);

        await table.AddAsync(e);

        Assert.Equal(31, api.RowCount);
    }

    [Fact(Timeout = 10000)]
    public async Task A_refusal_for_a_scan_that_is_not_there_still_refuses()
    {
        var (api, client, table) = await Ready();
        using var _ = client;
        api.Override = (_, path, _) => path.Contains("CreateRow")
            ? FakeOptiCloud.Json(new { errors = new[] { new { title = "Bad", message = "Ugyldig værdi" } } }, System.Net.HttpStatusCode.BadRequest)
            : null;

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => table.AddAsync(In("058556050103", 1, T0)));

        Assert.True(e.IsRejected);
        Assert.Equal(1, api.Count("keyword="));
    }

    [Fact(Timeout = 10000)]
    public async Task Making_the_table_again_may_fail_and_the_next_try_still_gets_the_scan_in()
    {
        var (api, client, table) = await Ready();
        using var _ = client;
        var scan = In("058556050103", 1, T0);
        api.Tables.Clear();
        api.Override = (_, path, _) => path.Contains("GetTables") ? new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable) : null;

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => table.AddAsync(scan));
        Assert.False(e.IsRejected);
        Assert.Equal(503, e.Status);
        // The old id stands: a read fails as OptiCloud says (not there), never for want of an id.
        Assert.NotNull(table.TableId);
        var read = await Assert.ThrowsAsync<OptiCloudException>(() => table.ReadSinceAsync(T0.AddHours(-1)));
        Assert.Equal(404, read.Status);

        // OptiCloud answers again: the same scan goes in, and reads work.
        api.Override = null;
        await table.AddAsync(scan);

        Assert.Equal(1, api.RowCount);
        Assert.Equal(api.Scans.Id, table.TableId);
        Assert.Equal([scan], await table.ReadSinceAsync(T0.AddHours(-1)));
        Assert.Equal(1, api.Count("CreateTable") - 1);
    }

    [Fact(Timeout = 10000)]
    public async Task A_refusal_to_make_the_table_again_is_not_a_refusal_of_the_scan()
    {
        var (api, client, table) = await Ready();
        using var _ = client;
        api.Tables.Clear();
        api.Override = (_, path, _) => path.Contains("CreateTable")
            ? FakeOptiCloud.Json(new { errors = new[] { new { title = "Bad", message = "Nej" } } }, System.Net.HttpStatusCode.BadRequest)
            : null;

        var e = await Assert.ThrowsAsync<OptiCloudException>(() => table.AddAsync(In("058556050103", 1, T0)));

        Assert.False(e.IsRejected);
    }

    [Fact(Timeout = 10000)]
    public async Task A_read_while_the_table_is_being_made_again_has_an_id_to_ask_with()
    {
        var (api, client, table) = await Ready();
        using var _ = client;
        var scan = In("058556050103", 1, T0);
        api.Tables.Clear();
        using var asked = new SemaphoreSlim(0);
        using var go = new ManualResetEventSlim();
        // The sender is held in the middle of making the table again.
        api.Override = (_, path, _) =>
        {
            if (!path.Contains("GetTables")) return null;
            asked.Release();
            go.Wait();
            return null;
        };
        var add = Task.Run(() => table.AddAsync(scan));
        await asked.WaitAsync();

        // The poll comes by meanwhile: OptiCloud's own answer about the old table, not a crash.
        var read = await Assert.ThrowsAsync<OptiCloudException>(() => table.ReadSinceAsync(T0.AddHours(-1)));
        Assert.Equal(404, read.Status);

        go.Set();
        await add;
        Assert.Equal([scan], await table.ReadSinceAsync(T0.AddHours(-1)));
        Assert.Single(api.Tables);
    }

    [Fact(Timeout = 10000)]
    public async Task A_first_ensure_that_failed_is_made_up_for_by_whoever_needs_the_table_next()
    {
        var api = new FakeOptiCloud { Override = (_, path, _) => path.Contains("GetTables") ? new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable) : null };
        using var client = api.Client();
        var table = new ScanTable(client);
        await Assert.ThrowsAsync<OptiCloudException>(() => table.EnsureAsync(FakeOptiCloud.Account));
        Assert.Null(table.TableId);

        api.Override = null;
        var scan = In("058556050103", 1, T0);
        Assert.Empty(await table.ReadSinceAsync(T0.AddHours(-1)));
        await table.AddAsync(scan);

        Assert.Equal([scan], await table.ReadSinceAsync(T0.AddHours(-1)));
        Assert.Equal(1, api.Count("CreateTable"));
    }

    [Fact(Timeout = 10000)]
    public async Task Without_an_account_there_is_no_table_to_find()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();

        await Assert.ThrowsAsync<InvalidOperationException>(() => new ScanTable(client).ReadSinceAsync(T0));
    }
}
