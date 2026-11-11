using System.Globalization;

namespace Ventisol.Station.Core.Cloud;

// A custom field on an order, by its name in OptiPeople (Danish, as the users see it).
public sealed record OrderField(string Name, string Value);

// What a machine should run in OptiPeople: Number is the order number ("" for none), Fields the
// custom fields that go with it. Only Number decides the order (it is what is set and read back);
// the fields may change for the same Number (a new In of the same element) and are then sent again.
public sealed record MachineOrder(string Number, IReadOnlyList<OrderField> Fields)
{
    public static readonly MachineOrder None = new("", []);

    public const string ScannedInFormat = "yyyy-MM-dd HH:mm:ss";

    public MachineOrder(string number) : this(number?.Trim() ?? "", []) { }

    // The element as OptiPeople gets it: the full 12-digit barcode as the number, so every element
    // is an order of its own and its time is its own; order, position, sub-position and piece as
    // fields, as plain digits: 058556050103 gives Ordre 58556, Position 5, Underposition 1, Emne 3.
    // "Scannet ind" is when it was scanned In at the station, in local (Danish) time without offset,
    // so the true start is kept however late the order gets to OptiPeople.
    public static MachineOrder From(Barcode barcode, DateTimeOffset scannedIn, TimeZoneInfo? zone = null) => new(barcode.Raw,
    [
        new("Ordre", barcode.Order.ToString(CultureInfo.InvariantCulture)),
        new("Position", barcode.Position.ToString(CultureInfo.InvariantCulture)),
        new("Underposition", barcode.SubPosition.ToString(CultureInfo.InvariantCulture)),
        new("Emne", barcode.Piece.ToString(CultureInfo.InvariantCulture)),
        new("Scannet ind", TimeZoneInfo.ConvertTime(scannedIn, zone ?? TimeZoneInfo.Local).ToString(ScannedInFormat, CultureInfo.InvariantCulture)),
    ]);

    public bool SameFields(MachineOrder other) => Fields.SequenceEqual(other.Fields);
}

public enum MachineOrderAction { Read, Set, Fields, Verify }

// What the worker should do next for one machine: read what OptiPeople has on it, set Order on it
// (an empty Number clears it), give the order Order.Number its Fields, or read the machine again to
// see that it still runs Order.Number (Verify). Wish: which wish of the machine it was made for,
// so a verify read can tell that the station's wish changed while it was under way.
public sealed record MachineOrderStep(Guid MachineId, MachineOrder Order, MachineOrderAction Action, int Wish = 0)
{
    public string Number => Order.Number;
    public bool Read => Action == MachineOrderAction.Read;
}

// A machine's order was stopped or changed in OptiPeople: it ran Stopped, the order the app had set
// (or found there), and now runs Current ("" for none).
public sealed record MachineOrderChange(Guid MachineId, string Stopped, string Current);

// The order each station's machine should have in OptiPeople, and what is known to be there.
// OptiPeople holds one current order per machine and stamps the time itself, so this is desired
// state, not history: per machine only the latest wish counts, and it is sent once it has been
// the same for Settle (an Out and In of the same element sends nothing, a quick switch sends only
// the new element). SetOrderToMachine is not idempotent (the same number again starts a new run),
// so nothing is sent that the machine already has, and what it has is not assumed: at first, and
// after a failure (the call may have got in), the machine is read first and set only when it
// differs; nothing is ever set while what the machine has is unknown. Only machines given a wish
// are ever touched. Held until Release: nothing is due before the screen has been rebuilt from
// OptiCloud, so a wish from the journal alone is never acted on.
// Fields: SetOrderToMachine ignores them, so once a machine is known to run an element (set, or
// found there by a read) its fields are queued and sent by a call of their own. That call is
// idempotent and leaves the run alone, so it is retried with its own backoff and never causes a
// set again. Fields of an element the machine has since left are still sent: they belong to that
// order. At most MaxPendingFields wait per machine; the oldest is dropped beyond that.
// OptiPeople leads when someone stops or changes the order there: with verify, a machine in step on
// an element is read again every verify. When it no longer runs that element, it is not set back
// (a set starts a new run and splits the time); the change is reported (Verified), so the app ends
// the element at its station, and the machine is left alone until its station wishes another
// element. Only an order the app knew the machine to run counts: the first read and the read after
// a failure still set what is wished. Without verify (null) a machine in step is never read again.
// The app only ever clears an order of its own: one whose number is an element barcode. A machine
// found running anything else while its station has nothing in progress is left as it is.
// No I/O and no clock of its own, so it can be tested; MachineOrderSync does the calls.
// Safe to use from any thread.
public sealed class MachineOrders(TimeSpan? settle = null, bool held = false, TimeSpan? verify = null)
{
    public static readonly TimeSpan DefaultSettle = TimeSpan.FromSeconds(3);
    public static readonly TimeSpan DefaultVerify = TimeSpan.FromSeconds(5);
    public const int MaxPendingFields = 20;

