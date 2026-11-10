using System.Windows;
using System.Windows.Controls;
using Ventisol.Station.ViewModels;

namespace Ventisol.Station;

// Put it in the window's root grid over the pages, spanning every row. Attach once, then Open with a
// station; the host closes it (close button, Esc, idle), keeping the decisions in one place.
public partial class DocumentOverlay : UserControl
{
    public DocumentOverlay() => InitializeComponent();

    public event EventHandler? CloseRequested;

    public OrderDocumentViewModel? ViewModel { get; private set; }

    // The station whose document is shown, while open.
    public int? Station { get; private set; }

    public bool IsOpen => Station is not null;

    public void Attach(OrderDocumentViewModel vm, IEnumerable<StationViewModel> stations)
    {
        ViewModel = vm;
        View.DataContext = vm;
        Scans.ItemsSource = stations;
    }

    public void Open(int station)
    {
        var wasOpen = IsOpen;
        Station = station;
        Visibility = Visibility.Visible;
        if (!wasOpen) Motion.Enter(View, fromY: 24);
    }

    public void Close()
    {
        if (!IsOpen) return;
        Station = null;
        ViewModel?.Close();
        Visibility = Visibility.Collapsed;
    }

    void OnClose(object sender, RoutedEventArgs e) => CloseRequested?.Invoke(this, EventArgs.Empty);
}
