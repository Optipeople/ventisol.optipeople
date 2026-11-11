namespace Ventisol.Station.Core;

// A scanner sometimes reads one label twice in a fraction of a second (seen: 0.3 s apart). Without
// this the second read would scan the element straight out again. The same element at the same
// station within the window is a repeat; each repeat restarts the window, so a burst is one scan.
public sealed class RepeatScans(TimeSpan window)
{
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromSeconds(2);

    readonly Dictionary<int, (string Code, DateTimeOffset At)> _last = [];

    public RepeatScans() : this(DefaultWindow) { }

    public bool IsRepeat(int station, Barcode barcode, DateTimeOffset at)
    {
        var repeat = _last.TryGetValue(station, out var last) && last.Code == barcode.Raw && at - last.At < window;
        _last[station] = (barcode.Raw, at);
        return repeat;
    }
}
