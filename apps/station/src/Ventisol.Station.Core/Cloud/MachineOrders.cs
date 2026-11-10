using System.Globalization;

namespace Ventisol.Station.Core.Cloud;

// What the worker should do next for one machine: read what OptiPeople has on it, or set Number
// on it ("" clears it).
public sealed record MachineOrderStep(Guid MachineId, string Number, bool Read);

// The order each station's machine should have in OptiPeople, and what is known to be there.
// OptiPeople holds one current order per machine and stamps the time itself, so this is desired
// state, not history: per machine only the latest wish counts, and it is sent once it has been
// the same for Settle (an Out and In of the same order sends nothing, a quick switch sends only
// the new order). SetOrderToMachine is not idempotent (the same number again starts a new run),
// so nothing is sent that the machine already has, and what it has is not assumed: at first, and
// after a failure (the call may have got in), the machine is read first and set only when it
// differs; nothing is ever set while what the machine has is unknown. Only machines given a wish
// are ever touched. Held until Release: nothing is due before the screen has been rebuilt from
// OptiCloud, so a wish from the journal alone is never acted on.
// No I/O and no clock of its own, so it can be tested; MachineOrderSync does the calls.
// Safe to use from any thread.
public sealed class MachineOrders(TimeSpan? settle = null, bool held = false)
{
    public static readonly TimeSpan DefaultSettle = TimeSpan.FromSeconds(3);

    readonly TimeSpan _settle = settle ?? DefaultSettle;
    readonly Lock _gate = new();
    readonly Dictionary<Guid, Entry> _machines = [];
    bool _held = held;

    sealed class Entry
    {
        public string Desired = "";
        public DateTimeOffset ChangedAt;
        // What OptiPeople has, as far as known. Null: not known, read it before any set.
        public string? Known;
        public int Failures;
        public DateTimeOffset RetryAt = DateTimeOffset.MinValue;

        public DateTimeOffset DueAt(TimeSpan settle) => ChangedAt + settle > RetryAt ? ChangedAt + settle : RetryAt;
    }

    // The order number as OptiPeople gets it: the digits of the barcode's order, no leading zero.
    public static string Number(Barcode barcode) => barcode.Order.ToString(CultureInfo.InvariantCulture);

    // Per mapped machine, the order of the element in progress at its station, else "".
    // Stations with no machine are left out. Two stations on one machine (a setup mistake):
    // the one that started last wins.
    public static IReadOnlyDictionary<Guid, string> DesiredFrom(IEnumerable<StationSetup> setups, IEnumerable<StationState> states)
    {
        var byNumber = states.GroupBy(s => s.Station.Number).ToDictionary(g => g.Key, g => g.First());
        var desired = new Dictionary<Guid, string>();
        foreach (var group in setups.Where(s => s.MachineId is not null).GroupBy(s => s.MachineId!.Value))
        {
            var busy = group.Select(s => byNumber.GetValueOrDefault(s.Number)).Where(s => s?.Current is not null)
                .OrderByDescending(s => s!.StartedAt).FirstOrDefault();
            desired[group.Key] = busy is null ? "" : Number(busy.Current!);
        }
        return desired;
    }

    // The wish for each machine given. A change starts the settle time again; the same wish again
    // changes nothing. Machines not given are left as they are.
    public void Want(IReadOnlyDictionary<Guid, string> desired, DateTimeOffset now)
    {
        lock (_gate)
        {
            foreach (var (machine, number) in desired)
            {
                var n = number?.Trim() ?? "";
                if (!_machines.TryGetValue(machine, out var e)) _machines[machine] = new Entry { Desired = n, ChangedAt = now };
                else if (e.Desired != n)
                {
                    e.Desired = n;
                    e.ChangedAt = now;
                }
            }
        }
    }

    public void Want(Guid machine, string number, DateTimeOffset now) => Want(new Dictionary<Guid, string> { [machine] = number }, now);

    public bool IsHeld { get { lock (_gate) return _held; } }

    // From now on wishes are acted on.
    public void Release()
    {
        lock (_gate) _held = false;
    }

