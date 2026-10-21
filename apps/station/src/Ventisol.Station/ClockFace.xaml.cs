using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;

namespace Ventisol.Station;

// Moves like a Swiss railway clock: the seconds hand sweeps round in 58.5 seconds, waits at 12,
// and the minute hand jumps when the minute is full. Redrawn with the screen while it is shown.
public partial class ClockFace : UserControl
{
    const double Sweep = 58.5;

    public ClockFace()
    {
        InitializeComponent();
        DrawMarks();
        Loaded += (_, _) => { CompositionTarget.Rendering += OnFrame; OnFrame(null, EventArgs.Empty); };
        Unloaded += (_, _) => CompositionTarget.Rendering -= OnFrame;
    }

    // 60 marks, every fifth a thick hour bar. They go under the hands.
    void DrawMarks()
    {
        var ink = new SolidColorBrush(Color.FromRgb(0x07, 0x18, 0x18));
        ink.Freeze();
        for (var i = 0; i < 60; i++)
        {
            var hour = i % 5 == 0;
            var (width, length) = hour ? (12.0, 27.0) : (3.6, 10.0);
            var mark = new Rectangle
            {
                Width = width, Height = length, Fill = ink,
                RenderTransform = new RotateTransform(i * 6, width / 2, 100 - 4),
            };
            Canvas.SetLeft(mark, 100 - width / 2);
            Canvas.SetTop(mark, 4);
            Face.Children.Insert(0, mark);
        }
    }

    void OnFrame(object? sender, EventArgs e)
    {
        var now = DateTime.Now;
        var seconds = now.Second + now.Millisecond / 1000.0;
        SecondAngle.Angle = seconds < Sweep ? seconds / Sweep * 360 : 0;
        MinuteAngle.Angle = now.Minute * 6;
        HourAngle.Angle = (now.Hour % 12 + now.Minute / 60.0) * 30;
    }
}