    readonly TimeSpan _settle = settle ?? DefaultSettle;
    readonly TimeSpan? _verify = verify;
    readonly Lock _gate = new();
    readonly Dictionary<Guid, Entry> _machines = [];
    bool _held = held;

    sealed class Entry
    {
        public MachineOrder Desired = MachineOrder.None;
        public DateTimeOffset ChangedAt;
        // What OptiPeople has, as far as known. Null: not known, read it before any set.
        public string? Known;
        public int Failures;
        public DateTimeOffset RetryAt = DateTimeOffset.MinValue;
        // Orders whose fields are still to be sent, oldest first, and their own backoff.
        public readonly List<MachineOrder> Fields = [];
        public int FieldFailures;
        public DateTimeOffset FieldsAt = DateTimeOffset.MinValue;
        // When the machine in step is read again; MinValue: not planned yet. Its own backoff.
        public DateTimeOffset VerifyAt = DateTimeOffset.MinValue;
        public int VerifyFailures;
        // The element stopped in OptiPeople: the machine is left alone until another is wished.
        public string? Stopped;
        // Counts every change of the wished Number, so a read can tell the wish moved on meanwhile,
        // also when it came back to the same Number (an Out and In of the same element).
        public int Wish;
        // Since when a set or its fields have failed without one getting in; null: not failing.
        public DateTimeOffset? FailingSince;

        // In step on an element and not left alone: the one state in which it is read again.
        public bool InStep => Stopped is null && Known is { Length: > 0 } k && k == Desired.Number;
        // Nothing wished, and the machine runs an order that is not one of ours (someone started it
        // by hand): never cleared, so that counts as in step too.
        public bool Foreign => Desired.Number.Length == 0 && Known is { Length: > 0 } k && !Barcode.TryParse(k, out _);
        // Something to read or set: not in step, and not left alone.
        public bool Behind => Stopped is null && Known != Desired.Number && !Foreign;

        public DateTimeOffset DueAt(TimeSpan settle) => ChangedAt + settle > RetryAt ? ChangedAt + settle : RetryAt;
    }

    // Per mapped machine, the element in progress at its station, else none.
    // Stations with no machine are left out. Two stations on one machine (a setup mistake):
    // the one that started last wins.
    public static IReadOnlyDictionary<Guid, MachineOrder> DesiredFrom(IEnumerable<StationSetup> setups, IEnumerable<StationState> states)
    {
        var byNumber = states.GroupBy(s => s.Station.Number).ToDictionary(g => g.Key, g => g.First());
        var desired = new Dictionary<Guid, MachineOrder>();
        foreach (var group in setups.Where(s => s.MachineId is not null).GroupBy(s => s.MachineId!.Value))
        {
            var busy = group.Select(s => byNumber.GetValueOrDefault(s.Number)).Where(s => s?.Current is not null)
                .OrderByDescending(s => s!.StartedAt).FirstOrDefault();
            desired[group.Key] = busy is null ? MachineOrder.None : MachineOrder.From(busy.Current!, busy.StartedAt!.Value);
        }
        return desired;
    }

