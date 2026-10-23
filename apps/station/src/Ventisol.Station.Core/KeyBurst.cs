using System.Text;

namespace Ventisol.Station.Core;

// Tells a scanner in keyboard mode from a person at the keyboard. A scanner types a whole
// barcode in a fast burst and ends it with Enter; a person is slower. Every key is held until
// that is clear: a key with no next key within maxGap was a person, and is released.
public sealed class KeyBurst(TimeSpan maxGap, int minLength = 6)
{
    public static readonly TimeSpan DefaultGap = TimeSpan.FromMilliseconds(50);

    readonly StringBuilder _held = new();
    DateTimeOffset _last;

    public KeyBurst() : this(DefaultGap) { }

    public bool IsCapturing => _held.Length > 0;

    // Holds the key. Returns the keys held before it if they turned out to be a person.
    public string Key(char c, DateTimeOffset at)
    {
        var released = Expire(at);
        _held.Append(c);
        _last = at;
        return released;
    }

    // The scan if the held keys were one fast burst; otherwise null, and they are released.
    public string? Enter(DateTimeOffset at, out string released)
    {
        released = "";
        if (_held.Length >= minLength && at - _last <= maxGap)
        {
            var scan = _held.ToString();
            _held.Clear();
            return scan;
        }
        released = Release();
        return null;
    }

    // For a timer: releases the held keys once no key has come for maxGap.
    public string Expire(DateTimeOffset now) => _held.Length > 0 && now - _last > maxGap ? Release() : "";

    string Release()
    {
        var keys = _held.ToString();
        _held.Clear();
        return keys;
    }
}
