using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Ventisol.Station;

public partial class StatusDot : UserControl
{
    public static readonly DependencyProperty FillProperty = DependencyProperty.Register(
        nameof(Fill), typeof(Brush), typeof(StatusDot), new PropertyMetadata(Brushes.Gray));

    public StatusDot() => InitializeComponent();

    public Brush Fill
    {
        get => (Brush)GetValue(FillProperty);
        set => SetValue(FillProperty, value);
    }
}