    // The wish for each machine given. A change of Number starts the settle time again; the same
    // wish again changes nothing. Machines not given are left as they are. The same Number with
    // other fields (a new In time) never sets again, but its fields are sent again when the machine
    // runs it. An Out and In within settle passes through none, so it sends nothing: the run in
    // OptiPeople keeps its start, and so do its fields.
    public void Want(IReadOnlyDictionary<Guid, MachineOrder> desired, DateTimeOffset now)
    {
        lock (_gate)
        {
            foreach (var (machine, order) in desired)
            {
                var o = order is null ? MachineOrder.None : order with { Number = order.Number?.Trim() ?? "" };
                if (!_machines.TryGetValue(machine, out var e)) _machines[machine] = new Entry { Desired = o, ChangedAt = now };
                else if (e.Stopped is not null && o.Number.Length == 0)
                {
                    // The station let go of the stopped element (the app ended it): still left alone.
                    e.Desired = o;
                    e.Wish++;
                }
                else if (e.Desired.Number != o.Number)
                {
                    // Another element after a stop in OptiPeople: what the machine runs now is not
                    // known (someone may have started an order by hand), so it is read first.
                    if (e.Stopped is not null)
                    {
                        e.Stopped = null;
                        e.Known = null;
                    }
                    e.Desired = o;
                    e.Wish++;
                    e.ChangedAt = now;
                    e.VerifyAt = DateTimeOffset.MinValue;
                }
                else if (!e.Desired.SameFields(o))
                {
                    e.Desired = o;
                    if (e.Known == o.Number) QueueFields(e, o);
                }
            }
        }
    }

    public void Want(Guid machine, MachineOrder order, DateTimeOffset now) => Want(new Dictionary<Guid, MachineOrder> { [machine] = order }, now);

    public bool IsHeld { get { lock (_gate) return _held; } }

    // From now on wishes are acted on.
    public void Release()
    {
        lock (_gate) _held = false;
    }

    // The next thing due, or null when held, or every machine is in step or still settling or waiting.
    // A read or set comes before fields: the run's start time matters, the fields can wait. A verify
    // read comes last.
    public MachineOrderStep? Next(DateTimeOffset now)
    {
        lock (_gate)
        {
            if (_held) return null;
            var due = _machines.Where(m => m.Value.Behind && m.Value.DueAt(_settle) <= now)
                .OrderBy(m => m.Value.DueAt(_settle)).Select(m => (KeyValuePair<Guid, Entry>?)m).FirstOrDefault();
            if (due is { } d)
                return new MachineOrderStep(d.Key, d.Value.Desired, d.Value.Known is null ? MachineOrderAction.Read : MachineOrderAction.Set);
            var fields = _machines.Where(m => m.Value.Fields.Count > 0 && m.Value.FieldsAt <= now)
                .OrderBy(m => m.Value.FieldsAt).Select(m => (KeyValuePair<Guid, Entry>?)m).FirstOrDefault();
            if (fields is { } f) return new MachineOrderStep(f.Key, f.Value.Fields[0], MachineOrderAction.Fields);
            if (_verify is not { } every) return null;
            // A machine just come in step is read again one verify from now.
            foreach (var e in _machines.Values.Where(e => e.InStep && e.VerifyAt == DateTimeOffset.MinValue)) e.VerifyAt = now + every;
            var verify = _machines.Where(m => m.Value.InStep && m.Value.VerifyAt <= now)
                .OrderBy(m => m.Value.VerifyAt).Select(m => (KeyValuePair<Guid, Entry>?)m).FirstOrDefault();
            if (verify is { } v) return new MachineOrderStep(v.Key, v.Value.Desired, MachineOrderAction.Verify, v.Value.Wish);
            return null;
        }
    }

    // How long until something may be due, for the worker's sleep. Null: nothing waits.
    public TimeSpan? DueIn(DateTimeOffset now)
    {
        lock (_gate)
        {
            var waiting = _machines.Values.Where(e => e.Behind).Select(e => e.DueAt(_settle))
                .Concat(_machines.Values.Where(e => e.Fields.Count > 0).Select(e => e.FieldsAt))
                .Concat(_verify is null ? [] : _machines.Values.Where(e => e.InStep && e.VerifyAt != DateTimeOffset.MinValue).Select(e => e.VerifyAt)).ToList();
            if (waiting.Count == 0) return null;
            var at = waiting.Min();
            return at <= now ? TimeSpan.Zero : at - now;
        }
    }

