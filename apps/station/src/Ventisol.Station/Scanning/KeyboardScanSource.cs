using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;
using Ventisol.Station.Core;

namespace Ventisol.Station.Scanning;

// A scanner in keyboard mode, as a cradle ships: one scanner, known as "keyboard".
// The window hands it every key from PreviewKeyDown. Letters and digits are held for a moment;
// a fast burst of 6 or more is a scan, with or without Enter; anything else comes back through Typed.
// Create it on the UI thread; its events come on the UI thread.
public sealed class KeyboardScanSource : IScanSource
{
    public const string Id = "keyboard";

    readonly KeyBurst _burst = new();
    readonly DispatcherTimer _timer;
    bool _seen;

    public KeyboardScanSource()
    {
        _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(25) };
        _timer.Tick += (_, _) =>
        {
            var released = _burst.Expire(DateTimeOffset.Now, out var scan);
            Release(released);
            if (scan is not null) Found(scan);
        };
    }

    public event EventHandler<RawScan>? Scanned;
    public event EventHandler<(string ScannerId, bool Connected)>? ConnectionChanged;

    // A held key that was a person typing, about 50 ms late. For the window's own shortcuts.
    public event EventHandler<char>? Typed;

    // Only known once the first scan has come; a keyboard alone is not a scanner.
    public IReadOnlyCollection<string> Connected => _seen ? [Id] : [];

    public bool IsCapturing => _burst.IsCapturing;

    public void Start() { }

    // True when the key is taken: the window then sets e.Handled and stops.
    public bool OnKeyDown(KeyEventArgs e)
    {
        // Typing into a text box is left alone; there a scan simply types itself.
        if (e.OriginalSource is TextBoxBase or PasswordBox) return false;
        // Now, not e.Timestamp: the first key after a quiet spell carries a stale timestamp (hundreds
        // of ms old, seen in the e2e run), so the gap to the second key looked like a person and the
        // first digit of every scan was dropped. Now is also the clock the expiry timer uses.
        var at = DateTimeOffset.Now;
        if (e.Key == Key.Enter) return OnEnter(at);
        return CharOf(e.Key, Keyboard.Modifiers) is { } c && OnKey(c, at);
    }

    public bool OnKey(char c, DateTimeOffset at)
    {
        var released = _burst.Key(c, at, out var scan);
        Release(released);
        if (scan is not null) Found(scan);
        _timer.Start();
        return true;
    }

    public bool OnEnter(DateTimeOffset at)
    {
        var scan = _burst.Enter(at, out var released);
        _timer.Stop();
        Release(released);
        if (scan is null) return false;
        Found(scan);
        return true;
    }

    void Found(string scan)
    {
        if (!_seen)
        {
            _seen = true;
            Raise(() => ConnectionChanged?.Invoke(this, (Id, true)));
        }
        Raise(() => Scanned?.Invoke(this, new RawScan(Id, scan, DateTimeOffset.Now)));
    }

    void Release(string keys)
    {
        if (!_burst.IsCapturing) _timer.Stop();
        foreach (var c in keys) Raise(() => Typed?.Invoke(this, c));
    }

    // Plain letters and digits only. Shift+digit and Ctrl or Alt keys stay the window's.
    static char? CharOf(Key key, ModifierKeys mods)
    {
        if ((mods & (ModifierKeys.Control | ModifierKeys.Alt)) != 0) return null;
        var shift = mods.HasFlag(ModifierKeys.Shift);
        return key switch
        {
            >= Key.D0 and <= Key.D9 when !shift => (char)('0' + (key - Key.D0)),
            >= Key.NumPad0 and <= Key.NumPad9 => (char)('0' + (key - Key.NumPad0)),
            >= Key.A and <= Key.Z => (char)((shift ? 'A' : 'a') + (key - Key.A)),
            _ => null,
        };
    }

    // A failing handler must not leave a key stuck in the burst.
    static void Raise(Action raise)
    {
        try { raise(); }
        catch { }
    }

    public void Dispose() => _timer.Stop();
}
