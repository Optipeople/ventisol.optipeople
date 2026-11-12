using System.Windows;

namespace Ventisol.Station;

// The small window up while a start waits after failed ones. It only shows what App tells it and
// passes "Start nu" on; the wait itself is App's, and runs without it too.
public partial class StartNotice : Window
{
    public StartNotice()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => Ui.RoundCorners(this);
    }

    public event EventHandler? StartNow;

    // How long is left of the wait.
    public void ShowWait(TimeSpan left)
    {
        var seconds = Math.Max(1, (int)Math.Ceiling(left.TotalSeconds));
        Headline.Text = seconds >= 120 ? $"Starter igen om {(seconds + 59) / 60} min" : $"Starter igen om {seconds} s";
    }

    // The wait is over, but a newer version is on its way in.
    public void ShowUpdating() => Headline.Text = "Henter ny version …";

    void OnStartNow(object sender, RoutedEventArgs e) => StartNow?.Invoke(this, EventArgs.Empty);
}