    // What OptiPeople has on the machine now ("" for none). True when that is what is wished, or
    // nothing is wished and the order there is not one of ours (left alone).
    public bool Read(Guid machine, string current)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return false;
            e.Known = current?.Trim() ?? "";
            if (e.Known != e.Desired.Number && !e.Foreign) return false;
            Reset(e);
            QueueFields(e, e.Desired);
            return true;
        }
    }

    // The read failed, for whatever reason: wait with backoff and read again. Never set blind, as
    // a set of the order the machine already runs starts a new run.
    public TimeSpan ReadFailed(Guid machine, DateTimeOffset now, Exception x) => Failed(machine, now, x);

    // A verify read of order asked found current on the machine. Still the same: read again one
    // verify from now. Something else, while the station still wishes asked: OptiPeople stopped or
    // changed it, so that is what is known, nothing is set, the machine is left alone until another
    // element is wished, and the change is returned for the app to end the element. When the wish
    // changed while the read was under way (wish is not the machine's wish any more, even if it came
    // back to the same Number), it is an ordinary read: the new wish is sent as usual.
    public MachineOrderChange? Verified(Guid machine, string asked, int wish, string current, DateTimeOffset now)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return null;
            current = current?.Trim() ?? "";
            e.VerifyFailures = 0;
            e.VerifyAt = _verify is { } every ? now + every : DateTimeOffset.MinValue;
            if (e.Stopped is not null) return null;
            if (asked.Length == 0 || e.Wish != wish || e.Desired.Number != asked || e.Known != asked)
            {
                // The wish (or what was known) moved on meanwhile.
                if (e.Known is not null) e.Known = current;
                return null;
            }
            e.Known = current;
            if (current == asked) return null;
            e.Stopped = asked;
            return new MachineOrderChange(machine, asked, current);
        }
    }

    // A verify read failed: nothing was sent, so what is known stands. Read again after the backoff.
    public TimeSpan VerifyFailed(Guid machine, DateTimeOffset now, Exception x)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return TimeSpan.Zero;
            var wait = Outbox.Wait(x, e.VerifyFailures++);
            e.VerifyAt = now + wait;
            return wait;
        }
    }

    public void Sent(Guid machine, MachineOrder order)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return;
            e.Known = order.Number;
            Reset(e);
            // Newer fields for the same element may have come in while the set was under way.
            QueueFields(e, e.Desired.Number == order.Number ? e.Desired : order);
        }
    }

    // The fields of order got in: off the queue, and the next waits no longer. Kept when newer
    // fields for the same Number came in meanwhile: those still go.
    public void FieldsSent(Guid machine, MachineOrder order)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return;
            e.Fields.RemoveAll(o => o.Number == order.Number && o.SameFields(order));
            e.FieldFailures = 0;
            e.FieldsAt = DateTimeOffset.MinValue;
            if (e.Failures == 0) e.FailingSince = null;
        }
    }

    // The fields call failed: the same fields again after the backoff. Returns the wait.
    public TimeSpan FieldsFailed(Guid machine, DateTimeOffset now, Exception x)
    {
        lock (_gate)
        {
            if (!_machines.TryGetValue(machine, out var e)) return TimeSpan.Zero;
            var wait = Outbox.Wait(x, e.FieldFailures++);
            e.FieldsAt = now + wait;
            e.FailingSince ??= now;
            return wait;
        }
    }

    // The orders whose fields still wait for a machine, oldest first, for tests and the log.
    public IReadOnlyList<string> PendingFields(Guid machine)
    {
        lock (_gate) return _machines.TryGetValue(machine, out var e) ? [.. e.Fields.Select(o => o.Number)] : [];
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
            e.FailingSince ??= now;
            return wait;
        }
    }

    // How long the longest-failing machine has failed to get its order (or its fields) in, else
    // null. The status says so after a while: the order on the machine is behind the station.
    public TimeSpan? FailingFor(DateTimeOffset now)
    {
        lock (_gate)
        {
            var since = _machines.Values.Select(e => e.FailingSince).Where(t => t is not null).Min();
            return since is { } t ? now - t : null;
        }
    }

    // The element stopped in OptiPeople that the machine is left alone for, else null.
    public string? StoppedOn(Guid machine)
    {
        lock (_gate) return _machines.TryGetValue(machine, out var e) ? e.Stopped : null;
    }

    // What each machine wants and what is known to be there, for tests and the log.
    public IReadOnlyDictionary<Guid, (string Desired, string? Known)> Snapshot()
    {
        lock (_gate) return _machines.ToDictionary(m => m.Key, m => (m.Value.Desired.Number, m.Value.Known));
    }

    static void QueueFields(Entry e, MachineOrder order)
    {
        if (order.Number.Length == 0 || order.Fields.Count == 0) return;
        // Fields still waiting for the same order are replaced by the newest.
        var i = e.Fields.FindIndex(o => o.Number == order.Number);
        if (i >= 0)
        {
            e.Fields[i] = order;
            return;
        }
        e.Fields.Add(order);
        if (e.Fields.Count > MaxPendingFields) e.Fields.RemoveAt(0);
    }

    static void Reset(Entry e)
    {
        e.Failures = 0;
        if (e.FieldFailures == 0) e.FailingSince = null;
        e.RetryAt = DateTimeOffset.MinValue;
        e.VerifyAt = DateTimeOffset.MinValue;
    }
}

