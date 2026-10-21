using System.Windows.Controls;

namespace Ventisol.Station;

public partial class ReportsView : UserControl
{
    public ReportsView() => InitializeComponent();

    // The two panels rise in one after the other when the page opens.
    public void PlayIn()
    {
        Motion.Enter(OrdersPanel, fromY: 18);
        Motion.Enter(StationsPanel, fromY: 18, delay: TimeSpan.FromMilliseconds(70));
    }
}
