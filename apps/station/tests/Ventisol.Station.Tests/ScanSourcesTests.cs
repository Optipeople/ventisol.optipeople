using Ventisol.Station.Core;

namespace Ventisol.Station.Tests;

public class ScanSourcesTests
{
    sealed class FakeSource(params string[] connected) : IScanSource
    {
        public event EventHandler<RawScan>? Scanned;
        public event EventHandler<(string ScannerId, bool Connected)>? ConnectionChanged;
        public IReadOnlyCollection<string> Connected { get; } = connected;
        public bool Started, Disposed, FailOnStart;

        public void Start()
        {
            if (FailOnStart) throw new InvalidOperationException("no");
            Started = true;
        }

        public void Dispose() => Disposed = true;
        public void Scan(string id, string raw) => Scanned?.Invoke(this, new RawScan(id, raw, DateTimeOffset.Now));
        public void Plug(string id, bool connected) => ConnectionChanged?.Invoke(this, (id, connected));
    }

    [Fact]
    public void Passes_on_scans_and_plug_events_from_every_source()
    {
        var a = new FakeSource();
        var b = new FakeSource();
        using var all = new ScanSources(a, b);
        var scans = new List<RawScan>();
        var plugs = new List<(string, bool)>();
        all.Scanned += (sender, s) => { Assert.Same(all, sender); scans.Add(s); };
        all.ConnectionChanged += (_, c) => plugs.Add(c);

        a.Scan("S1", "058556050103");
        b.Scan("keyboard", "058557010101");
        b.Plug("keyboard", true);

        Assert.Equal(["S1", "keyboard"], scans.Select(s => s.ScannerId));
        Assert.Equal([("keyboard", true)], plugs);
    }

    [Fact]
    public void Connected_is_every_source_together()
    {
        using var all = new ScanSources(new FakeSource("S1", "S2"), new FakeSource("keyboard"));
        Assert.Equal(["S1", "S2", "keyboard"], all.Connected);
    }

    [Fact]
    public void One_source_failing_to_start_does_not_stop_the_others()
    {
        var bad = new FakeSource { FailOnStart = true };
        var good = new FakeSource();
        var errors = 0;
        var all = new ScanSources(bad, good) { OnError = (_, _) => errors++ };

        all.Start();
        all.Dispose();

        Assert.True(good.Started);
        Assert.Equal(1, errors);
        Assert.True(bad.Disposed && good.Disposed);
    }
}
