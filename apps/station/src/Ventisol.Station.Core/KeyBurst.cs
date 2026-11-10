using System.Text;

namespace Ventisol.Station.Core;

// Tells a scanner in keyboard mode from a person at the keyboard. A scanner types a whole
// barcode in a fast burst; a person is slower. Every key is held until that is clear: a key with
// no next key within maxGap ends the burst. A burst of at least minLength keys is a scan, whether
// the scanner ends it with Enter or sends no suffix at all (seen on a Zebra cradle in HID mode).
// A shorter one was a person, and its keys are released.
public sealed class KeyBurst(TimeSpan maxGap, int minLength = 6)
{
    public static readonly TimeSpan DefaultGap = TimeSpan.FromMilliseconds(50);

    readonly StringBuilder _held = new();
    DateTimeOffset _last;

    public KeyBurst() : this(DefaultGap) { }

    public bool IsCapturing => _held.Length > 0;

    // Holds the key. If the keys held before it ended with a pause, they come out first: as a scan,
    // or released as a person's keys.
    public string Key(char c, DateTimeOffset at, out string? scan)
    {
        var released = Expire(at, out scan);
        _held.Append(c);
        _last = at;
        return released;
    }

    // The scan if the held keys were a burst long enough; otherwise null, and they are released.
    // Every held key came within maxGap of the one before, so the burst was fast; a late Enter
    // only means the scanner paused before its suffix.
    public string? Enter(DateTimeOffset at, out string released)
    {
        released = "";
        if (_held.Length >= minLength) return Take();
        released = Take();
        return null;
    }

    // For a timer: ends the burst once no key has come for maxGap.
    public string Expire(DateTimeOffset now, out string? scan)
    {
        scan = null;
        if (_held.Length == 0 || now - _last <= maxGap) return "";
        if (_held.Length >= minLength) { scan = Take(); return ""; }
        return Take();
    }

    string Take()
    {
        var keys = _held.ToString();
        _held.Clear();
        return keys;
    }
}