    // The next thing due, or null when held, or every machine is in step or still settling or waiting.
    public MachineOrderStep? Next(DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_held) return null;
            var due = _machines.Where(m => m.Value.Known != m.Value.Desired && m.Value.DueAt(_settle) <= now)
                .OrderBy(m => m.Value.DueAt(_settle)).Select(m => (KeyValuePair<Guid, Entry>?)m).FirstOrDefault();
            if (due is not { } d) return null;
            return new MachineOrderStep(d.Key, d.Value.Desired, Read: d.Value.Known is null);
        }
    }

    // How long until something may be due, for the worker's sleep. Null: nothing waits.
    public TimeSpan? DueIn(DateTimeOffset now)
    {
        lock (_gate)
        {
            var waiting = _machines.Values.Where(e => e.Known != e.Desired).Select(e => e.DueAt(_settle)).ToList();
            if (waiting.Count == 0) return null;
            var at = waiting.Min();
            return at <= now ? TimeSpan.Zero : at - now;
        }
    }

    // What OptiPeople has on the machine now ("" for none). True when that is what is wished.
    public bool Read(Guid machine, string current)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return false;
            e.Known = current?.Trim() ?? "";
            if (e.Known != e.Desired) return false;
            Reset(e);
            return true;
        }
    }

    // The read failed, for whatever reason: wait with backoff and read again. Never set blind, as
    // a set of the order the machine already runs starts a new run.
    public TimeSpan ReadFailed(Guid machine, DateTimeOffset now, Exception x) => Failed(machine, now, x);

    public void Sent(Guid machine, string number)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return;
            e.Known = number;
            Reset(e);
        }
    }

    // The call failed: wait with backoff, then read again first, as it is not known whether it
    // got in. Whatever is wished by then is what is sent. Returns the wait.
    public TimeSpan Failed(Guid machine, DateTimeOffset now, Exception x)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return TimeSpan.Zero;
            var wait = Outbox.Wait(x, e.Failures++);
            e.Known = null;
            e.RetryAt = now + wait;
            return wait;
        }
    }

    // What each machine wants and what is known to be there, for tests and the log.
    public IReadOnlyDictionary<Guid, (string Desired, string? Known)> Snapshot()
    {
        lock (_gate) return _machines.ToDictionary(m => m.Key, m => (m.Value.Desired, m.Value.Known));
    }

    static void Reset(Entry e)
    {
        e.Failures = 0;
        e.RetryAt = DateTimeOffset.MinValue;
    }
}

// The two OptiPeople calls the worker needs. OptiCloudClient is the real one.
public interface IMachineOrderApi
{
    // The machine's current order number, "" when it has none.
    Task<string> GetCurrentOrderAsync(Guid machineId, CancellationToken ct = default);

    // Makes number the machine's current order, ending the run of the one before; "" clears it.
    Task SetOrderToMachineAsync(Guid machineId, string number, CancellationToken ct = default);
}

// Keeps OptiPeople in step with MachineOrders in the background: one call at a time, never
// throws to the caller, logs each set and each distinct failure once.
public sealed class MachineOrderSync(MachineOrders orders, IMachineOrderApi api, Action<string> log, Func<DateTimeOffset> clock,
    Func<TimeSpan, CancellationToken, Task>? delay = null)
{
    // How often the worker looks for a new wish when nothing is due.
    public static readonly TimeSpan Tick = TimeSpan.FromMilliseconds(250);

    readonly Func<TimeSpan, CancellationToken, Task> _delay = delay ?? Task.Delay;
    string? _logged;

    public async Task RunAsync(CancellationToken ct)
    {
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (await RunOnceAsync(ct)) continue;
            var wait = orders.DueIn(clock()) is { } d && d < Tick ? d : Tick;
            await _delay(wait, ct);
        }
    }

    // One step, if one is due. True when it did something.
    public async Task<bool> RunOnceAsync(CancellationToken ct = default)
    {
        if (orders.Next(clock()) is not { } step) return false;
        var name = step.Number.Length > 0 ? $"ordre {step.Number}" : "ingen ordre";
        if (step.Read)
        {
            try
            {
                // In step with nothing to send counts as working again; a read before a set does not.
                if (orders.Read(step.MachineId, await api.GetCurrentOrderAsync(step.MachineId, ct))) _logged = null;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception x)
            {
                Note(x, "læses");
                orders.ReadFailed(step.MachineId, clock(), x);
            }
            return true;
        }

        try
        {
            await api.SetOrderToMachineAsync(step.MachineId, step.Number, ct);
            orders.Sent(step.MachineId, step.Number);
            _logged = null;
            log($"OptiCloud: maskine {step.MachineId} har nu {name}");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception x)
        {
            Note(x, "sættes");
            orders.Failed(step.MachineId, clock(), x);
        }
        return true;
    }

    static string Message(Exception x) => x is OptiCloudException ? x.Message : $"{x.GetType().Name}: {x.Message}";

    // The same failure on every retry is logged once, until a machine is in step again. Keyed on the error
    // alone, so a read and a set failing alike in turn log once too.
    void Note(Exception x, string what)
    {
        var message = Message(x);
        if (message == _logged) return;
        _logged = message;
        log($"OptiCloud: maskinens ordre kunne ikke {what}: {message}");
    }
}
