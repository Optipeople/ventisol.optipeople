using System.Net;
using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public sealed class CloudSyncTests : IDisposable
{
    // Midday today, local time, so "since midnight" holds the morning.
    static readonly DateTimeOffset Now = new(DateTime.Today.AddHours(12));
    static readonly DateTimeOffset Midnight = CloudSync.Midnight(Now);
    const string A = "058556050103", B = "058556050102", C = "058556050101";

    readonly string _folder = TempFolder();
    readonly List<string> _log = [];
    readonly List<TimeSpan> _waits = [];

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch (IOException) { }
    }

    Task Fast(TimeSpan t, CancellationToken ct)
    {
        lock (_waits) _waits.Add(t);
        return Task.Delay(5, ct);
    }

    CloudSync Sync(FakeOptiCloud api, StationMode mode = StationMode.Scan, string? password = FakeOptiCloud.Password, StationSettings? settings = null) =>
        new(settings ?? FakeOptiCloud.Settings(mode), password, _folder, m => { lock (_log) _log.Add(m); }, () => Now, api, Fast);

    // What the app does with Loaded: replays it for today.
    static ReplayResult Today(LoadedScans l) => ScanReplay.Replay(l.Events, StationConfig.Defaults, Midnight);

    static List<LoadedScans> Watch(CloudSync sync)
    {
        var loaded = new List<LoadedScans>();
        sync.Loaded += (_, l) => { lock (loaded) loaded.Add(l); };
        return loaded;
    }

    static int Count(List<LoadedScans> loaded) { lock (loaded) return loaded.Count; }

    [Fact(Timeout = 10000)]
    public async Task A_recorded_scan_becomes_a_row()
    {
        var api = new FakeOptiCloud();
        using var sync = Sync(api);
        var loaded = Watch(sync);

        sync.Start();
        await Until(() => sync.Status.State == CloudState.Online && Count(loaded) == 2);
        Assert.True(sync.Record(In(A, 1, Now.AddMinutes(-1))));
        await Until(() => api.RowCount == 1 && sync.Pending == 0);

        Assert.Equal(ScanEvent.Columns.Count, api.Scans.Columns.Count);
        Assert.Equal(A, (string?)api.Scans.Rows[0]["Barcode"]);
        Assert.Equal("Forbundet · Ventisol", sync.Status.Text);
        Assert.Equal(Now, sync.Status.LastSync);
    }

    [Fact(Timeout = 10000)]
    public async Task At_start_what_the_pc_has_is_shown_at_once_then_with_opticloud()
    {
        var api = new FakeOptiCloud();
        api.AddRow(In(A, 1, Now.AddHours(-2)));
        api.AddRow(Out(A, 1, Now.AddHours(-1)));
        api.AddRow(In(B, 2, Now.AddDays(-2)));
        new Outbox(Path.Combine(_folder, "outbox")).Add(In(B, 3, Now.AddMinutes(-5)));
        api.Down = true;
        using var sync = Sync(api);
        var loaded = Watch(sync);

        sync.Start();
        // Before any network.
        Assert.Equal([3], Today(Assert.Single(loaded)).InProgress.Keys);
        await Until(() => sync.Status.State == CloudState.Offline);
        Assert.Equal("Offline · 1 scanning venter", sync.Status.Text);
        api.Down = false;
        await Until(() => Count(loaded) == 2);

        var today = Today(loaded[1]);
        Assert.Single(today.Done);
        Assert.Equal(TimeSpan.FromHours(1), today.Done[0].Duration);
        Assert.Equal([3], today.InProgress.Keys);
        Assert.Equal(Now - CloudSync.Window, loaded[1].Since);
        await Until(() => api.RowCount == 4);
    }

    [Fact(Timeout = 10000)]
    public async Task An_element_in_progress_at_midnight_is_still_there_after_a_restart()
    {
        var api = new FakeOptiCloud();
        api.AddRow(In(A, 1, Midnight.AddHours(-2)));
        api.AddRow(In(B, 2, Midnight.AddHours(-1)));
        api.AddRow(Out(B, 2, Midnight.AddHours(7)));
        api.AddRow(In(C, 3, Midnight.AddHours(-3)));
        api.AddRow(Out(C, 3, Midnight.AddHours(-2.5)));
        // Older than the window: forgotten.
        api.AddRow(In(C, 4, Now.AddHours(-40)));
        using var sync = Sync(api);
        var loaded = Watch(sync);

        sync.Start();
        await Until(() => Count(loaded) == 2);

        var today = Today(loaded[1]);
        Assert.Equal([1], today.InProgress.Keys);
        Assert.Equal(Midnight.AddHours(-2), today.InProgress[1].Since);
        var done = Assert.Single(today.Done);
        Assert.Equal((Code(B), Midnight.AddHours(-1)), (done.Barcode, done.Start));
    }

    [Fact(Timeout = 10000)]
    public async Task A_restart_without_network_shows_what_was_sent_before_from_the_journal()
    {
        var api = new FakeOptiCloud();
        using (var first = Sync(api))
        {
            first.Start();
            first.Record(In(A, 1, Now.AddMinutes(-10)));
            first.Record(Out(A, 1, Now.AddMinutes(-4)));
            await Until(() => api.RowCount == 2 && first.Pending == 0);
        }
        Assert.Single(Directory.GetFiles(Path.Combine(_folder, "journal"), $"{Now:yyyy-MM-dd}.jsonl"));

        api.Down = true;
        using var sync = Sync(api);
        var loaded = Watch(sync);
        sync.Start();

        var today = Today(Assert.Single(loaded));
        Assert.Equal(TimeSpan.FromMinutes(6), Assert.Single(today.Done).Duration);
    }

    [Fact(Timeout = 10000)]
    public async Task A_viewer_keeps_no_journal_and_shows_nothing_before_it_has_read()
    {
        var api = new FakeOptiCloud { Down = true };
        using var sync = Sync(api, StationMode.Viewer);
        var loaded = Watch(sync);

        sync.Start();
        await Until(() => sync.Status.State == CloudState.Offline);

        Assert.Empty(loaded);
        Assert.False(sync.Record(In(A, 1, Now)));
        Assert.False(Directory.Exists(Path.Combine(_folder, "journal")));
    }

    [Fact(Timeout = 10000)]
    public async Task A_pc_switched_to_viewer_still_sends_what_waits()
    {
        new Outbox(Path.Combine(_folder, "outbox")).Add(In(A, 1, Now.AddMinutes(-3)));
        var api = new FakeOptiCloud();
        using var sync = Sync(api, StationMode.Viewer);

        sync.Start();

        await Until(() => api.RowCount == 1 && sync.Pending == 0);
    }

    [Fact(Timeout = 10000)]
    public async Task A_viewer_polls_and_tells_when_something_changed()
    {
        var api = new FakeOptiCloud();
        api.AddRow(In(A, 1, Now.AddMinutes(-30)));
        using var sync = Sync(api, StationMode.Viewer);
        var loaded = Watch(sync);

        sync.Start();
        await Until(() => Count(loaded) == 1);
        Assert.Equal(Code(A), Today(loaded[0]).InProgress[1].Barcode);

        var polls = api.Count("GetRowsPaged");
        await Until(() => api.Count("GetRowsPaged") > polls + 2);
        Assert.Single(loaded);

        api.AddRow(Out(A, 1, Now.AddMinutes(-2)));
        await Until(() => Count(loaded) == 2);
        Assert.Empty(Today(loaded[1]).InProgress);
        Assert.Single(Today(loaded[1]).Done);
        Assert.Equal(0, api.Count("CreateRow"));
    }

    [Fact(Timeout = 10000)]
    public async Task A_viewer_also_sees_scans_sent_late()
    {
        var api = new FakeOptiCloud();
        api.AddRow(In(A, 1, Now.AddMinutes(-1)));
        using var sync = Sync(api, StationMode.Viewer);
        var loaded = Watch(sync);
        sync.Start();
        await Until(() => Count(loaded) == 1);

        // Scanned hours ago at a station that was offline, sent now.
        api.AddRow(In(B, 2, Now.AddHours(-3)));
        api.AddRow(Out(B, 2, Now.AddHours(-2)));

        await Until(() => Count(loaded) == 2);
        Assert.Single(Today(loaded[1]).Done);
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
    public async Task A_wrong_password_is_an_error_and_is_tried_again_every_quarter_of_an_hour()
    {
        var api = new FakeOptiCloud();
        using var sync = Sync(api, password: "forkert");

        sync.Start();
        await Until(() => sync.Status.State == CloudState.Error);
        await Until(() => api.LoginCount("password") > 2);

        Assert.Equal("Fejl: " + OptiCloudException.BadLogin, sync.Status.Text);
        Assert.Single(_log, l => l.Contains(OptiCloudException.BadLogin));
        Assert.DoesNotContain(_log, l => l.Contains("forkert"));
        lock (_waits) Assert.All(_waits, w => Assert.Equal(TimeSpan.FromMinutes(15), w));
    }

    [Fact(Timeout = 10000)]
    public async Task A_user_without_access_is_an_error_and_the_scan_waits_for_it_to_be_fixed()
    {
        var api = new FakeOptiCloud { Override = (_, path, _) => path.Contains("CreateRow") ? new HttpResponseMessage(HttpStatusCode.Forbidden) : null };
        using var sync = Sync(api);
        sync.Start();
        await Until(() => sync.Status.State == CloudState.Online);

        sync.Record(In(A, 1, Now));
        await Until(() => api.Count("CreateRow") > 4 && sync.Status.State == CloudState.Error);

        Assert.Equal("Fejl: " + OptiCloudException.Forbidden + " · 1 scanning venter", sync.Status.Text);
        Assert.Equal((1, 0), (sync.Pending, sync.Status.Failed));
        api.Override = null;
        await Until(() => api.RowCount == 1 && sync.Status.State == CloudState.Online);
    }

    [Fact(Timeout = 10000)]
    public async Task A_refused_scan_is_counted_and_sent_again_after_a_restart()
    {
        var api = new FakeOptiCloud
        {
            Override = (_, path, _) => path.Contains("CreateRow")
                ? FakeOptiCloud.Json(new { errors = new[] { new { title = "Bad", message = "Ugyldig værdi" } } })
                : null,
        };
        using (var sync = Sync(api))
        {
            var statuses = new List<CloudStatus>();
            sync.StatusChanged += (_, s) => { lock (statuses) statuses.Add(s); };
            sync.Start();
            sync.Record(In(A, 1, Now));
            await Until(() => sync.Status.Failed == 1);
            await Until(() => sync.Status.State == CloudState.Online);

            Assert.Equal(Outbox.RefusalsBeforeAside, api.Count("CreateRow"));
            Assert.Equal("Forbundet · 1 scanning afvist, se log", sync.Status.Text);
            Assert.Equal(0, sync.Pending);
            lock (statuses) Assert.Contains(statuses, s => s.Failed == 1);
        }

        api.Override = null;
        using var again = Sync(api);
        again.Start();
        await Until(() => api.RowCount == 1 && again.Pending == 0);
        Assert.Equal(0, again.Status.Failed);
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
