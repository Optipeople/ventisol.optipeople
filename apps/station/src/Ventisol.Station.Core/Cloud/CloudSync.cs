namespace Ventisol.Station.Core.Cloud;

public enum CloudState { NotSetUp, Connecting, Online, Offline, Error }

// What the menu shows. Text is Danish, shown as it is. Failed: scans OptiCloud refused, in outbox\failed.
public sealed record CloudStatus(CloudState State, string Text, int Pending, DateTimeOffset? LastSync, int Failed = 0);

// The station's link to OptiCloud, the one object the app talks to.
// Scan mode: every scan goes to the outbox on disk at once and is sent in the background, and to
// a local journal. At start Loaded comes at once from the journal and the outbox, then again
// when OptiCloud has been read, with everything together.
// Viewer mode: OptiCloud is read every 5 seconds and Loaded is raised whenever the scans changed
// (and at midnight). A viewer records nothing, but still sends what an earlier Scan mode left.
// Loaded holds the raw scans of the last Window (36 hours), so an element scanned in yesterday
// evening is still in progress; the app replays them (ScanReplay.Replay, today = Midnight(now)).
// Scan mode also keeps each station's machine in OptiPeople on the order in progress there
// (SetMachineOrders, MachineOrders); a viewer never does.
// Everything retries with backoff and nothing throws to the caller. Events come on any thread
// (StatusChanged also on the one calling Record or Start, Loaded also on the one calling Start);
// Status is safe to read from any thread. One per settings: when the setup changes, dispose this
// one and make a new one.
public sealed class CloudSync : IDisposable
{
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(5);

    // How far back scans are read. Longer than a night, so an element in progress at midnight
    // survives a restart; an In older than this with no Out is forgotten.
    public static readonly TimeSpan Window = TimeSpan.FromHours(36);

    // A viewer reads only the last stretch on most polls, and the whole window on every 12th:
    // a station that was offline sends its scans late, with their own (older) scan time.
    const int FullReadEvery = 12;
    static readonly TimeSpan RecentWindow = TimeSpan.FromMinutes(10);

    readonly StationSettings _settings;
    readonly string? _password;
    readonly Action<string> _log;
    readonly Func<DateTimeOffset> _clock;
    readonly HttpMessageHandler? _handler;
    readonly Func<TimeSpan, CancellationToken, Task> _delay;
    readonly Outbox _outbox;
    readonly ScanJournal? _journal;
    readonly CancellationTokenSource _stop = new();
    readonly Lock _gate = new();
    readonly List<ScanEvent> _recorded = [];
    // Scan mode with OptiCloud set up only: the order each mapped machine should have.
    readonly MachineOrders? _orders;
    Task? _run;
    bool _started, _disposed;
    CloudState _state;
    string _account = "", _error = "";
    string? _logged;
    DateTimeOffset? _lastSync;
    CloudStatus _status;

    public CloudSync(StationSettings settings, string? password, string dataFolder, Action<string> log, Func<DateTimeOffset>? clock = null,
        HttpMessageHandler? handler = null, Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        _settings = settings;
        _password = password;
        _log = log;
        _clock = clock ?? (() => DateTimeOffset.Now);
        _handler = handler;
        _delay = delay ?? Task.Delay;
        _outbox = new Outbox(Path.Combine(dataFolder, "outbox"), log);
        // A viewer records nothing, so it has nothing of its own to remember.
        if (settings.Mode == StationMode.Scan) _journal = new ScanJournal(Path.Combine(dataFolder, "journal"), log);
        _state = IsSetUp ? CloudState.Connecting : CloudState.NotSetUp;
        if (settings.Mode == StationMode.Scan && IsSetUp) _orders = new MachineOrders();
        _status = Make();
        _outbox.PendingChanged += (_, _) => Publish();
        _outbox.Sent += (_, _) => Synced();
        _outbox.SendFailed += (_, x) => Failed(x);
        // The server answered, it just won't take that scan: connected, with the count shown.
        _outbox.Refused += (_, _) => Synced();
    }

    public event EventHandler<CloudStatus>? StatusChanged;
    public event EventHandler<LoadedScans>? Loaded;

