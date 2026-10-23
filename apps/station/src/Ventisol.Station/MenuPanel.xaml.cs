using System.Windows;
using System.Windows.Controls;

namespace Ventisol.Station;

public partial class MenuPanel : UserControl
{
    public MenuPanel() => InitializeComponent();

    public event EventHandler? CloseRequested;
    public event EventHandler? ArrangeRequested;
    public event EventHandler? SetupRequested;

    void OnClose(object sender, RoutedEventArgs e) => CloseRequested?.Invoke(this, EventArgs.Empty);

    void OnArrange(object sender, RoutedEventArgs e) => ArrangeRequested?.Invoke(this, EventArgs.Empty);

    void OnSetup(object sender, RoutedEventArgs e) => SetupRequested?.Invoke(this, EventArgs.Empty);
}
