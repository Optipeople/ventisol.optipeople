using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public sealed class MachineOrdersTests : IDisposable
{
    static readonly DateTimeOffset T0 = new(2026, 11, 10, 8, 0, 0, TimeSpan.FromHours(1));
    static readonly TimeSpan Settle = MachineOrders.DefaultSettle;
    static readonly Guid M1 = Guid.Parse("a1000000-0000-4000-8000-000000000010"), M2 = Guid.Parse("a1000000-0000-4000-8000-000000000020");

    readonly string _folder = TempFolder();
    readonly List<string> _log = [];
    DateTimeOffset _now = T0;

    public void Dispose()
    {
        try { Directory.Delete(_folder, recursive: true); } catch (IOException) { }
    }

    // OptiPeople as the live test found it: what a machine has, and every set that got in.
    // Like the real call, a set of the same number again counts as a new run.
    sealed class FakeApi : IMachineOrderApi
    {
        public Dictionary<Guid, string> Current { get; } = [];
        public List<(Guid Machine, string Number)> Sets { get; } = [];
        public int Reads;
        public Exception? FailRead, FailSet;
        // The set gets in, but the answer is lost (a timeout after the request went out).
        public bool LoseAnswer;

        public Task<string> GetCurrentOrderAsync(Guid machineId, CancellationToken ct = default)
        {
            Reads++;
            if (FailRead is { } x) throw x;
            return Task.FromResult(Current.GetValueOrDefault(machineId, ""));
        }

        public Task SetOrderToMachineAsync(Guid machineId, string number, CancellationToken ct = default)
        {
            if (FailSet is { } x) throw x;
            Current[machineId] = number;
            Sets.Add((machineId, number));
            if (LoseAnswer) throw new OptiCloudException(OptiCloudException.Unreachable + " (intet svar)");
            return Task.CompletedTask;
        }
    }

    MachineOrderSync Worker(MachineOrders orders, FakeApi api) => new(orders, api, _log.Add, () => _now);

    // Runs every step that is due now.
    static async Task<int> Drain(MachineOrderSync worker)
    {
        var steps = 0;
        while (await worker.RunOnceAsync())
            if (++steps > 50) throw new InvalidOperationException("never settles");
        return steps;
    }

    static readonly Exception NoNetwork = new OptiCloudException(OptiCloudException.Unreachable);

    [Fact]
    public async Task Scan_in_sets_the_order_once_it_has_settled()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);

        orders.Want(M1, "58556", _now);
        Assert.Equal(0, await Drain(worker));

        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, "58556")], api.Sets);
        Assert.Equal(1, api.Reads);

        _now += TimeSpan.FromMinutes(5);
        Assert.Equal(0, await Drain(worker));
    }

    [Fact]
    public async Task Scan_out_clears_the_machine_after_settle()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, "", _now);
        _now += Settle - TimeSpan.FromSeconds(1);
        Assert.Equal(0, await Drain(worker));
        _now += TimeSpan.FromSeconds(1);
        await Drain(worker);

        Assert.Equal([(M1, "58556"), (M1, "")], api.Sets);
    }

    [Fact]
    public async Task Out_then_In_of_the_same_order_within_settle_sends_nothing()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, "", _now);
        _now += TimeSpan.FromSeconds(1);
        orders.Want(M1, "58556", _now);
        _now += TimeSpan.FromMinutes(1);
        Assert.Equal(0, await Drain(worker));

        Assert.Single(api.Sets);
    }

    [Fact]
    public async Task A_quick_switch_sends_only_the_new_order()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, "", _now);
        _now += TimeSpan.FromSeconds(1);
        orders.Want(M1, "60001", _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, "58556"), (M1, "60001")], api.Sets);
    }

    [Fact]
    public async Task The_same_order_is_never_sent_again()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);

        // Every scan and every reload of the screen wishes it again.
        for (var i = 0; i < 5; i++)
        {
            orders.Want(M1, "58556", _now);
            _now += Settle;
            Assert.Equal(0, await Drain(worker));
        }
        Assert.Single(api.Sets);
        Assert.Equal(1, api.Reads);
    }

    [Fact]
    public async Task Stations_on_different_machines_are_independent()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);

        orders.Want(M1, "58556", _now);
        _now += TimeSpan.FromSeconds(2);
        orders.Want(M2, "60001", _now);
        _now += TimeSpan.FromSeconds(1);
        await Drain(worker);
        Assert.Equal([(M1, "58556")], api.Sets);

        // M1 is cleared while M2 settles, and the other way round: neither holds the other back.
        orders.Want(M1, "", _now);
        _now += TimeSpan.FromSeconds(2);
        await Drain(worker);
        Assert.Equal([(M1, "58556"), (M2, "60001")], api.Sets);

        _now += TimeSpan.FromSeconds(1);
        await Drain(worker);
        Assert.Equal([(M1, "58556"), (M2, "60001"), (M1, "")], api.Sets);
    }

    [Fact]
    public async Task A_failure_waits_with_backoff_reads_back_and_sends_the_newest_wish()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailSet = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);
        Assert.Empty(api.Sets);
        Assert.Equal(Outbox.Backoff[0], orders.DueIn(_now));

        // Still down: the wait grows.
        _now += Outbox.Backoff[0];
        await Drain(worker);
        Assert.Equal(Outbox.Backoff[1], orders.DueIn(_now));

        // Meanwhile the element is finished and another started; the network comes back.
        orders.Want(M1, "60001", _now);
        api.FailSet = null;
        var reads = api.Reads;
        _now += Outbox.Backoff[1];
        await Drain(worker);

        Assert.Equal([(M1, "60001")], api.Sets);
        Assert.Equal(reads + 1, api.Reads);
        // The same failure on every retry is logged once.
        Assert.Single(_log, l => l.Contains(OptiCloudException.Unreachable));
    }

    [Fact]
    public async Task A_set_with_an_unknown_outcome_is_read_back_and_not_sent_again()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { LoseAnswer = true };
        var worker = Worker(orders, api);

        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);
        api.LoseAnswer = false;

        _now += TimeSpan.FromMinutes(1);
        await Drain(worker);

        // It got in the first time: the read shows it, so no second run is started.
        Assert.Equal([(M1, "58556")], api.Sets);
        Assert.Equal(2, api.Reads);
    }

    [Fact]
    public async Task After_a_restart_each_machine_is_read_and_set_only_when_it_differs()
    {
        var api = new FakeApi();
        api.Current[M1] = "58556";
        api.Current[M2] = "77777";
        var m3 = Guid.NewGuid();

        // A new start: the screen is rebuilt from the journal and wishes every mapped machine.
        var orders = new MachineOrders();
        var worker = Worker(orders, api);
        orders.Want(new Dictionary<Guid, string> { [M1] = "58556", [M2] = "", [m3] = "" }, _now);
        _now += Settle;
        await Drain(worker);

        // M1 already runs it, m3 has nothing: left alone. M2 had an order and nothing is in progress: cleared.
        Assert.Equal([(M2, "")], api.Sets);
        Assert.Equal(3, api.Reads);

        _now += TimeSpan.FromMinutes(1);
        Assert.Equal(0, await Drain(worker));
    }

    [Fact]
    public async Task A_read_that_is_refused_sets_without_reading_once()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailRead = new OptiCloudException("OptiCloud kender ikke adressen (404)", 404, rejected: true) };
        var worker = Worker(orders, api);

        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);
        _now += TimeSpan.FromMinutes(1);
        await Drain(worker);

        Assert.Equal([(M1, "58556")], api.Sets);
        Assert.Equal(1, api.Reads);
    }

    [Fact]
    public async Task A_read_that_fails_for_the_network_waits_and_sends_nothing()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailRead = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, "58556", _now);
        _now += Settle;
        await Drain(worker);

        Assert.Empty(api.Sets);
        Assert.Equal(Outbox.Backoff[0], orders.DueIn(_now));
    }

    [Fact]
    public void Desired_is_the_order_in_progress_per_mapped_machine()
    {
        var setups = new[]
        {
            new StationSetup(1, "Station 10", StationKind.Assembly, M1),
            new StationSetup(2, "Station 20", StationKind.Assembly, M2),
            new StationSetup(3, "Station 30", StationKind.Assembly),
        };
        var states = StationConfig.Defaults.Take(3).Select(c => new StationState(c)).ToList();
        states[0].Scan(Code("058556050103"), T0);
        states[2].Scan(Code("060001010101"), T0);

        var desired = MachineOrders.DesiredFrom(setups, states);

        Assert.Equal(2, desired.Count);
        Assert.Equal("58556", desired[M1]);
        Assert.Equal("", desired[M2]);
    }

    [Fact]
    public void A_station_that_switches_element_gives_its_machine_the_new_order()
    {
        var setups = new[] { new StationSetup(1, "Station 10", StationKind.Assembly, M1) };
        var state = new StationState(StationConfig.Defaults[0]);
        state.Scan(Code("058556050103"), T0);
        state.Scan(Code("060001010101"), T0.AddMinutes(1));

        Assert.Equal("60001", MachineOrders.DesiredFrom(setups, [state])[M1]);

        state.Scan(Code("060001010101"), T0.AddMinutes(2));
        Assert.Equal("", MachineOrders.DesiredFrom(setups, [state])[M1]);
    }

    // CloudSync end to end against the fake API, with a clock that moves.
    CloudSync Sync(FakeOptiCloud api, StationMode mode) =>
        new(FakeOptiCloud.Settings(mode), FakeOptiCloud.Password, _folder, m => { lock (_log) _log.Add(m); }, () => _now, api,
            (t, ct) => Task.Delay(5, ct));

    [Fact(Timeout = 10000)]
    public async Task A_scan_station_sets_and_clears_the_machine_in_OptiCloud()
    {
        var api = new FakeOptiCloud();
        var machine = api.Machines[1].Id;
        using var sync = Sync(api, StationMode.Scan);
        sync.Start();
        await Until(() => sync.Status.State == CloudState.Online);

        sync.SetMachineOrders(new Dictionary<Guid, string> { [machine] = "58556" });
        _now += Settle;
        await Until(() => api.Sets.Length == 1);
        Assert.Equal((machine, "58556"), api.Sets[0]);
        Assert.Contains(api.Requests.ToList(), r => r.Path.Contains("SetOrderToMachine") && r.Body!.Contains("\"number\":\"58556\"") && r.Body.Contains("\"expectedSpeed\":0"));

        sync.SetMachineOrders(new Dictionary<Guid, string> { [machine] = "" });
        _now += Settle;
        await Until(() => api.Sets.Length == 2);
        Assert.Equal((machine, ""), api.Sets[1]);
    }

    [Fact(Timeout = 10000)]
    public async Task A_viewer_never_sets_an_order()
    {
        var api = new FakeOptiCloud();
        using var sync = Sync(api, StationMode.Viewer);
        sync.Start();
        await Until(() => sync.Status.State == CloudState.Online && api.Count("GetRowsPaged") > 0);

        sync.SetMachineOrders(new Dictionary<Guid, string> { [api.Machines[1].Id] = "58556" });
        _now += Settle;
        await Task.Delay(300);

        Assert.Equal(0, api.Count("RealtimeDashboard"));
    }

    [Fact]
    public async Task The_client_reads_no_order_in_both_shapes_OptiCloud_uses()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var machine = api.Machines[0].Id;

        Assert.Equal("", await client.GetCurrentOrderAsync(machine));
        await client.SetOrderToMachineAsync(machine, "58556");
        Assert.Equal("58556", await client.GetCurrentOrderAsync(machine));
        await client.SetOrderToMachineAsync(machine, "");
        Assert.Equal("", await client.GetCurrentOrderAsync(machine));
    }
}