    public CloudStatus Status { get { lock (_gate) return _status; } }

    public int Pending => _outbox.Pending;

    bool IsSetUp => _settings.IsConnected && !string.IsNullOrEmpty(_password);

    public void Start()
    {
        lock (_gate)
        {
            if (_started || _disposed) return;
            _started = true;
        }

        // Once per start, so a fixed setup sends again what was refused; a scan that did get in
        // is recognised by its ScanId.
        _outbox.RetryFailed();
        Publish();

        if (_journal is not null)
        {
            // Before any network: the screen is back at once, also when OptiCloud can't be reached.
            var now = _clock();
            var since = WindowStart(now);
            _journal.Prune(now);
            Raise(Local(since), since);
        }

        lock (_gate)
        {
            if (_disposed) return;
            if (!IsSetUp)
            {
                _log($"OptiCloud: ikke sat op, scanninger gemmes på PC'en ({_outbox.Pending} venter)");
                return;
            }
            _run = Task.Run(() => RunAsync(_stop.Token));
        }
    }

    // Scan mode only. On disk before it returns; false (and logged) if it could not be saved.
    public bool Record(ScanEvent e)
    {
        if (_settings.Mode != StationMode.Scan)
        {
            _log("OptiCloud: en skærm i visningstilstand gemmer ikke scanninger");
            return false;
        }
        try { _outbox.Add(e); }
        catch (Exception x) when (x is IOException or UnauthorizedAccessException)
        {
            _log($"OptiCloud: scanningen {e.Barcode.Raw} kunne ikke gemmes: {x.Message}");
            return false;
        }
        // The outbox has it, so it will be sent: a journal that can't be written only costs the quick start.
        try { _journal?.Append(e); }
        catch (Exception x) when (x is IOException or UnauthorizedAccessException) { _log($"OptiCloud: journalen kunne ikke skrives: {x.Message}"); }
        lock (_gate)
        {
            var since = WindowStart(_clock());
            _recorded.RemoveAll(r => r.At < since);
            _recorded.Add(e);
        }
        return true;
    }

    // Per mapped machine, the order it should have now ("" for none), as MachineOrders.DesiredFrom
    // gives it. Call after every scan and every rebuild of the screen. Sent in the background once
    // it has held for MachineOrders.DefaultSettle. Ignored in Viewer mode or without OptiCloud.
    public void SetMachineOrders(IReadOnlyDictionary<Guid, string> desired)
    {
        if (_orders is null || desired.Count == 0) return;
        _orders.Want(desired, _clock());
    }

    async Task RunAsync(CancellationToken ct)
    {
        try
        {
            using var client = new OptiCloudClient(_settings.ApiBaseUrl, _settings.Username!, _password!, _handler);
            var table = new ScanTable(client, _log);
            await RetryAsync(() => ConnectAsync(client, table, ct), ct);

            // A PC switched from Scan to Viewer may still have scans to send.
            var sender = _settings.Mode == StationMode.Scan || _outbox.Pending > 0 ? _outbox.RunAsync(table.AddAsync, ct, _delay) : Task.CompletedTask;
            var orders = _orders is null ? Task.CompletedTask : new MachineOrderSync(_orders, client, _log, _clock, _delay).RunAsync(ct);
            if (_settings.Mode == StationMode.Scan) await RetryAsync(() => LoadOnceAsync(table, ct), ct);
            else await PollAsync(table, ct);
            await Task.WhenAll(sender, orders);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception x)
        {
            // Not expected: everything is retried below. Logged so it is found afterwards.
            _log($"OptiCloud stoppede: {x}");
            Failed(x);
        }
    }

    async Task ConnectAsync(OptiCloudClient client, ScanTable table, CancellationToken ct)
    {
        // A retry keeps showing why the last try failed.
        lock (_gate) if (_state is not (CloudState.Offline or CloudState.Error)) _state = CloudState.Connecting;
        Publish();
        await client.LoginAsync(ct);
        var (account, name) = await AccountAsync(client, _settings, ct);
        await table.EnsureAsync(account, ct);
        lock (_gate) _account = name;
        _log($"OptiCloud: forbundet til {(name.Length > 0 ? name : account.ToString())}");
        Synced();
    }

