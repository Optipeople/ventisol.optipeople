using Ventisol.Station.Core;
using Ventisol.Station.Core.Cloud;
using static Ventisol.Station.Tests.TestScans;

namespace Ventisol.Station.Tests;

public sealed class MachineOrdersTests : IDisposable
{
    static readonly DateTimeOffset T0 = new(2026, 11, 10, 8, 0, 0, TimeSpan.FromHours(1));
    static readonly TimeSpan Settle = MachineOrders.DefaultSettle;
    static readonly Guid M1 = Guid.Parse("a1000000-0000-4000-8000-000000000010"), M2 = Guid.Parse("a1000000-0000-4000-8000-000000000020");

    // Elements by barcode: A and A2 are two pieces of one order, B and C other orders.
    const string A = "058556050103", A2 = "058556050104", B = "060001010101", C = "077777010101";

    static MachineOrder E(string barcode, DateTimeOffset? scannedIn = null) => MachineOrder.From(Code(barcode), scannedIn ?? T0);

    // "Scannet ind" as the station PC writes it: its own local time.
    static string Local(DateTimeOffset at) => TimeZoneInfo.ConvertTime(at, TimeZoneInfo.Local).ToString(MachineOrder.ScannedInFormat, System.Globalization.CultureInfo.InvariantCulture);

    static string ScannedIn(MachineOrder order) => order.Fields.Single(f => f.Name == "Scannet ind").Value;

    readonly string _folder = TempFolder();
    readonly List<string> _log = [];
    // The test moves the clock while the sync's loops read it on other threads: a DateTimeOffset is two words,
    // so reads and writes go through a lock and a loop never sees half a time.
    readonly Lock _clockGate = new();
    DateTimeOffset _clock = T0;
    DateTimeOffset _now
    {
        get { lock (_clockGate) return _clock; }
        set { lock (_clockGate) _clock = value; }
    }

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

        // Machines the read answers with no data at all for.
        public HashSet<Guid> NoData { get; } = [];

        public Task<string?> GetCurrentOrderAsync(Guid machineId, CancellationToken ct = default)
        {
            Reads++;
            if (FailRead is { } x) throw x;
            return Task.FromResult(NoData.Contains(machineId) ? null : Current.GetValueOrDefault(machineId, ""));
        }

        public Task SetOrderToMachineAsync(Guid machineId, MachineOrder order, CancellationToken ct = default)
        {
            if (FailSet is { } x) throw x;
            Current[machineId] = order.Number;
            Sets.Add((machineId, order.Number));
            if (LoseAnswer) throw new OptiCloudException(OptiCloudException.Unreachable + " (intet svar)");
            return Task.CompletedTask;
        }

        // Every fields call that got in, by order number. Never touches Current: the run is left alone.
        public List<(Guid Machine, string Number, IReadOnlyList<OrderField> Fields)> FieldSets { get; } = [];
        public Exception? FailFields;

        public Task SetOrderFieldsAsync(Guid machineId, MachineOrder order, CancellationToken ct = default)
        {
            if (FailFields is { } x) throw x;
            FieldSets.Add((machineId, order.Number, order.Fields));
            return Task.CompletedTask;
        }

        public string[] FieldNumbers => [.. FieldSets.Select(f => f.Number)];
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

