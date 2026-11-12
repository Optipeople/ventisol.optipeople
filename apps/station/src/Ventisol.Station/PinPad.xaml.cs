using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace Ventisol.Station;

// The overlay that asks for the setup PIN. Put it late in the window's root grid, spanning every row,
// and call Ask: when the PIN is right it closes and runs what was asked for. After a few wrong tries
// SetupPin makes the next one wait; the keys are off and the wait counts down until then.
public partial class PinPad : UserControl
{
    readonly DispatcherTimer _wait = new() { Interval = TimeSpan.FromMilliseconds(500) };
    SetupPin? _pin;
    Action? _granted;
    string _typed = "";

    public PinPad()
    {
        InitializeComponent();
        _wait.Tick += Ui.SafeTick(ShowWait);
    }

    public bool IsOpen => _pin is not null;

    // Raised when it closes, right PIN or not, so the window can take the keyboard back.
    public event EventHandler? Closed;

    internal void Ask(string title, SetupPin pin, Action granted)
    {
        _pin = pin;
        _granted = granted;
        _typed = "";
        Kicker.Text = title.ToUpperInvariant();
        Message.Text = "";
        ShowTyped();
        ShowWait();
        Visibility = Visibility.Visible;
        Motion.FadeIn(this, Motion.Normal);
        Motion.Enter(Card, fromY: 16);
    }

    public void Type(char digit)
    {
        if (!IsOpen || !Keys.IsEnabled || digit is < '0' or > '9' || _typed.Length >= SetupPin.MaxDigits) return;
        _typed += digit;
        Message.Text = "";
        ShowTyped();
    }

    public void Back()
    {
        if (!IsOpen || _typed.Length == 0) return;
        _typed = _typed[..^1];
        ShowTyped();
    }

    public void Submit()
    {
        if (_pin is not { } pin || !Keys.IsEnabled || _typed.Length == 0) return;
        var answer = pin.Check(_typed);
        _typed = "";
        ShowTyped();
        if (answer == PinAnswer.Ok)
        {
            var granted = _granted;
            Close();
            granted?.Invoke();
            return;
        }
        Message.Text = answer == PinAnswer.Unreadable ? "PIN-filen kan ikke læses" : "Forkert PIN";
        ShowWait();
    }

    public void Cancel()
    {
        if (IsOpen) Close();
    }

    void Close()
    {
        _wait.Stop();
        _pin = null;
        _granted = null;
        _typed = "";
        Visibility = Visibility.Collapsed;
        Closed?.Invoke(this, EventArgs.Empty);
    }

    void ShowTyped() => Dots.Text = string.Join(" ", Enumerable.Repeat("●", _typed.Length));

    // During a wait the keys are off and the line counts down; after it, back to normal.
    void ShowWait()
    {
        var left = _pin?.LockedFor ?? TimeSpan.Zero;
        if (left > TimeSpan.Zero)
        {
            Keys.IsEnabled = false;
            var seconds = (int)Math.Ceiling(left.TotalSeconds);
            Message.Text = seconds >= 120 ? $"For mange forkerte forsøg. Vent {(seconds + 59) / 60} min." : $"For mange forkerte forsøg. Vent {seconds} sek.";
            _wait.Start();
            return;
        }
        if (!Keys.IsEnabled)
        {
            Keys.IsEnabled = true;
            Message.Text = "";
        }
        _wait.Stop();
    }

    void OnDigit(object sender, RoutedEventArgs e)
    {
        if (sender is Button { Content: string { Length: 1 } digit }) Type(digit[0]);
    }

    void OnBack(object sender, RoutedEventArgs e) => Back();

    void OnOk(object sender, RoutedEventArgs e) => Submit();

    void OnCancel(object sender, RoutedEventArgs e) => Cancel();
}
