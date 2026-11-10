using System.IO.Ports;
using System.Management;
using System.Text;
using Ventisol.Station.Core;

namespace Ventisol.Station.Scanning;

// Reads the real scanners: every cradle in CDC mode is a COM port, read in the background
// whatever window has focus. Scans and plug events come on worker threads.
// Plugging in or out is seen from Windows device events, with a poll every 2 s in case one is missed.
public sealed class ComPortScanSource(Action<string>? log = null) : IScanSource
{
    static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(2);
    // A new COM port shows up a moment after the device event.
    static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(500);
    // How long a barcode with no line end may pause before it counts as whole.
    static readonly TimeSpan LineIdle = TimeSpan.FromMilliseconds(100);

    readonly Dictionary<string, OpenPort> _open = [];
    readonly Dictionary<string, string> _lastError = [];
    readonly SemaphoreSlim _wake = new(0);
    readonly CancellationTokenSource _cts = new();
    ManagementEventWatcher? _watcher;
    bool _started, _disposed;

    public event EventHandler<RawScan>? Scanned;
    public event EventHandler<(string ScannerId, bool Connected)>? ConnectionChanged;

    public IReadOnlyCollection<string> Connected
    {
        get { lock (_open) return [.. _open.Keys]; }
    }

    // The COM port a connected scanner is on right now, for the setup screen. Null if not open.
    public string? PortOf(string scannerId)
    {
        lock (_open) return _open.TryGetValue(scannerId, out var p) ? p.PortName : null;
    }

    public void Start()
    {
        if (_started || _disposed) return;
        _started = true;

        try
        {
            _watcher = new ManagementEventWatcher(new WqlEventQuery("SELECT * FROM Win32_DeviceChangeEvent"));
            _watcher.EventArrived += (_, _) => Wake();
            _watcher.Start();
        }
        catch (Exception e)
        {
            Log($"No device events, polling only: {e.Message}");
            _watcher?.Dispose();
            _watcher = null;
        }

        _ = Task.Run(() => RunAsync(_cts.Token));
    }

    void Wake()
    {
        try { if (!_disposed) _wake.Release(); }
        catch (ObjectDisposedException) { }
    }

    async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { Rescan(); }
            catch (Exception e) { Log($"Finding scanners failed: {e.Message}"); }

            try
            {
                if (await _wake.WaitAsync(PollInterval, ct))
                {
                    await Task.Delay(Settle, ct);
                    while (_wake.CurrentCount > 0) _wake.Wait(0);
                }
            }
            catch (OperationCanceledException) { return; }
        }
    }

    void Rescan()
    {
        var found = new Dictionary<string, Cradle>();
        foreach (var c in CradleFinder.Find(Log))
            if (!found.TryAdd(c.Id, c)) Log($"{c.PortName} has the same id as {found[c.Id].PortName} ({c.Id}); ignored.");

        // Gone, or moved to another COM port.
        List<OpenPort> stale;
        lock (_open)
            stale = [.. _open.Values.Where(p => !found.TryGetValue(p.Id, out var c) || c.PortName != p.PortName)];
        foreach (var p in stale) Drop(p);

        foreach (var c in found.Values)
        {
            if (_disposed) return;
            bool isOpen;
            lock (_open) isOpen = _open.ContainsKey(c.Id);
            if (!isOpen) TryOpen(c);
        }
    }

    void TryOpen(Cradle c)
    {
        var serial = new SerialPort(c.PortName, 9600)
        {
            // Many CDC devices hold their data back until the host raises DTR.
            DtrEnable = true,
            RtsEnable = true,
        };
        try
        {
            serial.Open();
        }
        catch (Exception e)
        {
            serial.Dispose();
            // Retried every poll; say it once, not every 2 s.
            if (!_lastError.TryGetValue(c.PortName, out var last) || last != e.Message)
                Log($"Cannot open {c.PortName} ({c.Id}): {e.Message}");
            _lastError[c.PortName] = e.Message;
            return;
        }
        _lastError.Remove(c.PortName);

        var port = new OpenPort(c.Id, c.PortName, serial);
        lock (_open)
        {
            if (_disposed) { port.Close(); return; }
            _open[c.Id] = port;
        }
        Log($"Scanner {c.Id} on {c.PortName}.");
        Raise(ConnectionChanged, (c.Id, true));
        _ = Task.Run(() => ReadAsync(port));
    }

    async Task ReadAsync(OpenPort port)
    {
        var buffer = new byte[256];
        try
        {
            while (true)
            {
                var read = port.Serial.BaseStream.ReadAsync(buffer).AsTask();
                // A cradle set up with no suffix sends the barcode and nothing after it: once the
                // data pauses, what came is the scan. The same read is then awaited on.
                if (port.Framer.HasPending && await Task.WhenAny(read, Task.Delay(LineIdle)) != read
                    && port.Framer.Flush() is { } rest)
                    Raise(Scanned, new RawScan(port.Id, rest, DateTimeOffset.Now));
                var n = await read;
                if (n == 0) break;
                // Barcodes are ASCII; Latin1 maps each byte to one char, so no byte is ever split.
                foreach (var line in port.Framer.Push(Encoding.Latin1.GetString(buffer, 0, n)))
                    Raise(Scanned, new RawScan(port.Id, line, DateTimeOffset.Now));
            }
        }
        catch (Exception e) when (!_disposed && !port.Closed)
        {
            Log($"{port.PortName} ({port.Id}) stopped: {e.Message}");
        }
        catch { }
        // The next poll opens it again if the cradle is still there.
        Drop(port);
    }

    void Drop(OpenPort port)
    {
        bool was;
        lock (_open)
        {
            was = _open.TryGetValue(port.Id, out var current) && current == port;
            if (was) _open.Remove(port.Id);
        }
        port.Close();
        if (was && !_disposed) Raise(ConnectionChanged, (port.Id, false));
    }

    void Raise<T>(EventHandler<T>? handler, T args)
    {
        if (handler is null) return;
        // One bad subscriber must not stop the others or kill a reader.
        foreach (var h in handler.GetInvocationList().Cast<EventHandler<T>>())
        {
            try { h(this, args); }
            catch (Exception e) { Log($"Event handler failed: {e.Message}"); }
        }
    }

    void Log(string message)
    {
        try { log?.Invoke(message); }
        catch { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _cts.Cancel();
        try { _watcher?.Stop(); } catch { }
        _watcher?.Dispose();

        OpenPort[] ports;
        lock (_open)
        {
            ports = [.. _open.Values];
            _open.Clear();
        }
        foreach (var p in ports) p.Close();
    }

    sealed class OpenPort(string id, string portName, SerialPort serial)
    {
        public string Id { get; } = id;
        public string PortName { get; } = portName;
        public SerialPort Serial { get; } = serial;
        public LineFramer Framer { get; } = new();
        public bool Closed { get; private set; }

        public void Close()
        {
            Closed = true;
            try { Serial.Dispose(); } catch { }
        }
    }
}
