using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Threading;
using Ventisol.Station.Core;

namespace Ventisol.Station.Scanning;

// A scanner in keyboard mode, as a cradle ships: one scanner, known as "keyboard".
// The window hands it every key from PreviewKeyDown. Letters and digits are held for a moment;
// a fast burst of 6 or more is a scan, with or without Enter; anything else comes back through Typed.
// With a text field in focus the keys are not held (a person must be able to type there), only
// watched: a burst there is still a scan and counts as one, and what it typed is taken out of the
// field again, so a scan is work at a station also while someone has the setup open.
// Create it on the UI thread; its events come on the UI thread.
public sealed class KeyboardScanSource : IScanSource
{
    public const string Id = "keyboard";

    readonly KeyBurst _burst = new();
    readonly DispatcherTimer _timer;
    bool _seen;

    // The burst being held or watched: how many keys it has, the last key's event timestamp and
    // the time given to it, and the text field it is typing into, if any.
    int _keys;
    int _stamp;
    DateTimeOffset _at;
    Field? _field;

    public KeyboardScanSource()
    {
        _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TimeSpan.FromMilliseconds(25) };
        _timer.Tick += (_, _) =>
        {
            var released = _burst.Expire(DateTimeOffset.Now, out var scan);
            if (_burst.IsCapturing) return;
            _timer.Stop();
            End(released, scan);
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
        // In a text field the key is the field's: it is watched, never taken (but for the Enter that
        // ends a scan, so the scanner's Enter doesn't press the setup's default button).
        var field = e.OriginalSource is TextBoxBase or PasswordBox ? e.OriginalSource : null;
        var enter = e.Key == Key.Enter;
        var c = enter ? null : CharOf(e.Key, Keyboard.Modifiers);
        if (!enter && c is null) return false;

        // A key held down repeats faster than a person types and would pass for a scan. A scanner
        // sends every character as its own key press, so repeats are never part of one.
        if (e.IsRepeat) return !enter && field is null;

        if (enter) return OnEnter(DateTimeOffset.Now);
        Take(c!.Value, TimeOf(e), field);
        return field is null;
    }

    // The key's time, for telling a burst from typing. The first key of a burst gets the clock (the
    // one the expiry timer uses). Every key after it is placed by the gap between the key events'
    // own timestamps, which Windows sets when the key is pressed: a busy moment in the app delays the
    // handling of the keys, not their timestamps, so it no longer splits a barcode in two.
    // The first key after a quiet spell can carry a stale timestamp (hundreds of ms old, seen in the
    // e2e run), which made its gap to the second key look like a person's. So for that one gap the
    // shorter of the two measures counts: by timestamps, or by the clock.
    DateTimeOffset TimeOf(KeyEventArgs e)
    {
        var now = DateTimeOffset.Now;
        var at = now;
        if (_burst.IsCapturing)
        {
            var gap = TimeSpan.FromMilliseconds(Math.Max(0, unchecked(e.Timestamp - _stamp)));
            if (_keys == 1)
            {
                var byClock = now - _at;
                if (byClock < TimeSpan.Zero) byClock = TimeSpan.Zero;
                if (byClock < gap) gap = byClock;
            }
            at = _at + gap;
        }
        (_stamp, _at) = (e.Timestamp, at);
        return at;
    }

    // A key outside any text field, at a time on the caller's clock.
    public bool OnKey(char c, DateTimeOffset at)
    {
        Take(c, at, null);
        return true;
    }

    void Take(char c, DateTimeOffset at, object? field)
    {
        var released = _burst.Key(c, at, out var scan);
        // The keys before this one ended with a pause: this key starts the next burst.
        if (_keys == 0 || released.Length > 0 || scan is not null)
        {
            End(released, scan);
            // Before the key is typed: PreviewKeyDown comes ahead of the field's own handling.
            _field = Field.Of(field);
        }
        _keys++;
        _timer.Start();
    }

    public bool OnEnter(DateTimeOffset at)
    {
        var scan = _burst.Enter(at, out var released);
        _timer.Stop();
        End(released, scan);
        return scan is not null;
    }

    // The burst is over: a scan, or a person's keys. Keys typed into a field are already there, so
    // they are not handed back; a scan typed into a field is taken out of it.
    void End(string released, string? scan)
    {
        var field = _field;
        _field = null;
        _keys = 0;
        if (scan is not null)
        {
            field?.TakeOut(scan);
            Found(scan);
        }
        else if (field is null)
            foreach (var c in released) Raise(() => Typed?.Invoke(this, c));
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

    // A text field as it was just before a burst began typing into it.
    sealed class Field
    {
        readonly object _box;
        readonly string _text = "";
        readonly int _start, _length;

        Field(object box)
        {
            _box = box;
            switch (box)
            {
                case TextBox t: (_text, _start, _length) = (t.Text, t.SelectionStart, t.SelectionLength); break;
                case PasswordBox p: _text = p.Password; break;
            }
        }

        public static Field? Of(object? box)
        {
            if (box is null) return null;
            try { return new Field(box); }
            catch { return null; }
        }

        // Puts the field back as it was, but only if what changed is exactly the scan typed into it,
        // or the start of the scan in a field that then was full (MaxLength): the setup PIN takes 8
        // digits, and the first 8 of a barcode must not be left there as a PIN.
        // Anything else (a field that took some other keys, a person's edit) is left alone.
        public void TakeOut(string scan)
        {
            try
            {
                switch (_box)
                {
                    case TextBox t when Took(t.Text, _text.Remove(_start, _length), _start, scan, t.MaxLength):
                        // Through the binding, so the setup's own value follows.
                        t.SetCurrentValue(TextBox.TextProperty, _text);
                        t.Select(_start, _length);
                        break;
                    // Where in a password the keys went is not known: anywhere counts.
                    case PasswordBox p when Typed(p.Password.Length - _text.Length, scan, p.Password.Length, p.MaxLength) is { } typed
                                            && p.Password.Contains(typed, StringComparison.OrdinalIgnoreCase):
                        p.Password = _text;
                        break;
                }
            }
            catch { }
        }

        // Whether now is rest with the scan, or the start of it that a full field had room for, put in at start.
        static bool Took(string now, string rest, int start, string scan, int maxLength) =>
            Typed(now.Length - rest.Length, scan, now.Length, maxLength) is { } typed
            && string.Equals(now, rest.Insert(start, typed), StringComparison.OrdinalIgnoreCase);

        // The part of the scan a field took, when it grew by count: all of it, or its start when the
        // field is now full. Null when the field took nothing, or less than the scan with room left.
        static string? Typed(int count, string scan, int length, int maxLength) =>
            count == scan.Length ? scan
            : count > 0 && count < scan.Length && maxLength > 0 && length >= maxLength ? scan[..count]
            : null;
    }
}