        orders.Want(M1, E(A), _now);
        Assert.Equal(0, await Drain(worker));

        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A)], api.Sets);
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
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, MachineOrder.None, _now);
        _now += Settle - TimeSpan.FromSeconds(1);
        Assert.Equal(0, await Drain(worker));
        _now += TimeSpan.FromSeconds(1);
        await Drain(worker);

        Assert.Equal([(M1, A), (M1, "")], api.Sets);
    }

    [Fact]
    public async Task Out_then_In_of_the_same_element_within_settle_sends_nothing()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, MachineOrder.None, _now);
        _now += TimeSpan.FromSeconds(1);
        orders.Want(M1, E(A), _now);
        _now += TimeSpan.FromMinutes(1);
        Assert.Equal(0, await Drain(worker));

        Assert.Single(api.Sets);
    }

    [Fact]
    public async Task A_quick_switch_sends_only_the_new_element()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, MachineOrder.None, _now);
        _now += TimeSpan.FromSeconds(1);
        orders.Want(M1, E(B), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, A), (M1, B)], api.Sets);
    }

    [Fact]
    public async Task Switching_to_another_element_of_the_same_order_sends_the_new_element()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        // Straight from one piece to the next, and Out of it then In of a third within settle.
        orders.Want(M1, E(A2), _now);
        _now += Settle;
        await Drain(worker);
        orders.Want(M1, MachineOrder.None, _now);
        _now += TimeSpan.FromSeconds(1);
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, A), (M1, A2), (M1, A)], api.Sets);
        Assert.Equal(1, api.Reads);
    }

    [Fact]
    public async Task The_same_order_is_never_sent_again()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        // Every scan and every reload of the screen wishes it again.
        for (var i = 0; i < 5; i++)
        {
            orders.Want(M1, E(A), _now);
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

        orders.Want(M1, E(A), _now);
        _now += TimeSpan.FromSeconds(2);
        orders.Want(M2, E(B), _now);
        _now += TimeSpan.FromSeconds(1);
        await Drain(worker);
        Assert.Equal([(M1, A)], api.Sets);

        // M1 is cleared while M2 settles, and the other way round: neither holds the other back.
        orders.Want(M1, MachineOrder.None, _now);
        _now += TimeSpan.FromSeconds(2);
        await Drain(worker);
        Assert.Equal([(M1, A), (M2, B)], api.Sets);

        _now += TimeSpan.FromSeconds(1);
        await Drain(worker);
        Assert.Equal([(M1, A), (M2, B), (M1, "")], api.Sets);
    }

    [Fact]
    public async Task A_failure_waits_with_backoff_reads_back_and_sends_the_newest_wish()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailSet = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Empty(api.Sets);
        Assert.Equal(Outbox.Backoff[0], orders.DueIn(_now));

        // Still down: the wait grows.
        _now += Outbox.Backoff[0];
        await Drain(worker);
        Assert.Equal(Outbox.Backoff[1], orders.DueIn(_now));

        // Meanwhile the element is finished and another started; the network comes back.
        orders.Want(M1, E(B), _now);
        api.FailSet = null;
        var reads = api.Reads;
        _now += Outbox.Backoff[1];
        await Drain(worker);

        Assert.Equal([(M1, B)], api.Sets);
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

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        api.LoseAnswer = false;

        _now += TimeSpan.FromMinutes(1);
        await Drain(worker);

        // It got in the first time: the read shows it, so no second run is started.
        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal(2, api.Reads);
    }

    [Fact]
    public async Task After_a_restart_each_machine_is_read_and_set_only_when_it_differs()
    {
        var api = new FakeApi();
        api.Current[M1] = A;
        api.Current[M2] = C;
        var m3 = Guid.NewGuid();

        // A new start: the screen is rebuilt from the journal and wishes every mapped machine.
        var orders = new MachineOrders();
        var worker = Worker(orders, api);
        orders.Want(new Dictionary<Guid, MachineOrder> { [M1] = E(A), [M2] = MachineOrder.None, [m3] = MachineOrder.None }, _now);
        _now += Settle;
        await Drain(worker);

        // M1 already runs it, m3 has nothing: left alone. M2 had an order and nothing is in progress: cleared.
        Assert.Equal([(M2, "")], api.Sets);
        Assert.Equal(3, api.Reads);

        _now += TimeSpan.FromMinutes(1);
        Assert.Equal(0, await Drain(worker));
    }

    [Fact]
    public async Task A_refused_read_never_sets_blind_and_keeps_reading_with_backoff()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailRead = new OptiCloudException("OptiCloud kender ikke adressen (404)", 404, rejected: true) };
        api.Current[M1] = A;
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        for (var i = 0; i < 6; i++)
        {
            await Drain(worker);
            _now += TimeSpan.FromMinutes(1);
        }

        // Never set while unknown: the machine may run it already, and a set would split the run.
        Assert.Empty(api.Sets);
        Assert.Equal(6, api.Reads);
        Assert.Single(_log);

        // Once it can be read, it is in step and nothing is sent.
        api.FailRead = null;
        await Drain(worker);
        Assert.Empty(api.Sets);
    }

    [Fact]
    public async Task A_read_and_a_set_failing_alike_in_turn_log_once()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailSet = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        api.FailRead = NoNetwork;
        for (var i = 0; i < 3; i++)
        {
            _now += TimeSpan.FromMinutes(1);
            await Drain(worker);
        }
        api.FailRead = null;
        _now += TimeSpan.FromMinutes(1);
        await Drain(worker);

        Assert.Single(_log);
    }

    [Fact]
    public async Task Nothing_is_sent_while_held_and_the_wish_at_release_counts()
    {
        var orders = new MachineOrders(held: true);
        var api = new FakeApi();
        api.Current[M1] = A;
        var worker = Worker(orders, api);

        // The journal alone has nothing in progress...
        orders.Want(M1, MachineOrder.None, _now);
        _now += TimeSpan.FromMinutes(1);
        Assert.Equal(0, await Drain(worker));

        // ...OptiCloud's 36 hours still have the element in progress.
        orders.Want(M1, E(A), _now);
        orders.Release();
        _now += Settle;
        await Drain(worker);

        Assert.Empty(api.Sets);
        Assert.Equal(1, api.Reads);
    }

    [Fact]
    public async Task A_read_that_fails_for_the_network_waits_and_sends_nothing()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailRead = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Empty(api.Sets);
        Assert.Equal(Outbox.Backoff[0], orders.DueIn(_now));
    }

    [Fact]
    public async Task A_set_is_followed_by_the_fields_of_the_element_and_a_clear_by_none()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal([A], api.FieldNumbers);
        Assert.Equal(E(A).Fields, api.FieldSets[0].Fields);
        Assert.Empty(orders.PendingFields(M1));

        // The same element wished again sends neither; a clear has no fields.
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        orders.Want(M1, MachineOrder.None, _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A), (M1, "")], api.Sets);
        Assert.Equal([A], api.FieldNumbers);
    }

    [Fact]
    public async Task A_failed_fields_call_is_retried_with_backoff_and_never_sets_again()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailFields = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal([A], orders.PendingFields(M1));
        Assert.Equal(Outbox.Backoff[0], orders.DueIn(_now));

        _now += Outbox.Backoff[0];
        await Drain(worker);
        Assert.Equal(Outbox.Backoff[1], orders.DueIn(_now));

        api.FailFields = null;
        _now += Outbox.Backoff[1];
        await Drain(worker);

        // The run was never split: one set, one read, and the fields got in once.
        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal(1, api.Reads);
        Assert.Equal([A], api.FieldNumbers);
        Assert.Null(orders.DueIn(_now));
        Assert.Single(_log, l => l.Contains(OptiCloudException.Unreachable));
    }

    [Fact]
    public async Task Fields_of_an_element_the_machine_has_left_are_still_sent_in_order()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailFields = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        orders.Want(M1, E(A2), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A), (M1, A2)], api.Sets);
        Assert.Equal([A, A2], orders.PendingFields(M1));

        api.FailFields = null;
        _now += TimeSpan.FromMinutes(1);
        await Drain(worker);

        Assert.Equal([A, A2], api.FieldNumbers);
        Assert.Equal([(M1, A), (M1, A2)], api.Sets);
    }

    [Fact]
    public async Task A_failed_fields_call_does_not_hold_back_a_set()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailFields = NoNetwork };
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        // Fields wait for their backoff; the next element is set as soon as it has settled.
        orders.Want(M1, E(B), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A), (M1, B)], api.Sets);
    }

    [Fact]
    public async Task A_machine_found_running_the_element_still_gets_its_fields()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        api.Current[M1] = A;
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Empty(api.Sets);
        Assert.Equal([A], api.FieldNumbers);
    }

    [Fact]
    public void At_most_the_newest_fields_wait_per_machine()
    {
        var orders = new MachineOrders();
        for (var i = 1; i <= MachineOrders.MaxPendingFields + 2; i++)
        {
            var number = $"0585560501{i:00}";
            orders.Want(M1, E(number), _now);
            orders.Sent(M1, E(number));
        }

        var pending = orders.PendingFields(M1);
        Assert.Equal(MachineOrders.MaxPendingFields, pending.Count);
        Assert.Equal("058556050103", pending[0]);
    }

    [Fact]
    public void Desired_is_the_element_in_progress_per_mapped_machine()
    {
        var setups = new[]
        {
            new StationSetup(1, "Station 10", StationKind.Assembly, M1),
            new StationSetup(2, "Station 20", StationKind.Assembly, M2),
            new StationSetup(3, "Station 30", StationKind.Assembly),
        };
        var states = StationConfig.Defaults.Take(3).Select(c => new StationState(c)).ToList();
        states[0].Scan(Code(A), T0);
        states[2].Scan(Code(B), T0);

        var desired = MachineOrders.DesiredFrom(setups, states);

        Assert.Equal(2, desired.Count);
        Assert.Equal(A, desired[M1].Number);
        Assert.Equal(Local(T0), ScannedIn(desired[M1]));
        Assert.Equal("", desired[M2].Number);
        Assert.Empty(desired[M2].Fields);
    }

    [Fact]
    public void Scannet_ind_is_the_In_of_the_element_in_progress_also_after_a_restart()
    {
        var setups = new[] { new StationSetup(1, "Station 10", StationKind.Assembly, M1) };
        var state = new StationState(StationConfig.Defaults[0]);

        // Rebuilt from the journal or OptiCloud: the In time comes with it, not the time of the rebuild.
        state.Restore(Code(A), T0.AddHours(-2));
        Assert.Equal(Local(T0.AddHours(-2)), ScannedIn(MachineOrders.DesiredFrom(setups, [state])[M1]));

        // A rework: Out, then In again later. Same order, new In.
        state.Scan(Code(A), T0);
        state.Scan(Code(A), T0.AddMinutes(5));
        var again = MachineOrders.DesiredFrom(setups, [state])[M1];
        Assert.Equal(A, again.Number);
        Assert.Equal(Local(T0.AddMinutes(5)), ScannedIn(again));
    }

    [Fact]
    public void The_order_is_the_full_barcode_with_its_parts_as_fields()
    {
        var danish = TimeZoneInfo.FindSystemTimeZoneById("Europe/Copenhagen");
        var order = MachineOrder.From(Code("058556050103"), new DateTimeOffset(2026, 11, 10, 7, 5, 9, TimeSpan.Zero), danish);

        Assert.Equal("058556050103", order.Number);
        Assert.Equal([new("Ordre", "58556"), new("Position", "5"), new("Underposition", "1"), new("Emne", "3"), new("Scannet ind", "2026-11-10 08:05:09")], order.Fields);

        // Summer time: two hours on UTC, still no offset in the text.
        var summer = MachineOrder.From(Code("058556050103"), new DateTimeOffset(2026, 7, 1, 21, 30, 0, TimeSpan.Zero), danish);
        Assert.Equal("2026-07-01 23:30:00", ScannedIn(summer));
    }

    [Fact]
    public async Task A_new_In_of_the_running_element_sends_its_fields_again_but_never_sets()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, E(A, T0), _now);
        _now += Settle;
        await Drain(worker);

        // The same element wished with another In (a rework re-scan that reached the screen as one change).
        var later = T0.AddMinutes(10);
        orders.Want(M1, E(A, later), _now);
        await Drain(worker);

        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal([A, A], api.FieldNumbers);
        Assert.Equal(Local(later), ScannedIn(new MachineOrder(A, api.FieldSets[1].Fields)));

        // And the same wish again sends nothing more.
        orders.Want(M1, E(A, later), _now);
        _now += Settle;
        Assert.Equal(0, await Drain(worker));
    }

    [Fact]
    public async Task Out_and_In_of_the_same_element_within_settle_keeps_the_first_In()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, E(A, T0), _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, MachineOrder.None, _now);
        _now += TimeSpan.FromSeconds(1);
        orders.Want(M1, E(A, _now), _now);
        _now += TimeSpan.FromMinutes(1);
        Assert.Equal(0, await Drain(worker));

        // The run in OptiPeople kept its start, and so did its fields.
        Assert.Single(api.Sets);
        Assert.Equal([A], api.FieldNumbers);
    }

    [Fact]
    public async Task A_rework_after_settle_is_a_new_run_with_the_new_In()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        var worker = Worker(orders, api);
        orders.Want(M1, E(A, T0), _now);
        _now += Settle;
        await Drain(worker);

        orders.Want(M1, MachineOrder.None, _now);
        _now += Settle;
        await Drain(worker);
        var again = _now;
        orders.Want(M1, E(A, again), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, A), (M1, ""), (M1, A)], api.Sets);
        Assert.Equal(Local(again), ScannedIn(new MachineOrder(A, api.FieldSets[^1].Fields)));
    }

    [Fact]
    public async Task Fields_still_waiting_are_replaced_by_the_newest_for_the_same_element()
    {
        var orders = new MachineOrders();
        var api = new FakeApi { FailFields = NoNetwork };
        var worker = Worker(orders, api);
        orders.Want(M1, E(A, T0), _now);
        _now += Settle;
        await Drain(worker);

        var later = T0.AddMinutes(10);
        orders.Want(M1, E(A, later), _now);
        Assert.Equal([A], orders.PendingFields(M1));

        api.FailFields = null;
        _now += TimeSpan.FromMinutes(1);
        await Drain(worker);

        Assert.Single(api.FieldSets);
        Assert.Equal(Local(later), ScannedIn(new MachineOrder(A, api.FieldSets[0].Fields)));
    }

    static readonly TimeSpan Verify = MachineOrders.DefaultVerify;

    // A machine in step on A, set by the app, with its fields sent. Changes reported go to changes.
    async Task<(MachineOrders Orders, FakeApi Api, MachineOrderSync Worker)> InStepOnA(List<MachineOrderChange> changes)
    {
        var orders = new MachineOrders(verify: Verify);
        var api = new FakeApi();
        var worker = new MachineOrderSync(orders, api, _log.Add, () => _now, changed: changes.Add);
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A)], api.Sets);
        return (orders, api, worker);
    }

    [Fact]
    public async Task A_machine_in_step_is_read_again_every_verify_and_left_alone_while_it_runs_the_element()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, worker) = await InStepOnA(changes);
        var reads = api.Reads;

        _now += Verify - TimeSpan.FromSeconds(1);
        Assert.Equal(0, await Drain(worker));
        _now += TimeSpan.FromSeconds(1);
        Assert.Equal(1, await Drain(worker));
        _now += Verify;
        Assert.Equal(1, await Drain(worker));

        Assert.Equal(reads + 2, api.Reads);
        Assert.Single(api.Sets);
        Assert.Empty(changes);
    }

    // Two verify reads, one verify apart: what it takes for a stop in OptiPeople to count.
    async Task VerifyTwice(MachineOrderSync worker)
    {
        _now += Verify;
        await Drain(worker);
        _now += Verify;
        await Drain(worker);
    }

    [Fact]
    public async Task One_odd_verify_read_does_not_end_the_element()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, worker) = await InStepOnA(changes);

        // OptiPeople answers "no order" once, and then has the element again.
        api.Current[M1] = "";
        _now += Verify;
        Assert.Equal(1, await Drain(worker));
        Assert.Empty(changes);
        Assert.Null(orders.StoppedOn(M1));
        Assert.Equal(A, orders.Snapshot()[M1].Known);
        api.Current[M1] = A;
        _now += Verify;
        await Drain(worker);

        // Odd again later: that is one read once more, not the second in a row.
        api.Current[M1] = "";
        _now += Verify;
        await Drain(worker);
        Assert.Empty(changes);

        // Two reads that differ from each other are not two that agree either.
        api.Current[M1] = C;
        _now += Verify;
        await Drain(worker);
        Assert.Empty(changes);
        Assert.Equal([(M1, A)], api.Sets);

        // The next read finds C too: now it is so.
        _now += Verify;
        await Drain(worker);
        Assert.Equal([new MachineOrderChange(M1, A, C)], changes);
        Assert.Equal([(M1, A)], api.Sets);
    }

    [Fact]
    public async Task Verify_reads_with_no_data_never_end_the_element()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, worker) = await InStepOnA(changes);

        // No data at all, read after read: nothing is decided and nothing is set.
        api.NoData.Add(M1);
        for (var i = 0; i < 5; i++)
        {
            _now += Verify;
            Assert.Equal(1, await Drain(worker));
        }
        Assert.Empty(changes);
        Assert.Null(orders.StoppedOn(M1));
        Assert.Equal(A, orders.Snapshot()[M1].Known);
        Assert.Equal([(M1, A)], api.Sets);
        // Said once, not on every read.
        Assert.Single(_log, l => l.Contains("svaret var tomt"));

        // "No order", then no data, then "no order": the two that agree are not in a row.
        api.NoData.Clear();
        api.Current[M1] = "";
        _now += Verify;
        await Drain(worker);
        api.NoData.Add(M1);
        _now += Verify;
        await Drain(worker);
        api.NoData.Clear();
        _now += Verify;
        await Drain(worker);
        Assert.Empty(changes);

        // And the next one makes two in a row.
        _now += Verify;
        await Drain(worker);
        Assert.Equal([new MachineOrderChange(M1, A, "")], changes);
    }

    [Fact]
    public async Task A_read_with_no_data_does_not_keep_an_order_off_the_machine()
    {
        var orders = new MachineOrders();
        var api = new FakeApi();
        api.NoData.Add(M1);
        var worker = Worker(orders, api);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal(A, orders.Snapshot()[M1].Known);

        // And the next element too.
        orders.Want(M1, E(B), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A), (M1, B)], api.Sets);
    }

    [Fact]
    public async Task An_order_stopped_in_OptiPeople_is_reported_and_never_set_back()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, worker) = await InStepOnA(changes);

        // "Start New Order" on the dashboard: OptiPeople runs its hidden default order, read as "".
        api.Current[M1] = "";
        await VerifyTwice(worker);

        Assert.Equal([new MachineOrderChange(M1, A, "")], changes);
        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal(A, orders.StoppedOn(M1));

        // The app ends the element at the station: the machine still gets nothing, and is not read again.
        orders.Want(M1, MachineOrder.None, _now);
        var reads = api.Reads;
        _now += TimeSpan.FromMinutes(5);
        Assert.Equal(0, await Drain(worker));
        Assert.Equal(reads, api.Reads);
        Assert.Single(api.Sets);
        Assert.Single(changes);
    }

    [Fact]
    public async Task Another_order_started_in_OptiPeople_is_left_alone_until_the_station_scans_a_new_element()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, worker) = await InStepOnA(changes);

        api.Current[M1] = C;
        await VerifyTwice(worker);
        Assert.Equal([new MachineOrderChange(M1, A, C)], changes);

        // Ended at the station, and someone's order C runs on: the app does not touch it.
        orders.Want(M1, MachineOrder.None, _now);
        _now += TimeSpan.FromMinutes(5);
        Assert.Equal(0, await Drain(worker));
        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal(C, api.Current[M1]);

        // A new In at the station: the machine is read first, then gets the new element.
        orders.Want(M1, E(B), _now);
        Assert.Null(orders.StoppedOn(M1));
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A), (M1, B)], api.Sets);
        Assert.Single(changes);
    }

    [Fact]
    public async Task A_new_In_of_the_stopped_element_sets_it_again()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, worker) = await InStepOnA(changes);
        api.Current[M1] = "";
        await VerifyTwice(worker);
        orders.Want(M1, MachineOrder.None, _now);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, A), (M1, A)], api.Sets);
    }

    // The station scans in another element while the verify read is on its way.
    sealed class ScanDuringRead(FakeApi inner, Action during) : IMachineOrderApi
    {
        public async Task<string?> GetCurrentOrderAsync(Guid machineId, CancellationToken ct = default)
        {
            var current = await inner.GetCurrentOrderAsync(machineId, ct);
            during();
            return current;
        }

        public Task SetOrderToMachineAsync(Guid machineId, MachineOrder order, CancellationToken ct = default) => inner.SetOrderToMachineAsync(machineId, order, ct);
        public Task SetOrderFieldsAsync(Guid machineId, MachineOrder order, CancellationToken ct = default) => inner.SetOrderFieldsAsync(machineId, order, ct);
    }

    [Fact]
    public async Task A_stop_read_while_the_station_moved_on_does_not_end_the_new_element()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, _) = await InStepOnA(changes);
        var worker = new MachineOrderSync(orders, new ScanDuringRead(api, () => orders.Want(M1, E(B), _now)), _log.Add, () => _now, changed: changes.Add);

        api.Current[M1] = "";
        _now += Verify;
        Assert.True(await worker.RunOnceAsync());

        Assert.Empty(changes);
        Assert.Null(orders.StoppedOn(M1));
        // The new element goes out as usual, once it has settled.
        _now += Settle;
        await Drain(new MachineOrderSync(orders, api, _log.Add, () => _now, changed: changes.Add));
        Assert.Equal([(M1, A), (M1, B)], api.Sets);
        Assert.Empty(changes);
    }

    [Fact]
    public async Task An_Out_and_In_of_the_same_element_during_a_stop_read_keeps_the_new_In()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, _) = await InStepOnA(changes);
        var worker = new MachineOrderSync(orders, new ScanDuringRead(api, () =>
        {
            orders.Want(M1, MachineOrder.None, _now);
            orders.Want(M1, E(A, _now), _now);
        }), _log.Add, () => _now, changed: changes.Add);

        api.Current[M1] = "";
        _now += Verify;
        Assert.True(await worker.RunOnceAsync());

        // Not a stop: the operator's new In of A stands, and the machine gets A again once settled.
        Assert.Empty(changes);
        Assert.Null(orders.StoppedOn(M1));
        _now += Settle;
        await Drain(new MachineOrderSync(orders, api, _log.Add, () => _now, changed: changes.Add));
        Assert.Equal([(M1, A), (M1, A)], api.Sets);
        Assert.Empty(changes);
    }

    [Fact]
    public async Task An_order_that_is_not_an_element_is_never_cleared()
    {
        var orders = new MachineOrders(verify: Verify);
        var api = new FakeApi();
        api.Current[M1] = "Manuel 7";
        var worker = Worker(orders, api);

        // A restart with nothing in progress: the hand-started order is left as it is, and not read again.
        orders.Want(M1, MachineOrder.None, _now);
        _now += Settle;
        await Drain(worker);
        var reads = api.Reads;
        _now += TimeSpan.FromMinutes(5);
        Assert.Equal(0, await Drain(worker));
        Assert.Empty(api.Sets);
        Assert.Equal(reads, api.Reads);
        Assert.Equal("Manuel 7", orders.Snapshot()[M1].Known);

        // A scan In still gives the machine the element over it.
        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);
        Assert.Equal([(M1, A)], api.Sets);
    }

    [Fact]
    public async Task An_element_left_on_a_machine_with_nothing_in_progress_is_still_cleared()
    {
        var orders = new MachineOrders(verify: Verify);
        var api = new FakeApi();
        api.Current[M1] = C;
        var worker = Worker(orders, api);

        orders.Want(M1, MachineOrder.None, _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, "")], api.Sets);
    }

    [Fact]
    public async Task A_scan_Out_while_a_read_finds_a_hand_started_order_leaves_that_order()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, _) = await InStepOnA(changes);
        var worker = new MachineOrderSync(orders, new ScanDuringRead(api, () => orders.Want(M1, MachineOrder.None, _now)), _log.Add, () => _now, changed: changes.Add);

        api.Current[M1] = "Manuel 7";
        _now += Verify;
        Assert.True(await worker.RunOnceAsync());
        _now += TimeSpan.FromMinutes(5);
        await Drain(new MachineOrderSync(orders, api, _log.Add, () => _now, changed: changes.Add));

        Assert.Empty(changes);
        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal("Manuel 7", api.Current[M1]);
    }

    [Fact]
    public async Task The_first_read_still_sets_the_wish_when_the_machine_has_something_else()
    {
        var changes = new List<MachineOrderChange>();
        var orders = new MachineOrders(verify: Verify);
        var api = new FakeApi();
        api.Current[M1] = C;
        var worker = new MachineOrderSync(orders, api, _log.Add, () => _now, changed: changes.Add);

        orders.Want(M1, E(A), _now);
        _now += Settle;
        await Drain(worker);

        Assert.Equal([(M1, A)], api.Sets);
        Assert.Empty(changes);
    }

    [Fact]
    public async Task A_failed_verify_read_keeps_what_is_known_and_never_sets()
    {
        var changes = new List<MachineOrderChange>();
        var (orders, api, worker) = await InStepOnA(changes);

        api.FailRead = NoNetwork;
        _now += Verify;
        await Drain(worker);
        Assert.Equal(A, orders.Snapshot()[M1].Known);

        // Stopped in OptiPeople meanwhile: the next good reads still count as a stop.
        api.FailRead = null;
        api.Current[M1] = "";
        _now += TimeSpan.FromMinutes(1);
        await Drain(worker);
        Assert.Empty(changes);
        _now += Verify;
        await Drain(worker);

        Assert.Equal([(M1, A)], api.Sets);
        Assert.Equal([new MachineOrderChange(M1, A, "")], changes);
    }

    [Fact]
    public void A_station_that_switches_element_gives_its_machine_the_new_element()
    {
        var setups = new[] { new StationSetup(1, "Station 10", StationKind.Assembly, M1) };
        var state = new StationState(StationConfig.Defaults[0]);
        state.Scan(Code(A), T0);
        state.Scan(Code(A2), T0.AddMinutes(1));

        Assert.Equal(A2, MachineOrders.DesiredFrom(setups, [state])[M1].Number);

        state.Scan(Code(B), T0.AddMinutes(2));
        Assert.Equal(B, MachineOrders.DesiredFrom(setups, [state])[M1].Number);

        state.Scan(Code(B), T0.AddMinutes(3));
        Assert.Equal("", MachineOrders.DesiredFrom(setups, [state])[M1].Number);
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
        var fromCloud = false;
        sync.Loaded += (_, l) => { if (l.FromCloud) fromCloud = true; };
        sync.Start();
        await Until(() => fromCloud);

        // Before the screen is rebuilt from OptiCloud, nothing goes out.
        sync.SetMachineOrders(new Dictionary<Guid, MachineOrder> { [machine] = E(A) });
        _now += Settle;
        await Task.Delay(300);
        Assert.Equal(0, api.Count("RealtimeDashboard"));

        sync.SetMachineOrders(new Dictionary<Guid, MachineOrder> { [machine] = E(A) }, fromCloud: true);
        await Until(() => api.Sets.Length == 1);
        Assert.Equal((machine, A), api.Sets[0]);
        Assert.Contains(api.Snapshot(), r => r.Path.Contains("SetOrderToMachine") && r.Body!.Contains($"\"number\":\"{A}\"") && r.Body.Contains("\"expectedSpeed\":0"));

        // Then the fields, in the machine's factory, as text by label.
        await Until(() => api.FieldsOf(A) is not null);
        Assert.Equal(new Dictionary<string, string> { ["Ordre"] = "58556", ["Position"] = "5", ["Underposition"] = "1", ["Emne"] = "3", ["Scannet ind"] = Local(T0) }, api.FieldsOf(A));
        Assert.Contains(api.Snapshot(), r => r.Path.Contains("ExternalSetPartOrder") && r.Body!.Contains($"\"factoryId\":\"{api.Factory}\"")
            && r.Body.Contains($"\"partOrderNumber\":\"{A}\"") && r.Body.Contains("{\"label\":\"Ordre\",\"text\":\"58556\"}"));

        sync.SetMachineOrders(new Dictionary<Guid, MachineOrder> { [machine] = MachineOrder.None });
        _now += Settle;
        await Until(() => api.Sets.Length == 2);
        Assert.Equal((machine, ""), api.Sets[1]);
    }

    [Fact(Timeout = 10000)]
    public async Task A_scan_station_hears_of_an_order_stopped_in_OptiPeople_and_does_not_set_it_back()
    {
        var api = new FakeOptiCloud();
        var machine = api.Machines[1].Id;
        using var sync = Sync(api, StationMode.Scan);
        var fromCloud = false;
        var changes = new List<MachineOrderChange>();
        sync.Loaded += (_, l) => { if (l.FromCloud) fromCloud = true; };
        sync.MachineOrderChanged += (_, c) => { lock (changes) changes.Add(c); };
        sync.Start();
        await Until(() => fromCloud);

        sync.SetMachineOrders(new Dictionary<Guid, MachineOrder> { [machine] = E(A) }, fromCloud: true);
        _now += Settle;
        await Until(() => api.Sets.Length == 1 && api.FieldsOf(A) is not null);

        // "Start New Order" on the dashboard.
        api.Override = (method, path, body) =>
            path.Contains("GetCurrentOrderActiveByMachineId") ? FakeOptiCloud.Json(new { data = new { partInformationId = Guid.NewGuid(), partOrderNumberId = Guid.NewGuid(), number = "", isDefaultPartInfo = true }, errors = Array.Empty<object>(), meta = new { } }) : null;
        // Two verify reads in a row must say so: the clock moves on until they have.
        await Until(() =>
        {
            _now += MachineOrders.DefaultVerify;
            lock (changes) return changes.Count == 1;
        });

        Assert.Equal(new MachineOrderChange(machine, A, ""), changes[0]);
        // The app ends the element; nothing is set on the machine.
        sync.SetMachineOrders(new Dictionary<Guid, MachineOrder> { [machine] = MachineOrder.None });
        _now += TimeSpan.FromMinutes(1);
        await Task.Delay(300);
        Assert.Single(api.Sets);
    }

    [Fact]
    public async Task The_client_asks_a_machine_for_its_factory_once()
    {
        var api = new FakeOptiCloud();
        using var client = api.Client();
        var machine = api.Machines[0].Id;

        await client.SetOrderFieldsAsync(machine, E(A));
        await client.SetOrderFieldsAsync(machine, E(B));
        await client.SetOrderFieldsAsync(machine, MachineOrder.None);

        Assert.Equal(1, api.Snapshot().Count(r => r.Path.StartsWith("api/Machine/Get/")));
        Assert.Equal(2, api.Count("ExternalSetPartOrder"));
        Assert.Equal("1", api.FieldsOf(B)!["Underposition"]);
    }

    [Fact(Timeout = 10000)]
    public async Task A_viewer_never_sets_an_order()
    {
        var api = new FakeOptiCloud();
        using var sync = Sync(api, StationMode.Viewer);
        sync.Start();
        await Until(() => sync.Status.State == CloudState.Online && api.Count("GetRowsPaged") > 0);

        sync.SetMachineOrders(new Dictionary<Guid, MachineOrder> { [api.Machines[1].Id] = E(A) }, fromCloud: true);
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
        await client.SetOrderToMachineAsync(machine, E(A));
        Assert.Equal(A, await client.GetCurrentOrderAsync(machine));
        await client.SetOrderToMachineAsync(machine, MachineOrder.None);
        Assert.Equal("", await client.GetCurrentOrderAsync(machine));
    }
}
