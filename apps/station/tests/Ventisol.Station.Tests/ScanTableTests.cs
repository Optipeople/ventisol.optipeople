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
    public async Task When_the_order_is_ignored_every_page_is_read()
    {
        var api = new FakeOptiCloud { MaxPageSize = 10, IgnoreOrder = true };
        for (var i = 0; i < 50; i++) api.AddRow(In("058556050103", 1, T0.AddMinutes(i)));
        using var client = api.Client();
        var table = new ScanTable(client);
        await table.EnsureAsync(FakeOptiCloud.Account);

        var back = await table.ReadSinceAsync(T0.AddMinutes(35));

        Assert.Equal(15, back.Count);
        Assert.Equal(5, api.Count("GetRowsPaged"));
        Assert.Equal(T0.AddMinutes(35), back[0].At);
        Assert.Equal(T0.AddMinutes(49), back[^1].At);
    }

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
}
