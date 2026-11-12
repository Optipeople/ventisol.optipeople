using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Ventisol.Station;

// Unreadable: the PIN file is there but can't be read, so no PIN can be right.
public enum PinAnswer { Ok, Wrong, Locked, Unreadable }

// The optional PIN in front of the setup screen (and, in kiosk mode, "Åbn log" and "Luk" in the tray).
// Only a salted PBKDF2 hash is kept, in a small file of its own next to the settings; the PIN itself
// is never written or logged. No file means no PIN: everything is open, as before there was one.
// A file that is there but can't be read keeps the setup shut (delete setup-pin.json to open it again).
// After a few wrong tries it makes the next try wait, longer each time; that count is kept on disk
// too, so a restart doesn't hand out fresh tries.
sealed class SetupPin
{
    public const int MinDigits = 4, MaxDigits = 8;

    const int Iterations = 210_000, SaltBytes = 16, HashBytes = 32;
    // Wrong tries in a row before the first wait.
    const int FreeTries = 3;
    static readonly TimeSpan FirstWait = TimeSpan.FromSeconds(30), LongestWait = TimeSpan.FromMinutes(10);

    sealed record Saved(int Iterations, string Salt, string Hash);
    sealed record Tries(int Wrong, DateTimeOffset? LockedUntil);

    readonly string _pinFile, _triesFile;
    readonly Action<string> _log;
    readonly Func<DateTimeOffset> _now;
    Tries _tries;

    public SetupPin(string folder, Action<string> log, Func<DateTimeOffset>? now = null)
    {
        _pinFile = Path.Combine(folder, "setup-pin.json");
        _triesFile = Path.Combine(folder, "setup-pin-tries.json");
        _log = log;
        _now = now ?? (() => DateTimeOffset.Now);
        _tries = LoadTries();
    }

    public static bool IsValid(string? pin) =>
        pin is { Length: >= MinDigits and <= MaxDigits } && pin.All(c => c is >= '0' and <= '9');

    public bool IsSet => File.Exists(_pinFile);

    // How long until the next try is taken. Zero when a try can be made now.
    public TimeSpan LockedFor
    {
        get
        {
            if (_tries.LockedUntil is not { } until) return TimeSpan.Zero;
            var left = until - _now();
            // A clock set back must not lock the setup for longer than the longest wait.
            return left <= TimeSpan.Zero ? TimeSpan.Zero : left > LongestWait ? LongestWait : left;
        }
    }

    // Ok with no PIN set. A try made during a wait is not looked at, and does not count. Nor does a
    // try against a file that can't be read: no PIN is wrong then, the file is.
    public PinAnswer Check(string? pin)
    {
        if (!IsSet) return PinAnswer.Ok;
        if (LockedFor > TimeSpan.Zero) return PinAnswer.Locked;

        if (Matches(pin ?? "") is not { } right) return PinAnswer.Unreadable;
        if (right)
        {
            SetTries(new Tries(0, null));
            return PinAnswer.Ok;
        }

        var wrong = _tries.Wrong + 1;
        DateTimeOffset? until = null;
        if (wrong >= FreeTries)
        {
            var wait = TimeSpan.FromTicks(Math.Min(LongestWait.Ticks, FirstWait.Ticks << Math.Min(wrong - FreeTries, 10)));
            until = _now() + wait;
            _log($"Setup PIN: {wrong} wrong tries in a row, the next one waits {wait.TotalSeconds:0} s");
        }
        SetTries(new Tries(wrong, until));
        return PinAnswer.Wrong;
    }

    // False when the PIN is not 4 to 8 digits, or could not be saved.
    public bool Set(string pin)
    {
        if (!IsValid(pin)) return false;
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var saved = new Saved(Iterations, Convert.ToBase64String(salt), Convert.ToBase64String(Hash(pin, salt, Iterations, HashBytes)));
        if (!AtomicFile.TryWrite(_pinFile, JsonSerializer.Serialize(saved), _log)) return false;
        SetTries(new Tries(0, null));
        _log("Setup PIN set");
        return true;
    }

    public bool Clear()
    {
        try
        {
            if (File.Exists(_pinFile)) File.Delete(_pinFile);
            SetTries(new Tries(0, null));
            _log("Setup PIN removed");
            return true;
        }
        catch (Exception e)
        {
            _log($"Setup PIN not removed: {e.Message}");
            return false;
        }
    }

    // Null when the PIN file can't be read.
    bool? Matches(string pin)
    {
        try
        {
            var saved = JsonSerializer.Deserialize<Saved>(File.ReadAllText(_pinFile));
            if (saved is not { Iterations: > 0 and <= 10_000_000, Salt: not null, Hash: not null }) throw new InvalidDataException("not a PIN file");
            var hash = Convert.FromBase64String(saved.Hash);
            return CryptographicOperations.FixedTimeEquals(Hash(pin, Convert.FromBase64String(saved.Salt), saved.Iterations, hash.Length), hash);
        }
        catch (Exception e)
        {
            _log($"Setup PIN file could not be read, the setup stays shut: {e.Message}");
            return null;
        }
    }

    static byte[] Hash(string pin, byte[] salt, int iterations, int length) =>
        Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(pin), salt, iterations, HashAlgorithmName.SHA256, length);

    Tries LoadTries()
    {
        try
        {
            if (AtomicFile.TryRead(_triesFile, _log) is { } text && JsonSerializer.Deserialize<Tries>(text) is { Wrong: >= 0 } t) return t;
        }
        catch (Exception e) { _log($"Setup PIN tries could not be read: {e.Message}"); }
        return new Tries(0, null);
    }

    // In memory first: a disk that can't be written still counts the tries until the app restarts.
    void SetTries(Tries tries)
    {
        _tries = tries;
        try
        {
            if (tries.Wrong > 0) AtomicFile.Write(_triesFile, JsonSerializer.Serialize(tries));
            else if (File.Exists(_triesFile)) File.Delete(_triesFile);
        }
        catch (Exception e) { _log($"Setup PIN tries not saved: {e.Message}"); }
    }
}