// The OptiPeople calls the worker needs. OptiCloudClient is the real one.
public interface IMachineOrderApi
{
    // The machine's current order number, "" when it has none.
    Task<string> GetCurrentOrderAsync(Guid machineId, CancellationToken ct = default);

    // Makes order the machine's current order, ending the run of the one before; an empty Number
    // clears it. The order's Fields go with it.
    Task SetOrderToMachineAsync(Guid machineId, MachineOrder order, CancellationToken ct = default);

    // Gives the order order.Number (in machineId's factory) its Fields. Idempotent, and leaves the
    // machine's run alone.
    Task SetOrderFieldsAsync(Guid machineId, MachineOrder order, CancellationToken ct = default);
}

// Keeps OptiPeople in step with MachineOrders in the background: one call at a time, never
// throws to the caller, logs each set and each distinct failure once.
// changed hears of each order stopped or changed in OptiPeople (MachineOrders.Verified).
public sealed class MachineOrderSync(MachineOrders orders, IMachineOrderApi api, Action<string> log, Func<DateTimeOffset> clock,
    Func<TimeSpan, CancellationToken, Task>? delay = null, Action<MachineOrderChange>? changed = null)
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
        if (step.Action == MachineOrderAction.Fields)
        {
            try
            {
                await api.SetOrderFieldsAsync(step.MachineId, step.Order, ct);
                orders.FieldsSent(step.MachineId, step.Order);
                _logged = null;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception x)
            {
                Note(x, $"felterne til ordre {step.Number} kunne ikke sendes");
                orders.FieldsFailed(step.MachineId, clock(), x);
            }
            return true;
        }

        if (step.Action == MachineOrderAction.Verify)
        {
            try
            {
                var current = await api.GetCurrentOrderAsync(step.MachineId, ct);
                if (orders.Verified(step.MachineId, step.Number, step.Wish, current, clock()) is { } change)
                {
                    log($"OptiCloud: maskine {step.MachineId} kører ikke længere {name} ({(change.Current.Length > 0 ? $"nu ordre {change.Current}" : "nu ingen ordre")}), sættes ikke tilbage");
                    changed?.Invoke(change);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception x)
            {
                Note(x, "maskinens ordre kunne ikke læses");
                orders.VerifyFailed(step.MachineId, clock(), x);
            }
            return true;
        }

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
                Note(x, "maskinens ordre kunne ikke læses");
                orders.ReadFailed(step.MachineId, clock(), x);
            }
            return true;
        }

        try
        {
            await api.SetOrderToMachineAsync(step.MachineId, step.Order, ct);
            orders.Sent(step.MachineId, step.Order);
            _logged = null;
            log($"OptiCloud: maskine {step.MachineId} har nu {name}");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception x)
        {
            Note(x, "maskinens ordre kunne ikke sættes");
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
        log($"OptiCloud: {what}: {message}");
    }
}
