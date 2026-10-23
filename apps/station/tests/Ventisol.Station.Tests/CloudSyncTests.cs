using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public sealed class CloudSyncTests : IDisposable
{
    // Midday today, local time, so "since midnight" holds the morning.
    static readonly DateTimeOffset Now = new(DateTime.Today.AddHours(12));
    const string A = "058556050103", B = "058556050102";

    readonly string _folder = TempFolder();
    readonly List<string> _log = [];

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch (IOException) { }
    }

    static Task Fast(TimeSpan _, CancellationToken ct) => Task.Delay(5, ct);

    CloudSync Sync(FakeOptiCloud api, StationMode mode = StationMode.Scan, string? password = FakeOptiCloud.Password, StationSettings? settings = null) =>
        new(settings ?? FakeOptiCloud.Settings(mode), password, _folder, m => { lock (_log) _log.Add(m); }, () => Now, api, Fast);

    [Fact(Timeout = 10000)]
    public async Task A_recorded_scan_becomes_a_row()
    {
        var api = new FakeOptiCloud();
        using var sync = Sync(api);
        var loaded = new List<ReplayResult>();
        sync.Loaded += (_, r) => { lock (loaded) loaded.Add(r); };

        sync.Start();
        await Until(() => sync.Status.State == CloudState.Online && loaded.Count == 1);
        Assert.True(sync.Record(In(A, 1, Now.AddMinutes(-1))));
        await Until(() => api.RowCount == 1 && sync.Pending == 0);

        Assert.Equal(ScanEvent.Columns.Count, api.Scans.Columns.Count);
        Assert.Equal(A, (string?)api.Scans.Rows[0]["Barcode"]);
        Assert.Equal("Forbundet · Ventisol", sync.Status.Text);
        Assert.Equal(Now, sync.Status.LastSync);
    }

    [Fact(Timeout = 10000)]
    public async Task At_start_the_day_so_far_is_loaded_with_what_still_waits_to_be_sent()
    {
        var api = new FakeOptiCloud();
        api.AddRow(In(A, 1, Now.AddHours(-2)));
        api.AddRow(Out(A, 1, Now.AddHours(-1)));
        api.AddRow(In(B, 2, Now.AddDays(-1)));
        new Outbox(Path.Combine(_folder, "outbox")).Add(In(B, 3, Now.AddMinutes(-5)));
        api.Down = true;
        using var sync = Sync(api);
        ReplayResult? loaded = null;
        sync.Loaded += (_, r) => loaded = r;

        sync.Start();
        await Until(() => sync.Status.State == CloudState.Offline);
        Assert.Equal("Offline · 1 scanning venter", sync.Status.Text);
        api.Down = false;
        await Until(() => loaded is not null);

        Assert.Single(loaded!.Done);
        Assert.Equal(TimeSpan.FromHours(1), loaded.Done[0].Duration);
        Assert.Equal([3], loaded.InProgress.Keys);
        await Until(() => api.RowCount == 4);
    }

    [Fact(Timeout = 10000)]
    public async Task A_viewer_polls_and_tells_when_something_changed()
    {
        var api = new FakeOptiCloud();
        api.AddRow(In(A, 1, Now.AddMinutes(-30)));
        using var sync = Sync(api, StationMode.Viewer);
        var loaded = new List<ReplayResult>();
        sync.Loaded += (_, r) => { lock (loaded) loaded.Add(r); };

        sync.Start();
        await Until(() => loaded.Count == 1);
        Assert.Equal(Code(A), loaded[0].InProgress[1].Barcode);

        var polls = api.Count("GetRowsPaged");
        await Until(() => api.Count("GetRowsPaged") > polls + 2);
        Assert.Single(loaded);

        api.AddRow(Out(A, 1, Now.AddMinutes(-2)));
        await Until(() => loaded.Count == 2);
        Assert.Empty(loaded[1].InProgress);
        Assert.Single(loaded[1].Done);
        Assert.Equal(0, api.Count("CreateRow"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_viewer_also_sees_scans_sent_late()
    {
        var api = new FakeOptiCloud();
        api.AddRow(In(A, 1, Now.AddMinutes(-1)));
        using var sync = Sync(api, StationMode.Viewer);
        var loaded = new List<ReplayResult>();
        sync.Loaded += (_, r) => { lock (loaded) loaded.Add(r); };
        sync.Start();
        await Until(() => loaded.Count == 1);

        // Scanned hours ago at a station that was offline, sent now.
        api.AddRow(In(B, 2, Now.AddHours(-3)));
        api.AddRow(Out(B, 2, Now.AddHours(-2)));

        await Until(() => loaded.Count == 2);
        Assert.Single(loaded[1].Done);
    }

    [Fact(Timeout = 10000)]
    public async Task Not_set_up_keeps_scans_on_disk_and_calls_nobody()
    {
        var api = new FakeOptiCloud();
        using (var sync = Sync(api, password: null))
        {
            sync.Start();
            Assert.True(sync.Record(In(A, 1, Now)));

            Assert.Equal(CloudState.NotSetUp, sync.Status.State);
            Assert.Equal("Ikke sat op · 1 scanning venter", sync.Status.Text);
        }
        Assert.Empty(api.Requests);

        using var later = Sync(api);
        later.Start();
        await Until(() => api.RowCount == 1);
    }

    [Fact(Timeout = 10000)]
    public async Task A_wrong_password_is_an_error_and_keeps_trying()
    {
        var api = new FakeOptiCloud();
        using var sync = Sync(api, password: "forkert");

        sync.Start();
        await Until(() => sync.Status.State == CloudState.Error);
        await Until(() => api.LoginCount("password") > 2);

        Assert.Equal("Fejl: " + OptiCloudException.BadLogin, sync.Status.Text);
        Assert.Single(_log, l => l.Contains(OptiCloudException.BadLogin));
        Assert.DoesNotContain(_log, l => l.Contains("forkert"));
    }

    [Fact]
    public void Dispose_stops_cleanly()
    {
        var api = new FakeOptiCloud { Down = true };
        var sync = Sync(api);
        sync.Start();

        sync.Dispose();
        sync.Dispose();
    }

    [Fact(Timeout = 10000)]
    public async Task Testing_the_connection_says_null_when_it_works_and_why_when_not()
    {
        var api = new FakeOptiCloud();
        var settings = FakeOptiCloud.Settings() with { AccountId = null };

        Assert.Null(await CloudSync.TestConnectionAsync(settings, FakeOptiCloud.Password, handler: api));
        Assert.Equal(OptiCloudException.BadLogin, await CloudSync.TestConnectionAsync(settings, "forkert", handler: api));
        Assert.Equal(OptiCloudException.Unreachable, await CloudSync.TestConnectionAsync(settings, FakeOptiCloud.Password, handler: new FakeOptiCloud { Down = true }));
        Assert.NotNull(await CloudSync.TestConnectionAsync(settings with { Username = null }, FakeOptiCloud.Password, handler: api));
    }

    [Fact(Timeout = 10000)]
    public async Task Machines_come_sorted_by_name()
    {
        var api = new FakeOptiCloud();

        var machines = await CloudSync.LoadMachinesAsync(FakeOptiCloud.Settings(), FakeOptiCloud.Password, handler: api);

        Assert.Equal(["montagebord 1", "Pakning", "Station 10"], machines.Select(m => m.Name));
    }
}
