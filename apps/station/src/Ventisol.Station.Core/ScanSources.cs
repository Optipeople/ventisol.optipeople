namespace Ventisol.Station.Core;

// Several scan sources as one, e.g. the COM port cradles and a scanner in keyboard mode.
// A source that fails to start or dispose does not stop the others.
public sealed class ScanSources : IScanSource
{
    readonly IScanSource[] _sources;

    public ScanSources(params IScanSource[] sources)
    {
        _sources = sources;
        foreach (var s in sources)
        {
            s.Scanned += OnScanned;
            s.ConnectionChanged += OnConnectionChanged;
        }
    }

    public event EventHandler<RawScan>? Scanned;
    public event EventHandler<(string ScannerId, bool Connected)>? ConnectionChanged;

    public IReadOnlyList<IScanSource> Sources => _sources;

    public IReadOnlyCollection<string> Connected => [.. _sources.SelectMany(s => s.Connected).Distinct()];

    public Action<IScanSource, Exception>? OnError { get; set; }

    public void Start()
    {
        foreach (var s in _sources)
        {
            try { s.Start(); }
            catch (Exception e) { OnError?.Invoke(s, e); }
        }
    }

    public void Dispose()
    {
        foreach (var s in _sources)
        {
            s.Scanned -= OnScanned;
            s.ConnectionChanged -= OnConnectionChanged;
            try { s.Dispose(); }
            catch (Exception e) { OnError?.Invoke(s, e); }
        }
    }

    void OnScanned(object? sender, RawScan scan) => Scanned?.Invoke(this, scan);

    void OnConnectionChanged(object? sender, (string ScannerId, bool Connected) change) => ConnectionChanged?.Invoke(this, change);
}
