using System.Windows;
using System.Windows.Controls;

namespace Ventisol.Station;

// The document widget (see DocumentWidgetView.xaml). Picks what to show by the block's size, as a
// block can be anything from 2 x 2 cells to most of the screen.
public partial class DocumentWidgetView : UserControl
{
    public DocumentWidgetView()
    {
        InitializeComponent();
        SizeChanged += (_, _) => Fit();
    }

    void Fit()
    {
        double w = ActualWidth, h = ActualHeight;
        // Wide enough that a column of facts leaves the drawing room: facts beside it.
        var wide = w >= 560 && w >= h * 1.25;
        // Tall enough that a row of facts leaves the drawing room: facts under it.
        var tall = !wide && h >= 440;
        // A small block keeps the station and the element, and gives the rest to the drawing.
        var small = h < 300 || w < 320;

        SideColumn.Width = wide ? new GridLength(w >= 900 ? 0.6 : 0.8, GridUnitType.Star) : new GridLength(0);
        Side.Visibility = wide ? Visibility.Visible : Visibility.Collapsed;
        Strip.Visibility = tall ? Visibility.Visible : Visibility.Collapsed;
        StatusLine.Visibility = small ? Visibility.Collapsed : Visibility.Visible;
        MessageDetail.Visibility = small ? Visibility.Collapsed : Visibility.Visible;
        OrderText.FontSize = small ? 26 : w >= 700 ? 40 : 32;
        ElementText.FontSize = small ? 15 : 18;
    }
}