    async Task LoadOnceAsync(ScanTable table, CancellationToken ct)
    {
        var since = WindowStart(_clock());
        // Scans not sent yet count too. Looked at before reading, so a scan the sender sends
        // meanwhile is in one or the other; the journal and _recorded hold every one recorded.
        var local = Local(since);
        var events = (await table.ReadSinceAsync(since, ct)).Concat(local).ToList();
        Synced();
        Raise(events, since);
    }

    // What this PC knows without the network.
    List<ScanEvent> Local(DateTimeOffset since)
    {
        var events = _outbox.Peek().ToList();
        if (_journal is not null) events.AddRange(_journal.ReadSince(since));
        lock (_gate) events.AddRange(_recorded);
        return events;
    }

    async Task PollAsync(ScanTable table, CancellationToken ct)
    {
        var cache = new Dictionary<Guid, ScanEvent>();
        HashSet<Guid>? shown = null;
        DateTimeOffset? day = null;
        var polls = 0;
        var failures = 0;

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var now = _clock();
                var start = WindowStart(now);
                var full = polls % FullReadEvery == 0 || cache.Count == 0;
                var since = full ? start : Max(start, cache.Values.Max(e => e.At) - RecentWindow);
                var events = await table.ReadSinceAsync(since, ct);

                // What was read is the whole truth from since on.
                foreach (var id in cache.Values.Where(e => e.At >= since || e.At < start).Select(e => e.ScanId).ToList()) cache.Remove(id);
                foreach (var e in events) cache[e.ScanId] = e;
                polls++;
                failures = 0;
                Synced();

                // A new day changes what is done today even when no scan changed.
                var today = Midnight(now);
                if (shown is null || !shown.SetEquals(cache.Keys) || day != today)
                {
                    shown = [.. cache.Keys];
                    day = today;
                    Raise(cache.Values, start);
                }
                await _delay(PollInterval, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception x)
            {
                Failed(x);
                await _delay(Outbox.Wait(x, failures++), ct);
            }
        }
    }

    // A wrong password waits 15 minutes between tries, anything else the usual backoff.
    async Task RetryAsync(Func<Task> work, CancellationToken ct)
    {
        for (var failures = 0; ; failures++)
        {
            Exception error;
            try
            {
                await work();
                return;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception x)
            {
                Failed(x);
                error = x;
            }
            await _delay(Outbox.Wait(error, failures), ct);
        }
    }

    // Each ScanId once, oldest first, nothing from before since.
    void Raise(IEnumerable<ScanEvent> events, DateTimeOffset since)
    {
        List<ScanEvent> list = [.. events.Where(e => e.At >= since).DistinctBy(e => e.ScanId).OrderBy(e => e.At).ThenBy(e => e.Direction)];
        if (!_disposed) Loaded?.Invoke(this, new LoadedScans(list, since));
    }

    void Synced()
    {
        lock (_gate)
        {
            _state = CloudState.Online;
            _lastSync = _clock();
            _logged = null;
        }
        Publish();
    }

    void Failed(Exception x)
    {
        var o = x as OptiCloudException;
        var message = o?.Message ?? x.Message;
        bool fresh;
        lock (_gate)
        {
            _state = o is null || o.IsAuth || o.IsRejected ? CloudState.Error : CloudState.Offline;
            _error = message;
            // The same failure on every retry is logged once, until it works again.
            fresh = message != _logged;
            _logged = message;
        }
        if (fresh) _log($"OptiCloud: {message}");
        Publish();
    }

    void Publish()
    {
        CloudStatus status;
        lock (_gate)
        {
            status = Make();
            if (status == _status) return;
            _status = status;
        }
        if (!_disposed) StatusChanged?.Invoke(this, status);
    }

    // Under _gate.
    CloudStatus Make()
    {
        var n = _outbox.Pending;
        var failed = _outbox.Failed;
        var waiting = n == 1 ? "1 scanning venter" : $"{n} scanninger venter";
        var refused = failed == 1 ? "1 scanning afvist, se log" : $"{failed} scanninger afvist, se log";
        var text = _state switch
        {
            CloudState.NotSetUp => n > 0 ? $"Ikke sat op · {waiting}" : "Ikke sat op",
            CloudState.Connecting => "Forbinder…",
            CloudState.Online when failed > 0 => $"Forbundet · {refused}",
            CloudState.Online => _account.Length > 0 ? $"Forbundet · {_account}" : "Forbundet",
            CloudState.Offline => n > 0 ? $"Offline · {waiting}" : "Offline",
            _ => n > 0 ? $"Fejl: {_error} · {waiting}" : $"Fejl: {_error}",
        };
        return new CloudStatus(_state, text, n, _lastSync, failed);
    }

    // The start of the scans read: Window back from now.
    public static DateTimeOffset WindowStart(DateTimeOffset now) => now - Window;

    static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;

    // Local midnight of the day now falls on.
    public static DateTimeOffset Midnight(DateTimeOffset now)
    {
        var local = TimeZoneInfo.ConvertTime(now, TimeZoneInfo.Local);
        return new DateTimeOffset(local.Date, TimeZoneInfo.Local.GetUtcOffset(local.Date));
    }

    // The account in the settings, else the user's own. The name is only known for the user's own.
    static async Task<(Guid Id, string Name)> AccountAsync(OptiCloudClient client, StationSettings s, CancellationToken ct)
    {
        CloudUser? user = null;
        try { user = await client.GetCurrentUserAsync(ct); }
        // A user that may not read itself can still write to the account set up for it.
        catch (OptiCloudException x) when (s.AccountId is not null && (x.IsRejected || x.Status == 403)) { }
        var id = s.AccountId ?? user!.AccountId;
        return (id, user is not null && user.AccountId == id ? user.AccountName : "");
    }

    // For the setup screen. Null when it works: logs in, finds the account, reads its machines.
    // Otherwise the Danish reason.
    public static async Task<string?> TestConnectionAsync(StationSettings settings, string password, CancellationToken ct = default, HttpMessageHandler? handler = null)
    {
        if (!SetupRules.IsValidApiUrl(settings.ApiBaseUrl)) return "API-adressen er ikke en webadresse";
        if (string.IsNullOrWhiteSpace(settings.Username) || string.IsNullOrEmpty(password)) return "Skriv brugernavn og adgangskode";
        try
        {
            using var client = new OptiCloudClient(settings.ApiBaseUrl, settings.Username.Trim(), password, handler);
            var (account, _) = await AccountAsync(client, settings, ct);
            await client.GetMachinesAsync(account, ct);
            return null;
        }
        catch (OptiCloudException x) { return x.Message; }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception x) { return $"Uventet fejl: {x.Message}"; }
    }

    // The account's machines, by name. Throws OptiCloudException with the Danish reason.
    public static async Task<IReadOnlyList<(Guid Id, string Name)>> LoadMachinesAsync(StationSettings settings, string password, CancellationToken ct = default, HttpMessageHandler? handler = null)
    {
        if (!SetupRules.IsValidApiUrl(settings.ApiBaseUrl)) throw new OptiCloudException("API-adressen er ikke en webadresse");
        if (string.IsNullOrWhiteSpace(settings.Username) || string.IsNullOrEmpty(password)) throw new OptiCloudException("Skriv brugernavn og adgangskode");
        using var client = new OptiCloudClient(settings.ApiBaseUrl, settings.Username.Trim(), password, handler);
        var (account, _) = await AccountAsync(client, settings, ct);
        var machines = await client.GetMachinesAsync(account, ct);
        return [.. machines.OrderBy(m => m.Name, StringComparer.CurrentCultureIgnoreCase).Select(m => (m.Id, m.Name))];
    }

    public void Dispose()
    {
        Task? run;
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            run = _run;
        }
        _stop.Cancel();
        try { run?.Wait(TimeSpan.FromSeconds(3)); }
        catch (AggregateException) { }
    }
}
