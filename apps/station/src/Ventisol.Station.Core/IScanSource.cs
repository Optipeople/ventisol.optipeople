namespace Ventisol.Station.Core;

// A scan as it came off a scanner. ScannerId is the USB port of the cradle (see UsbPort), or for the
// demo scanner its station number as text. Raw is exactly what the scanner sent, without the line end.
public sealed record RawScan(string ScannerId, string Raw, DateTimeOffset At);

// Where scans come from: the real cradles on COM ports, or the demo scanner.
// Events may be raised on any thread; the receiver moves them to the UI thread.
public interface IScanSource : IDisposable
{
    event EventHandler<RawScan>? Scanned;

    // A cradle plugged in or out, by ScannerId.
    event EventHandler<(string ScannerId, bool Connected)>? ConnectionChanged;

    // The scanners present right now.
    IReadOnlyCollection<string> Connected { get; }

    void Start();
}
